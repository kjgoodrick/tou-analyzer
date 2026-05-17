import * as vg from "@uwdata/vgplot";
import {
  buildUsageNormalizationSql,
  normalizeUsageRows,
  sqlIdentifier,
  sqlString,
  TABLE_USAGE,
  UsageColumnInfo
} from "./data";
import { utahSchedule1Holidays } from "./holidays";
import { ImportResult, MonthlyUsageAggregate, StoredUsageFile, UsageInterval, UsageSummary } from "./types";

const RAW_USAGE_TABLE = "energy_usage_import_raw";
const HOLIDAY_TABLE = "utah_schedule_1_holidays";
const IMPORT_FILE_PREFIX = "tou-analyzer-import";
const CANONICAL_FILE_PREFIX = "tou-analyzer-canonical";
const LOAD_OBJECTS_BATCH_SIZE = 250;

let connectorPromise: Promise<ReturnType<typeof vg.wasmConnector>> | null = null;

export { TABLE_USAGE };

export async function connector(): Promise<ReturnType<typeof vg.wasmConnector>> {
  if (!connectorPromise) {
    connectorPromise = Promise.resolve(vg.wasmConnector());
    vg.coordinator().databaseConnector(await connectorPromise);
  }
  return connectorPromise;
}

export async function queryJson<T extends Record<string, unknown>>(sql: string): Promise<T[]> {
  const activeConnector = await connector();
  return activeConnector.query({ type: "json", sql }) as Promise<T[]>;
}

async function duckdb(): Promise<Awaited<ReturnType<ReturnType<typeof vg.wasmConnector>["getDuckDB"]>>> {
  return (await connector()).getDuckDB();
}

export async function execSql(sql: string | string[]): Promise<void> {
  await vg.coordinator().exec(Array.isArray(sql) ? sql : [sql]);
}

export async function loadObjectsTable(
  tableName: string,
  rows: Record<string, unknown>[],
  options: Record<string, unknown> = {}
): Promise<void> {
  await connector();
  if (rows.length <= LOAD_OBJECTS_BATCH_SIZE) {
    await execSql(vg.loadObjects(tableName, rows, { replace: true, ...options }));
    return;
  }

  const [firstChunk, ...rest] = objectBatches(rows);
  await execSql(vg.loadObjects(tableName, firstChunk, { replace: true, ...options }));
  const tempTable = `${tableName}_batch_insert`;
  for (const chunk of rest) {
    await execSql([
      vg.loadObjects(tempTable, chunk, { replace: true, ...options }),
      `INSERT INTO ${sqlIdentifier(tableName)} SELECT * FROM ${sqlIdentifier(tempTable)}`,
      `DROP TABLE IF EXISTS ${sqlIdentifier(tempTable)}`
    ]);
  }
}

function objectBatches(rows: Record<string, unknown>[]): Record<string, unknown>[][] {
  const batches: Record<string, unknown>[][] = [];
  for (let index = 0; index < rows.length; index += LOAD_OBJECTS_BATCH_SIZE) {
    batches.push(rows.slice(index, index + LOAD_OBJECTS_BATCH_SIZE));
  }
  return batches;
}

async function tableColumns(tableName: string): Promise<UsageColumnInfo[]> {
  const rows = await queryJson<{ name: string; type?: string }>(`PRAGMA table_info('${tableName.replaceAll("'", "''")}')`);
  return rows.map(row => ({ name: String(row.name), type: row.type ? String(row.type) : undefined }));
}

async function relationKind(tableName: string): Promise<string | null> {
  const [row] = await queryJson<{ table_type: string }>(`
SELECT table_type
FROM information_schema.tables
WHERE table_schema = 'main' AND table_name = ${sqlString(tableName)}
LIMIT 1
`.trim());
  return row?.table_type ? String(row.table_type).toUpperCase() : null;
}

async function dropRelation(tableName: string): Promise<void> {
  const kind = await relationKind(tableName);
  if (!kind) return;
  if (kind.includes("VIEW")) {
    await execSql(`DROP VIEW IF EXISTS ${sqlIdentifier(tableName)}`);
  } else {
    await execSql(`DROP TABLE IF EXISTS ${sqlIdentifier(tableName)}`);
  }
}

function safeImportFileName(file: StoredUsageFile): string {
  const extension = file.kind === "parquet" ? "parquet" : "csv";
  return `${IMPORT_FILE_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`;
}

function safeCanonicalFileName(sourceName: string): string {
  const base = sourceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "usage";
  return `${CANONICAL_FILE_PREFIX}-${base}-${Date.now()}-${Math.random().toString(36).slice(2)}.parquet`;
}

function importKind(file: File): StoredUsageFile["kind"] {
  return file.name.toLowerCase().endsWith(".parquet") ? "parquet" : "csv";
}

async function storedUsageFileFromFile(file: File): Promise<StoredUsageFile> {
  return {
    name: file.name,
    kind: importKind(file),
    bytes: await file.arrayBuffer(),
    mimeType: file.type || undefined
  };
}

async function registerFile(file: StoredUsageFile): Promise<string> {
  const fileName = safeImportFileName(file);
  const db = await duckdb();
  await db.dropFile(fileName).catch(() => undefined);
  if (file.kind === "parquet") {
    await db.registerFileBuffer(fileName, new Uint8Array(file.bytes.slice(0)));
  } else {
    await db.registerFileText(fileName, new TextDecoder().decode(file.bytes));
  }
  return fileName;
}

async function loadRawFileTable(file: StoredUsageFile): Promise<string> {
  const fileName = await registerFile(file);
  const load = file.kind === "parquet"
    ? vg.loadParquet(RAW_USAGE_TABLE, fileName, { replace: true, select: ["*"] })
    : vg.loadCSV(RAW_USAGE_TABLE, fileName, { replace: true, select: ["*"] });
  await execSql(load);
  return fileName;
}

async function createNormalizedUsageTableFromFile(file: StoredUsageFile): Promise<{
  statsSql: string;
  rowsSql: string;
  registeredFileName: string;
}> {
  const registeredFileName = await loadRawFileTable(file);
  const columns = await tableColumns(RAW_USAGE_TABLE);
  const { createTableSql, statsSql, rowsSql } = buildUsageNormalizationSql(
    RAW_USAGE_TABLE,
    TABLE_USAGE,
    columns,
    file.name
  );
  await execSql(createTableSql);
  return { statsSql, rowsSql, registeredFileName };
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function registerHolidayTableForUsage(): Promise<void> {
  const [bounds] = await queryJson<{ startYear: number; endYear: number }>(`
SELECT
  min(year(timestamp_local)) AS startYear,
  max(year(timestamp_local)) AS endYear
FROM ${sqlIdentifier(TABLE_USAGE)}
`.trim());
  const startYear = Number(bounds?.startYear);
  const endYear = Number(bounds?.endYear);
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear)) {
    await loadObjectsTable(HOLIDAY_TABLE, [{ date_key: "0000-00-00" }], { replace: true });
    return;
  }

  const holidays = new Set<string>();
  for (let year = startYear; year <= endYear; year += 1) {
    for (const day of utahSchedule1Holidays(year)) holidays.add(day);
  }
  const rows = [...holidays].sort().map(date_key => ({ date_key }));
  await loadObjectsTable(HOLIDAY_TABLE, rows.length ? rows : [{ date_key: "0000-00-00" }], { replace: true });
}

async function usageMetricsFromTable(): Promise<{
  monthlyUsage: MonthlyUsageAggregate[];
  usageSummary: UsageSummary;
}> {
  await registerHolidayTableForUsage();
  const monthlyUsageRows = await queryJson<Record<string, unknown>>(`
WITH usage AS (
  SELECT
    timestamp_local,
    usage_kwh,
    strftime(timestamp_local, '%Y-%m') AS month,
    strftime(timestamp_local, '%Y-%m-%d') AS date_key,
    CAST(strftime(timestamp_local, '%w') AS INTEGER) AS weekday,
    hour(timestamp_local) + minute(timestamp_local) / 60.0 AS decimal_hour
  FROM ${sqlIdentifier(TABLE_USAGE)}
),
classified AS (
  SELECT
    usage.*,
    decimal_hour >= 18
      AND decimal_hour < 22
      AND weekday BETWEEN 1 AND 5
      AND holidays.date_key IS NULL AS is_on_peak
  FROM usage
  LEFT JOIN ${sqlIdentifier(HOLIDAY_TABLE)} holidays USING (date_key)
)
SELECT
  month,
  COUNT(DISTINCT date_key) AS "daysWithData",
  GREATEST(
    0,
    day(last_day(CAST(month || '-01' AS DATE))) - COUNT(DISTINCT date_key)
  ) AS "missingDays",
  CAST(ROUND(SUM(usage_kwh), 6) AS DOUBLE) AS "totalKwh",
  CAST(ROUND(SUM(CASE WHEN is_on_peak THEN usage_kwh ELSE 0 END), 6) AS DOUBLE) AS "onPeakKwh",
  CAST(ROUND(SUM(CASE WHEN is_on_peak THEN 0 ELSE usage_kwh END), 6) AS DOUBLE) AS "offPeakKwh"
FROM classified
GROUP BY month
ORDER BY month
`.trim());
  const [summary] = await queryJson<Record<string, unknown>>(`
WITH usage AS (
  SELECT
    timestamp_local,
    usage_kwh,
    strftime(timestamp_local, '%Y-%m-%d') AS date_key,
    CAST(strftime(timestamp_local, '%w') AS INTEGER) AS weekday,
    hour(timestamp_local) + minute(timestamp_local) / 60.0 AS decimal_hour
  FROM ${sqlIdentifier(TABLE_USAGE)}
),
classified AS (
  SELECT
    usage.*,
    decimal_hour >= 18
      AND decimal_hour < 22
      AND weekday BETWEEN 1 AND 5
      AND holidays.date_key IS NULL AS is_on_peak
  FROM usage
  LEFT JOIN ${sqlIdentifier(HOLIDAY_TABLE)} holidays USING (date_key)
)
SELECT
  strftime(min(timestamp_local), '%Y-%m-%dT%H:%M:%S') AS "loadedStart",
  strftime(max(timestamp_local), '%Y-%m-%dT%H:%M:%S') AS "loadedEnd",
  COUNT(*) AS "intervalCount",
  CAST(ROUND(SUM(usage_kwh), 6) AS DOUBLE) AS "totalKwh",
  CAST(ROUND(SUM(CASE WHEN is_on_peak THEN usage_kwh ELSE 0 END), 6) AS DOUBLE) AS "onPeakKwh",
  CAST(ROUND(SUM(CASE WHEN is_on_peak THEN 0 ELSE usage_kwh END), 6) AS DOUBLE) AS "offPeakKwh"
FROM classified
`.trim());
  await dropRelation(HOLIDAY_TABLE);
  return {
    monthlyUsage: monthlyUsageRows.map(row => ({
      month: String(row.month),
      totalKwh: Number(row.totalKwh),
      onPeakKwh: Number(row.onPeakKwh),
      offPeakKwh: Number(row.offPeakKwh),
      daysWithData: Number(row.daysWithData),
      missingDays: Number(row.missingDays)
    })),
    usageSummary: {
      loadedStart: String(summary.loadedStart),
      loadedEnd: String(summary.loadedEnd),
      intervalCount: Number(summary.intervalCount),
      totalKwh: Number(summary.totalKwh),
      onPeakKwh: Number(summary.onPeakKwh),
      offPeakKwh: Number(summary.offPeakKwh)
    }
  };
}

async function writeCanonicalParquet(sourceName: string): Promise<StoredUsageFile> {
  const fileName = safeCanonicalFileName(sourceName);
  await execSql(`COPY ${sqlIdentifier(TABLE_USAGE)} TO ${sqlString(fileName)} (FORMAT PARQUET)`);
  const db = await duckdb();
  const bytes = await db.copyFileToBuffer(fileName);
  await db.dropFile(fileName).catch(() => undefined);
  return {
    name: fileName,
    kind: "parquet",
    bytes: bytesToArrayBuffer(bytes),
    mimeType: "application/vnd.apache.parquet",
    canonical: true
  };
}

async function loadCanonicalUsageView(file: StoredUsageFile): Promise<void> {
  const fileName = await registerFile(file);
  await dropRelation(TABLE_USAGE);
  await execSql(`
CREATE VIEW ${sqlIdentifier(TABLE_USAGE)} AS
SELECT
  CAST(id AS VARCHAR) AS id,
  CAST(timestamp_local AS TIMESTAMP) AS timestamp_local,
  CAST(timestamp_end_local AS TIMESTAMP) AS timestamp_end_local,
  CAST(interval_index AS INTEGER) AS interval_index,
  CAST(read_date AS VARCHAR) AS read_date,
  CAST(read_time AS VARCHAR) AS read_time,
  CAST(read_time_occurrence AS INTEGER) AS read_time_occurrence,
  CAST(usage_kwh AS DOUBLE) AS usage_kwh,
  CAST(source AS VARCHAR) AS source
FROM read_parquet(${sqlString(fileName)})
`.trim());
}

export async function importUsageFile(file: File): Promise<ImportResult> {
  if (!file.name.toLowerCase().endsWith(".csv") && !file.name.toLowerCase().endsWith(".parquet")) {
    throw new Error("Choose a CSV or Parquet usage file.");
  }

  const storedFile = await storedUsageFileFromFile(file);
  const { statsSql, rowsSql } = await createNormalizedUsageTableFromFile(storedFile);

  const [stats] = await queryJson<{
    negativeRowsClipped: number;
    kwhClippedToZero: number;
  }>(statsSql);
  const { monthlyUsage, usageSummary } = await usageMetricsFromTable();
  const importedAt = new Date().toISOString();
  const result: ImportResult = {
    rows: [],
    importedAt,
    sourceName: file.name,
    sourceKind: storedFile.kind,
    negativeRowsClipped: Number(stats?.negativeRowsClipped ?? 0),
    kwhClippedToZero: Number(stats?.kwhClippedToZero ?? 0),
    monthlyUsage,
    usageSummary,
    dataSource: {
      tableName: TABLE_USAGE,
      sourceName: file.name,
      sourceKind: storedFile.kind,
      importedAt,
      rowCount: usageSummary.intervalCount,
      loaded: true,
      file: storedFile
    }
  };
  return result;
}

export async function importExtensionUsageCsv(
  text: string,
  sourceName: string,
  mimeType = "text/csv"
): Promise<ImportResult> {
  const encoded = new TextEncoder().encode(text);
  const csvFile: StoredUsageFile = {
    name: sourceName,
    kind: "csv",
    bytes: bytesToArrayBuffer(encoded),
    mimeType
  };
  const { statsSql, registeredFileName } = await createNormalizedUsageTableFromFile(csvFile);
  const [stats] = await queryJson<{
    negativeRowsClipped: number;
    kwhClippedToZero: number;
  }>(statsSql);
  const canonicalFile = await writeCanonicalParquet(sourceName);
  await dropRelation(RAW_USAGE_TABLE);
  await (await duckdb()).dropFile(registeredFileName).catch(() => undefined);
  await loadCanonicalUsageView(canonicalFile);
  const { monthlyUsage, usageSummary } = await usageMetricsFromTable();
  const importedAt = new Date().toISOString();
  return {
    rows: [],
    importedAt,
    sourceName: canonicalFile.name,
    sourceKind: "parquet",
    negativeRowsClipped: Number(stats?.negativeRowsClipped ?? 0),
    kwhClippedToZero: Number(stats?.kwhClippedToZero ?? 0),
    monthlyUsage,
    usageSummary,
    dataSource: {
      tableName: TABLE_USAGE,
      sourceName: canonicalFile.name,
      sourceKind: "parquet",
      importedAt,
      rowCount: usageSummary.intervalCount,
      loaded: true,
      file: canonicalFile
    }
  };
}

export async function importSampleUsageObjects(
  rawRows: Record<string, unknown>[],
  sourceName: string
): Promise<ImportResult> {
  const result = normalizeUsageRows(rawRows, sourceName, "sample");
  await loadUsageRowsTable(result.rows, sourceName);
  const { monthlyUsage, usageSummary } = await usageMetricsFromTable();
  result.monthlyUsage = monthlyUsage;
  result.usageSummary = usageSummary;
  result.dataSource = {
    tableName: TABLE_USAGE,
    sourceName,
    sourceKind: "sample",
    importedAt: result.importedAt,
    rowCount: usageSummary.intervalCount,
    loaded: true
  };
  return result;
}

export async function ensureUsageTable(result: ImportResult): Promise<void> {
  if (result.dataSource?.tableName === TABLE_USAGE && result.dataSource.loaded) return;
  if (result.dataSource?.file) {
    if (result.dataSource.file.canonical) {
      await loadCanonicalUsageView(result.dataSource.file);
      result.dataSource = {
        ...result.dataSource,
        tableName: TABLE_USAGE,
        loaded: true
      };
      return;
    }
    await createNormalizedUsageTableFromFile(result.dataSource.file);
    result.dataSource = {
      ...result.dataSource,
      tableName: TABLE_USAGE,
      loaded: true
    };
    return;
  }
  if (result.dataSource?.sourceKind === "sample") {
    await loadUsageRowsTable(result.rows, result.sourceName);
    result.dataSource = {
      ...result.dataSource,
      tableName: TABLE_USAGE,
      loaded: true
    };
    return;
  }
  throw new Error("Saved usage data is missing its source file. Re-import the CSV or Parquet file.");
}

export async function loadUsageRowsTable(rows: UsageInterval[], sourceName: string): Promise<void> {
  const sorted = [...rows].sort((a, b) => a.timestampLocal.localeCompare(b.timestampLocal));
  const intervalMs = typicalIntervalMs(sorted);
  const data = sorted.map(row => ({
    id: row.id,
    timestamp_local_text: row.timestampLocal,
    timestamp_end_local_text: addMillisToLocalTimestamp(row.timestampLocal, intervalMs),
    interval_index: row.intervalIndex,
    read_date: row.readDate,
    read_time: row.readTime,
    read_time_occurrence: row.readTimeOccurrence,
    usage_kwh: row.usageKwh,
    source: row.source ?? sourceName
  }));
  await loadObjectsTable(TABLE_USAGE, data, {
    select: [
      "id",
      "CAST(timestamp_local_text AS TIMESTAMP) AS timestamp_local",
      "CAST(timestamp_end_local_text AS TIMESTAMP) AS timestamp_end_local",
      "CAST(interval_index AS INTEGER) AS interval_index",
      "read_date",
      "read_time",
      "CAST(read_time_occurrence AS INTEGER) AS read_time_occurrence",
      "CAST(usage_kwh AS DOUBLE) AS usage_kwh",
      "source"
    ]
  });
}

function rowFromQuery(row: Record<string, unknown>): UsageInterval {
  return {
    id: String(row.id),
    timestampLocal: String(row.timestampLocal),
    intervalIndex: Number(row.intervalIndex),
    readDate: row.readDate === null || row.readDate === undefined ? null : String(row.readDate),
    readTime: row.readTime === null || row.readTime === undefined ? null : String(row.readTime),
    readTimeOccurrence: Number(row.readTimeOccurrence),
    usageKwh: Number(row.usageKwh),
    source: row.source === null || row.source === undefined ? undefined : String(row.source)
  };
}

function typicalIntervalMs(rows: UsageInterval[]): number {
  const diffs: number[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = Date.parse(rows[index - 1].timestampLocal);
    const current = Date.parse(rows[index].timestampLocal);
    const diff = current - previous;
    if (diff > 0 && diff <= 6 * 60 * 60 * 1000) diffs.push(diff);
  }
  if (!diffs.length) return 60 * 60 * 1000;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

function addMillisToLocalTimestamp(value: string, millis: number): string {
  const date = new Date(value);
  date.setTime(date.getTime() + millis);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-") + `T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}
