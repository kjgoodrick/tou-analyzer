import { describe, expect, it } from "vitest";
import { compareMonthlyUsage, compareRates, groupMonthly, runScenario } from "../src/analysis";
import { SAMPLE_ROWS } from "../src/data";

describe("scenarios", () => {
  it("compares rates from monthly aggregates without interval rows", () => {
    const fromRows = compareRates(SAMPLE_ROWS);
    const fromMonthly = compareMonthlyUsage(
      groupMonthly(SAMPLE_ROWS),
      {
        loadedStart: fromRows.overall.loadedStart,
        loadedEnd: fromRows.overall.loadedEnd,
        intervalCount: SAMPLE_ROWS.length
      }
    );

    expect(fromMonthly.overall.totalKwh).toBe(fromRows.overall.totalKwh);
    expect(fromMonthly.overall.onPeakKwh).toBe(fromRows.overall.onPeakKwh);
    expect(fromMonthly.overall.offPeakKwh).toBe(fromRows.overall.offPeakKwh);
    expect(fromMonthly.overall.standardTotal).toBe(fromRows.overall.standardTotal);
    expect(fromMonthly.overall.touTotal).toBe(fromRows.overall.touTotal);
  });

  it("models on-peak shifting and EV annual energy", () => {
    const scenario = runScenario(SAMPLE_ROWS, {
      shiftOnPeakPercent: 50,
      evCount: 2,
      evAnnualMiles: 12000,
      evMilesPerKwh: 3,
      evOffPeakShare: 0.9
    });

    expect(scenario.shiftedKwh).toBeGreaterThan(0);
    expect(scenario.evAnnualKwh).toBe(8000);
    expect(scenario.evMonthlyKwh).toBeCloseTo(666.667, 3);
    expect(scenario.shiftedComparison.overall.intervalCount).toBeGreaterThan(SAMPLE_ROWS.length);
  });
});
