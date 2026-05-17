import { ImportResult, UsageInterval } from "./types";

export interface RawUsageRow {
  [key: string]: unknown;
}

export const TABLE_USAGE = "energy_usage";

export interface UsageNormalizationSql {
  createTableSql: string;
  statsSql: string;
  rowsSql: string;
}

export interface UsageColumnInfo {
  name: string;
  type?: string;
}

const USAGE_COLUMN_CANDIDATES = ["usage_kwh", "usage", "kwh", "value"];
const TIMESTAMP_COLUMN_CANDIDATES = ["timestamp_local", "timestamp"];
const READ_DATE_COLUMN_CANDIDATES = ["read_date_iso", "read_date"];
const READ_TIME_COLUMN_CANDIDATES = ["read_time"];
const READ_TIME_OCCURRENCE_COLUMN_CANDIDATES = ["read_time_occurrence"];
const INTERVAL_INDEX_COLUMN_CANDIDATES = ["interval_index"];

export function sqlIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizeColumnInfo(columns: string[] | UsageColumnInfo[]): UsageColumnInfo[] {
  return columns.map(column => typeof column === "string" ? { name: column } : column);
}

function columnLookup(columns: UsageColumnInfo[]): Map<string, UsageColumnInfo> {
  return new Map(columns.map(column => [column.name.toLowerCase(), column]));
}

function firstColumn(columns: UsageColumnInfo[], candidates: string[]): UsageColumnInfo | null {
  const lookup = columnLookup(columns);
  for (const candidate of candidates) {
    const match = lookup.get(candidate.toLowerCase());
    if (match) return match;
  }
  return null;
}

function textExpr(columns: UsageColumnInfo[], candidates: string[]): string {
  const expressions = candidates
    .map(candidate => firstColumn(columns, [candidate]))
    .filter((column): column is UsageColumnInfo => Boolean(column))
    .map(column => `NULLIF(TRIM(CAST(${sqlIdentifier(column.name)} AS VARCHAR)), '')`);
  return expressions.length ? `COALESCE(${expressions.join(", ")})` : "NULL";
}

function numericExpr(columns: UsageColumnInfo[], candidates: string[]): string {
  const expressions = candidates
    .map(candidate => firstColumn(columns, [candidate]))
    .filter((column): column is UsageColumnInfo => Boolean(column))
    .map(column => `TRY_CAST(${sqlIdentifier(column.name)} AS DOUBLE)`);
  return expressions.length ? `COALESCE(${expressions.join(", ")})` : "NULL";
}

function integerExpr(columns: UsageColumnInfo[], candidates: string[]): string {
  const expressions = candidates
    .map(candidate => firstColumn(columns, [candidate]))
    .filter((column): column is UsageColumnInfo => Boolean(column))
    .map(column => `TRY_CAST(${sqlIdentifier(column.name)} AS INTEGER)`);
  return expressions.length ? `COALESCE(${expressions.join(", ")})` : "NULL";
}

function isTimestampColumn(column: UsageColumnInfo | null): boolean {
  return Boolean(column?.type && /TIMESTAMP|DATE/i.test(column.type));
}

function coalesce(expressions: string[]): string {
  return expressions.length === 1 ? expressions[0] : `COALESCE(${expressions.join(", ")})`;
}

function tryStrptime(expr: string, format: string): string {
  return `try_strptime(${expr}, ${sqlString(format)})`;
}

export function buildUsageNormalizationSql(
  rawTable: string,
  outputTable: string,
  columns: string[] | UsageColumnInfo[],
  sourceName: string
): UsageNormalizationSql {
  const columnInfo = normalizeColumnInfo(columns);
  const sourceLiteral = sqlString(sourceName);
  const usageValue = numericExpr(columnInfo, USAGE_COLUMN_CANDIDATES);
  const timestampColumn = firstColumn(columnInfo, TIMESTAMP_COLUMN_CANDIDATES);
  const timestampColumnValue = timestampColumn ? sqlIdentifier(timestampColumn.name) : "NULL";
  const timestampText = timestampColumn && isTimestampColumn(timestampColumn)
    ? "CAST(NULL AS VARCHAR)"
    : textExpr(columnInfo, TIMESTAMP_COLUMN_CANDIDATES);
  const readDateText = textExpr(columnInfo, READ_DATE_COLUMN_CANDIDATES);
  const readTimeText = textExpr(columnInfo, READ_TIME_COLUMN_CANDIDATES);
  const occurrenceValue = integerExpr(columnInfo, READ_TIME_OCCURRENCE_COLUMN_CANDIDATES);
  const intervalIndexValue = integerExpr(columnInfo, INTERVAL_INDEX_COLUMN_CANDIDATES);
  const qRaw = sqlIdentifier(rawTable);
  const qOutput = sqlIdentifier(outputTable);
  const timestampTextNormalized = "NULLIF(REPLACE(timestamp_text, 'T', ' '), '')";
  const parsedTimestamp = coalesce([
    "TRY_CAST(timestamp_value_raw AS TIMESTAMP)",
    `TRY_CAST(${timestampTextNormalized} AS TIMESTAMP)`,
    tryStrptime(timestampTextNormalized, "%Y-%m-%d %H:%M:%S"),
    tryStrptime(timestampTextNormalized, "%Y-%m-%d %H:%M"),
    tryStrptime(timestampTextNormalized, "%Y-%m-%d %-H:%M:%S"),
    tryStrptime(timestampTextNormalized, "%Y-%m-%d %-H:%M")
  ]);
  const parsedReadDate = coalesce([
    "TRY_CAST(read_date_text AS DATE)",
    `CAST(${tryStrptime("read_date_text", "%m/%d/%Y")} AS DATE)`,
    `CAST(${tryStrptime("read_date_text", "%Y-%m-%d")} AS DATE)`
  ]);
  const parsedReadTime = coalesce([
    tryStrptime("read_time_text", "%H:%M:%S"),
    tryStrptime("read_time_text", "%H:%M"),
    tryStrptime("read_time_text", "%-H:%M:%S"),
    tryStrptime("read_time_text", "%-H:%M"),
    tryStrptime("read_time_text", "%I:%M:%S %p"),
    tryStrptime("read_time_text", "%I:%M %p"),
    tryStrptime("read_time_text", "%-I:%M:%S %p"),
    tryStrptime("read_time_text", "%-I:%M %p")
  ]);

  const createTableSql = `
CREATE OR REPLACE TABLE ${qOutput} AS
WITH raw AS (
  SELECT
    row_number() OVER () AS source_row,
    ${usageValue} AS usage_raw,
    ${timestampColumnValue} AS timestamp_value_raw,
    ${timestampText} AS timestamp_text,
    ${readDateText} AS read_date_text,
    ${readTimeText} AS read_time_text,
    ${occurrenceValue} AS occurrence_value,
    ${intervalIndexValue} AS interval_index_value
  FROM ${qRaw}
),
parsed AS (
  SELECT
    *,
    ${parsedTimestamp} AS parsed_timestamp,
    ${parsedReadDate} AS read_date_value,
    ${parsedReadTime} AS read_time_value
  FROM raw
),
normalized AS (
  SELECT
    source_row,
    usage_raw,
    interval_index_value,
    occurrence_value,
    read_time_text,
    CASE
      WHEN parsed_timestamp IS NOT NULL THEN parsed_timestamp
      WHEN read_date_value IS NULL THEN NULL
      WHEN read_time_value IS NOT NULL THEN
        CAST(read_date_value AS TIMESTAMP)
        + date_part('hour', read_time_value) * INTERVAL 1 HOUR
        + date_part('minute', read_time_value) * INTERVAL 1 MINUTE
        + date_part('second', read_time_value) * INTERVAL 1 SECOND
      ELSE NULL
    END AS timestamp_local,
    read_date_value
  FROM parsed
),
valid AS (
  SELECT
    source_row,
    usage_raw,
    interval_index_value,
    occurrence_value,
    timestamp_local,
    COALESCE(strftime(read_date_value, '%Y-%m-%d'), strftime(timestamp_local, '%Y-%m-%d')) AS read_date,
    COALESCE(read_time_text, strftime(timestamp_local, '%H:%M')) AS read_time
  FROM normalized
  WHERE usage_raw IS NOT NULL AND timestamp_local IS NOT NULL
),
numbered AS (
  SELECT
    *,
    COALESCE(NULLIF(occurrence_value, 0), row_number() OVER (PARTITION BY timestamp_local, read_time ORDER BY source_row)) AS read_time_occurrence
  FROM valid
)
SELECT
  concat(strftime(timestamp_local, '%Y-%m-%dT%H:%M:%S'), '-', CAST(read_time_occurrence AS VARCHAR), '-', CAST(source_row AS VARCHAR)) AS id,
  timestamp_local,
  COALESCE(
    lead(timestamp_local) OVER (ORDER BY timestamp_local, read_time_occurrence, COALESCE(NULLIF(interval_index_value, 0), CAST(source_row AS INTEGER))),
    timestamp_local + INTERVAL 1 HOUR
  ) AS timestamp_end_local,
  COALESCE(NULLIF(interval_index_value, 0), CAST(source_row AS INTEGER)) AS interval_index,
  read_date,
  read_time,
  read_time_occurrence,
  GREATEST(usage_raw, 0) AS usage_kwh,
  ${sourceLiteral} AS source
FROM numbered
ORDER BY timestamp_local, read_time_occurrence, interval_index
`.trim();

  const statsSql = `
SELECT
  COUNT(*) FILTER (WHERE usage_raw < 0) AS negativeRowsClipped,
  COALESCE(SUM(CASE WHEN usage_raw < 0 THEN -usage_raw ELSE 0 END), 0) AS kwhClippedToZero
FROM (
  SELECT ${usageValue} AS usage_raw FROM ${qRaw}
) stats
`.trim();

  const rowsSql = `
SELECT
  id,
  strftime(timestamp_local, '%Y-%m-%dT%H:%M:%S') AS timestampLocal,
  interval_index AS intervalIndex,
  read_date AS readDate,
  read_time AS readTime,
  read_time_occurrence AS readTimeOccurrence,
  usage_kwh AS usageKwh,
  source
FROM ${qOutput}
ORDER BY timestamp_local, read_time_occurrence, interval_index
`.trim();

  return { createTableSql, statsSql, rowsSql };
}

function normalizeTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim().replace(" ", "T");
  const [datePart, timePart] = text.split("T");
  const date = parseDateParts(datePart, "-");
  const time = parseTimeParts(timePart);
  if (!date || !time) return null;
  return `${date}T${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}:${String(time.second).padStart(2, "0")}`;
}

function normalizeReadDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  return text.includes("/") ? parseDateParts(text, "/") : parseDateParts(text.split("T")[0], "-");
}

function parseDateParts(value: string | undefined, separator: "/" | "-"): string | null {
  const parts = value?.split(separator).map(part => part.trim());
  if (!parts || parts.length < 3) return null;
  const [first, second, third] = parts;
  const year = separator === "/" ? Number(third) : Number(first);
  const month = separator === "/" ? Number(first) : Number(second);
  const day = separator === "/" ? Number(second) : Number(third);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseTimeParts(value: string | undefined): { hour: number; minute: number; second: number } | null {
  const parts = value?.split(":").map(part => part.trim());
  if (!parts || parts.length < 2) return null;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  const second = Number(parts[2] ?? "0");
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || !Number.isInteger(second)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  return { hour, minute, second };
}

function parseReadTime(value: unknown): { hour: number; minute: number; second: number } | null {
  const text = String(value || "").trim();
  const tokens = text.split(" ").filter(Boolean);
  const time = parseTimeParts(tokens[0]?.includes(":") ? tokens[0] : `${tokens[0]}:0`);
  if (!time) return null;

  let { hour } = time;
  const { minute, second } = time;
  const meridiem = tokens[1]?.toUpperCase();

  if (meridiem) {
    if (meridiem !== "AM" && meridiem !== "PM") return null;
    if (hour < 1 || hour > 12) return null;
    if (meridiem === "AM" && hour === 12) hour = 0;
    if (meridiem === "PM" && hour !== 12) hour += 12;
  }

  if (hour < 0 || hour > 23) return null;
  return { hour, minute, second };
}

function timestampFromReadFields(readDate: unknown, readTime: unknown): string | null {
  const dateIso = normalizeReadDate(readDate);
  const parsedTime = parseReadTime(readTime);
  if (!dateIso || !parsedTime) return null;
  return `${dateIso}T${String(parsedTime.hour).padStart(2, "0")}:${String(parsedTime.minute).padStart(2, "0")}:${String(parsedTime.second).padStart(2, "0")}`;
}

export function normalizeUsageRows(
  rawRows: RawUsageRow[],
  sourceName = "Imported data",
  sourceKind: ImportResult["sourceKind"] = "csv"
): ImportResult {
  const seenTimes = new Map<string, number>();
  let negativeRowsClipped = 0;
  let kwhClippedToZero = 0;

  const rows = rawRows.flatMap((raw, index): UsageInterval[] => {
    const usageRaw = raw.usage_kwh ?? raw.usage ?? raw.kwh ?? raw.value;
    const usage = Number(usageRaw);
    if (!Number.isFinite(usage)) return [];

    const timestamp =
      normalizeTimestamp(raw.timestamp_local ?? raw.timestamp) ??
      timestampFromReadFields(raw.read_date_iso ?? raw.read_date, raw.read_time);
    if (!timestamp) return [];

    const readDate =
      normalizeReadDate(raw.read_date_iso ?? raw.read_date) ?? timestamp.slice(0, 10);
    const readTime = String(raw.read_time ?? timestamp.slice(11, 16));
    const key = `${timestamp} ${readTime}`;
    const occurrence = Number(raw.read_time_occurrence) || (seenTimes.get(key) ?? 0) + 1;
    seenTimes.set(key, occurrence);

    const clippedUsage = Math.max(usage, 0);
    if (usage < 0) {
      negativeRowsClipped += 1;
      kwhClippedToZero += -usage;
    }

    return [
      {
        id: `${timestamp}-${occurrence}-${index}`,
        timestampLocal: timestamp,
        intervalIndex: Number(raw.interval_index) || index + 1,
        readDate,
        readTime,
        readTimeOccurrence: occurrence,
        usageKwh: clippedUsage,
        source: sourceName
      }
    ];
  });

  rows.sort((a, b) => {
    const time = a.timestampLocal.localeCompare(b.timestampLocal);
    return time || a.readTimeOccurrence - b.readTimeOccurrence || a.intervalIndex - b.intervalIndex;
  });

  return {
    rows,
    importedAt: new Date().toISOString(),
    sourceName,
    sourceKind,
    negativeRowsClipped,
    kwhClippedToZero
  };
}

export const SAMPLE_RAW_ROWS: RawUsageRow[] = [
  { timestamp_local: "2026-07-02T17:00:00", usage_kwh: 2.2 },
  { timestamp_local: "2026-07-02T18:00:00", usage_kwh: 1.4 },
  { timestamp_local: "2026-07-02T19:00:00", usage_kwh: 1.1 },
  { timestamp_local: "2026-07-02T20:00:00", usage_kwh: 1.0 },
  { timestamp_local: "2026-07-02T21:00:00", usage_kwh: 0.9 },
  { timestamp_local: "2026-07-02T22:00:00", usage_kwh: 2.6 },
  { timestamp_local: "2026-08-03T18:00:00", usage_kwh: 1.2 },
  { timestamp_local: "2026-08-03T23:00:00", usage_kwh: 4.3 },
  { timestamp_local: "2026-12-15T18:00:00", usage_kwh: 0.8 },
  { timestamp_local: "2026-12-15T23:00:00", usage_kwh: 3.1 }
];

function sampleCsvRow(row: RawUsageRow): string {
  const timestamp = String(row.timestamp_local);
  const [readDate, readTime = ""] = timestamp.split("T");
  return `${timestamp},${readDate},${readTime.slice(0, 5)},${row.usage_kwh}`;
}

export const SAMPLE_CSV = [
  "timestamp_local,read_date,read_time,usage_kwh",
  ...SAMPLE_RAW_ROWS.map(sampleCsvRow)
].join("\n");

export const SAMPLE_ROWS: UsageInterval[] = normalizeUsageRows(
  SAMPLE_RAW_ROWS,
  "Sample data",
  "sample"
).rows;
