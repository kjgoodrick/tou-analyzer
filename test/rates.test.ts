import { describe, expect, it } from "vitest";
import { compareRates, groupMonthly } from "../src/analysis";
import { isSchedule1TouOnPeak, isUtahSchedule1Holiday, utahSchedule1Holidays } from "../src/holidays";
import { calculateStandardBill, calculateTouBill, money } from "../src/rates";
import { UsageInterval } from "../src/types";

describe("rate calculations", () => {
  it("rounds money using half-up cents", () => {
    expect(money(1.005)).toBe(1.01);
    expect(money(-1.005)).toBe(-1.01);
  });

  it("matches known Schedule 1 standard bill line items", () => {
    const bill = calculateStandardBill("2026-04", 1327);
    expect(bill.customerCharge).toBe(12);
    expect(bill.baseEnergyCharge).toBe(131.54);
    expect(bill.schedule_94).toBe(29.12);
    expect(bill.schedule_98).toBe(-0.63);
    expect(bill.schedule_193).toBe(6.15);
    expect(bill.schedule_196).toBe(0);
    expect(bill.schedule_198).toBe(0.27);
    expect(bill.schedule_97).toBe(0.47);
    expect(bill.schedule_91).toBe(0.16);
    expect(bill.paperlessCredit).toBe(-0.5);
    expect(bill.municipalEnergySalesUseTax).toBe(10.71);
    expect(bill.utahSalesTax).toBe(8.21);
    expect(bill.total).toBe(197.5);
  });

  it("classifies on-peak hours and holidays", () => {
    expect(isSchedule1TouOnPeak("2026-07-02T18:00:00")).toBe(true);
    expect(isSchedule1TouOnPeak("2026-07-02T21:59:00")).toBe(true);
    expect(isSchedule1TouOnPeak("2026-07-02T22:00:00")).toBe(false);
    expect(isSchedule1TouOnPeak("2026-07-04T18:00:00")).toBe(false);
    expect(isSchedule1TouOnPeak("2026-07-03T18:00:00")).toBe(false);
    expect(isUtahSchedule1Holiday("2026-02-16")).toBe(true);
    expect(utahSchedule1Holidays(2026).has("2026-07-03")).toBe(true);
  });

  it("matches known TOU bill energy split", () => {
    const bill = calculateTouBill("2026-07", 3, 28);
    expect(bill.rateClass).toBe("Schedule_1_TOU_Summer");
    expect(bill.baseEnergyCharge).toBe(2.96);
  });

  it("groups monthly rows and computes all-data recommendation bands", () => {
    const rows: UsageInterval[] = [
      interval("2026-07-02T18:00:00", 1),
      interval("2026-07-02T21:00:00", 2),
      interval("2026-07-02T22:00:00", 4),
      interval("2026-07-03T18:00:00", 8),
      interval("2026-07-04T18:00:00", 16),
      interval("2026-08-01T00:00:00", 5)
    ];

    expect(groupMonthly(rows)).toEqual([
      { month: "2026-07", totalKwh: 31, onPeakKwh: 3, offPeakKwh: 28, daysWithData: 3, missingDays: 28 },
      { month: "2026-08", totalKwh: 5, onPeakKwh: 0, offPeakKwh: 5, daysWithData: 1, missingDays: 30 }
    ]);
    expect(compareRates(rows).overall.intervalCount).toBe(6);
  });
});

function interval(timestampLocal: string, usageKwh: number): UsageInterval {
  return {
    id: timestampLocal,
    timestampLocal,
    intervalIndex: 1,
    readDate: timestampLocal.slice(0, 10),
    readTime: timestampLocal.slice(11, 16),
    readTimeOccurrence: 1,
    usageKwh
  };
}
