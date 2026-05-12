import { describe, expect, it } from "vitest";
import { buildUsageNormalizationSql, normalizeUsageRows } from "../src/data";

describe("data import", () => {
  it("normalizes in-memory sample rows", () => {
    const result = normalizeUsageRows(
      [
        {
          timestamp_local: "2026-05-08T01:00:00",
          interval_index: "1",
          read_date: "05/08/2026",
          read_time: "1:00 AM",
          read_time_occurrence: "1",
          usage_kwh: "1.25"
        }
      ],
      "test.csv",
      "csv"
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].timestampLocal).toBe("2026-05-08T01:00:00");
    expect(result.rows[0].usageKwh).toBe(1.25);
  });

  it("derives timestamps from read fields, skips invalid 24-hour times, and clips negative usage", () => {
    const result = normalizeUsageRows(
      [
        { read_date: "2026-05-08", read_time: "24:00", usage_kwh: "9" },
        { read_date: "2026-05-08", read_time: "23:00", usage_kwh: "-0.5" },
        { read_date: "05/09/2026", read_time: "1:00 AM", usage_kwh: "2" }
      ],
      "upload.csv",
      "csv"
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].timestampLocal).toBe("2026-05-08T23:00:00");
    expect(result.rows[0].usageKwh).toBe(0);
    expect(result.negativeRowsClipped).toBe(1);
    expect(result.kwhClippedToZero).toBe(0.5);
  });

  it("keeps duplicate local timestamps distinct with occurrence counts", () => {
    const result = normalizeUsageRows(
      [
        { timestamp_local: "2026-11-01T01:00:00", usage_kwh: 1 },
        { timestamp_local: "2026-11-01T01:00:00", usage_kwh: 2 }
      ],
      "dst.csv",
      "csv"
    );
    expect(result.rows.map(row => row.readTimeOccurrence)).toEqual([1, 2]);
    expect(result.rows.reduce((sum, row) => sum + row.usageKwh, 0)).toBe(3);
  });

  it("builds DuckDB normalization SQL for uploaded files without CSV reserialization", () => {
    const sql = buildUsageNormalizationSql(
      "raw_usage",
      "energy_usage",
      ["timestamp_local", "interval_index", "read_date", "read_time", "read_time_occurrence", "usage_kwh"],
      "upload.parquet"
    );
    expect(sql.createTableSql).toContain("CREATE OR REPLACE TABLE \"energy_usage\"");
    expect(sql.createTableSql).toContain("TRY_CAST(\"usage_kwh\" AS DOUBLE)");
    expect(sql.createTableSql).toContain("AS timestamp_end_local");
    expect(sql.rowsSql).toContain("strftime(timestamp_local");
    expect(sql.createTableSql.toLowerCase()).not.toContain("csv");
    expect(sql.statsSql.toLowerCase()).not.toContain("csv");
  });

  it("uses typed Parquet timestamps directly instead of text datetime parsing", () => {
    const sql = buildUsageNormalizationSql(
      "raw_usage",
      "energy_usage",
      [
        { name: "read_date", type: "VARCHAR" },
        { name: "read_time", type: "VARCHAR" },
        { name: "usage_kwh", type: "DOUBLE" },
        { name: "timestamp_local", type: "TIMESTAMP" }
      ],
      "hourly_usage.parquet"
    );
    expect(sql.createTableSql).toContain("\"timestamp_local\" AS timestamp_value_raw");
    expect(sql.createTableSql).toContain("CAST(NULL AS VARCHAR) AS timestamp_text");
    expect(sql.createTableSql).toContain("TRY_CAST(timestamp_value_raw AS TIMESTAMP)");
    expect(sql.createTableSql).toContain("try_strptime");
  });

  it("builds SQL for read date/time fields with DuckDB parsers and clipping stats", () => {
    const sql = buildUsageNormalizationSql(
      "raw_usage",
      "energy_usage",
      ["read_date", "read_time", "usage_kwh"],
      "upload.csv"
    );
    expect(sql.createTableSql).toContain("TRY_CAST(\"usage_kwh\" AS DOUBLE)");
    expect(sql.createTableSql).toContain("try_strptime(read_date_text");
    expect(sql.createTableSql).not.toContain("24:00");
    expect(sql.statsSql).toContain("COUNT(*) FILTER (WHERE usage_raw < 0)");
  });
});
