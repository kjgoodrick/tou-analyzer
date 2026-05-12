import { dateFromTimestamp, isSchedule1TouOnPeak, monthFromTimestamp } from "./holidays";
import {
  calculateStandardBill,
  calculateTouBill,
  DEFAULT_BILLING_ASSUMPTIONS,
  effectiveStandardAdditionalRate,
  effectiveTouEnergyRate,
  money
} from "./rates";
import {
  AnnualComparison,
  BillingAssumptions,
  MonthlyUsageAggregate,
  MonthlyComparison,
  RateComparison,
  Recommendation,
  ScenarioInputs,
  ScenarioResult,
  UsageInterval
} from "./types";

interface MutableMonthlyBucket extends MonthlyUsageAggregate {
  dates: Set<string>;
}

function daysInMonth(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(year, monthNumber, 0).getDate();
}

function recommendationForSavingsPercent(value: number): Recommendation {
  if (value >= 0.05) {
    return {
      kind: "good",
      label: "Good candidate",
      message: "TOU is meaningfully cheaper across all loaded data."
    };
  }
  if (value <= -0.02) {
    return {
      kind: "poor",
      label: "Poor candidate",
      message: "TOU costs more than the standard rate for this usage pattern."
    };
  }
  if (value > 0) {
    return {
      kind: "could_work",
      label: "Could work",
      message:
        "TOU has savings potential based on your usage history, but the margin is small enough that an unfavorable shift toward evening use could reverse it. Shifting evening load or charging an EV off-peak could still push the savings higher."
    };
  }
  return {
    kind: "could_work",
    label: "Could work",
    message:
      "TOU is slightly more expensive based on your usage history, but it is close enough that shifting evening load or charging an EV off-peak could change the result."
  };
}

export function groupMonthly(rows: UsageInterval[]): MonthlyUsageAggregate[] {
  const buckets = new Map<string, MutableMonthlyBucket>();

  for (const row of rows) {
    const month = monthFromTimestamp(row.timestampLocal);
    const bucket =
      buckets.get(month) ??
      {
        month,
        totalKwh: 0,
        onPeakKwh: 0,
        offPeakKwh: 0,
        daysWithData: 0,
        missingDays: 0,
        dates: new Set<string>()
      };
    const usage = row.usageKwh;
    bucket.dates.add(dateFromTimestamp(row.timestampLocal));
    bucket.totalKwh += usage;
    if (isSchedule1TouOnPeak(row.timestampLocal)) {
      bucket.onPeakKwh += usage;
    } else {
      bucket.offPeakKwh += usage;
    }
    buckets.set(month, bucket);
  }

  return [...buckets.values()]
    .map(bucket => ({
      month: bucket.month,
      totalKwh: Number(bucket.totalKwh.toFixed(6)),
      onPeakKwh: Number(bucket.onPeakKwh.toFixed(6)),
      offPeakKwh: Number(bucket.offPeakKwh.toFixed(6)),
      daysWithData: bucket.dates.size,
      missingDays: Math.max(0, daysInMonth(bucket.month) - bucket.dates.size)
    }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

function annualFromMonthly(monthly: MonthlyComparison[]): AnnualComparison[] {
  const buckets = new Map<string, AnnualComparison>();

  for (const month of monthly) {
    const year = month.month.slice(0, 4);
    const bucket =
      buckets.get(year) ??
      {
        year,
        totalKwh: 0,
        onPeakKwh: 0,
        offPeakKwh: 0,
        standardTotal: 0,
        touTotal: 0,
        savings: 0,
        savingsPercent: 0
      };
    bucket.totalKwh += month.totalKwh;
    bucket.onPeakKwh += month.onPeakKwh;
    bucket.offPeakKwh += month.offPeakKwh;
    bucket.standardTotal += month.standard.total;
    bucket.touTotal += month.tou.total;
    buckets.set(year, bucket);
  }

  return [...buckets.values()]
    .map(bucket => ({
      ...bucket,
      standardTotal: money(bucket.standardTotal),
      touTotal: money(bucket.touTotal),
      savings: money(bucket.standardTotal - bucket.touTotal),
      savingsPercent: bucket.standardTotal ? (bucket.standardTotal - bucket.touTotal) / bucket.standardTotal : 0
    }))
    .sort((a, b) => a.year.localeCompare(b.year));
}

export function compareMonthlyUsage(
  buckets: MonthlyUsageAggregate[],
  summary: {
    loadedStart: string;
    loadedEnd: string;
    intervalCount: number;
  },
  assumptions: BillingAssumptions = DEFAULT_BILLING_ASSUMPTIONS
): RateComparison {
  if (!buckets.length) {
    throw new Error("At least one usage interval is required.");
  }

  const monthly = buckets.map((bucket): MonthlyComparison => {
    const standard = calculateStandardBill(bucket.month, bucket.totalKwh, assumptions);
    const tou = calculateTouBill(bucket.month, bucket.onPeakKwh, bucket.offPeakKwh, assumptions);
    const savings = money(standard.total - tou.total);
    return {
      month: bucket.month,
      totalKwh: bucket.totalKwh,
      onPeakKwh: bucket.onPeakKwh,
      offPeakKwh: bucket.offPeakKwh,
      daysWithData: bucket.daysWithData,
      missingDays: bucket.missingDays,
      standard,
      tou,
      touMinusStandard: money(tou.total - standard.total),
      savings,
      savingsPercent: standard.total ? savings / standard.total : 0
    };
  });

  const annual = annualFromMonthly(monthly);
  const standardTotal = money(monthly.reduce((sum, row) => sum + row.standard.total, 0));
  const touTotal = money(monthly.reduce((sum, row) => sum + row.tou.total, 0));
  const savings = money(standardTotal - touTotal);
  const savingsPercent = standardTotal ? savings / standardTotal : 0;

  return {
    rows: [],
    monthly,
    annual,
    overall: {
      loadedStart: summary.loadedStart,
      loadedEnd: summary.loadedEnd,
      intervalCount: summary.intervalCount,
      totalKwh: Number(monthly.reduce((sum, row) => sum + row.totalKwh, 0).toFixed(6)),
      onPeakKwh: Number(monthly.reduce((sum, row) => sum + row.onPeakKwh, 0).toFixed(6)),
      offPeakKwh: Number(monthly.reduce((sum, row) => sum + row.offPeakKwh, 0).toFixed(6)),
      standardTotal,
      touTotal,
      savings,
      savingsPercent,
      recommendation: recommendationForSavingsPercent(savingsPercent)
    }
  };
}

export function compareRates(
  rows: UsageInterval[],
  assumptions: BillingAssumptions = DEFAULT_BILLING_ASSUMPTIONS
): RateComparison {
  if (!rows.length) {
    throw new Error("At least one usage interval is required.");
  }

  const sortedRows = [...rows].sort((a, b) => a.timestampLocal.localeCompare(b.timestampLocal));
  return compareMonthlyUsage(
    groupMonthly(rows),
    {
      loadedStart: sortedRows[0].timestampLocal,
      loadedEnd: sortedRows[sortedRows.length - 1].timestampLocal,
      intervalCount: rows.length
    },
    assumptions
  );
}

export function applyOnPeakShift(rows: UsageInterval[], shiftOnPeakPercent: number): UsageInterval[] {
  const shift = Math.max(0, Math.min(100, shiftOnPeakPercent)) / 100;
  if (shift === 0) return rows;

  const monthlyShift = new Map<string, number>();
  const offPeakCounts = new Map<string, number>();
  for (const row of rows) {
    const month = monthFromTimestamp(row.timestampLocal);
    if (isSchedule1TouOnPeak(row.timestampLocal)) {
      monthlyShift.set(month, (monthlyShift.get(month) ?? 0) + row.usageKwh * shift);
    } else {
      offPeakCounts.set(month, (offPeakCounts.get(month) ?? 0) + 1);
    }
  }

  return rows.map(row => {
    const month = monthFromTimestamp(row.timestampLocal);
    if (isSchedule1TouOnPeak(row.timestampLocal)) {
      return { ...row, usageKwh: row.usageKwh * (1 - shift) };
    }

    const add = (monthlyShift.get(month) ?? 0) / Math.max(offPeakCounts.get(month) ?? 1, 1);
    return { ...row, usageKwh: row.usageKwh + add };
  });
}

function evRows(rows: UsageInterval[], inputs: ScenarioInputs): UsageInterval[] {
  const annualKwh = inputs.evMilesPerKwh > 0 ? (inputs.evAnnualMiles * inputs.evCount) / inputs.evMilesPerKwh : 0;
  if (annualKwh <= 0) return rows;

  const months = [...new Set(rows.map(row => monthFromTimestamp(row.timestampLocal)))].sort();
  const monthlyKwh = annualKwh / 12;
  const additions: UsageInterval[] = [];

  for (const month of months) {
    const [year, monthNumber] = month.split("-").map(Number);
    const offPeakKwh = monthlyKwh * inputs.evOffPeakShare;
    const onPeakKwh = monthlyKwh - offPeakKwh;
    additions.push(
      {
        id: `ev-${month}-off`,
        timestampLocal: `${year}-${String(monthNumber).padStart(2, "0")}-15T23:00:00`,
        intervalIndex: 1,
        readDate: `${year}-${String(monthNumber).padStart(2, "0")}-15`,
        readTime: "23:00",
        readTimeOccurrence: 1,
        usageKwh: offPeakKwh,
        source: "EV scenario"
      },
      {
        id: `ev-${month}-on`,
        timestampLocal: `${year}-${String(monthNumber).padStart(2, "0")}-15T19:00:00`,
        intervalIndex: 2,
        readDate: `${year}-${String(monthNumber).padStart(2, "0")}-15`,
        readTime: "19:00",
        readTimeOccurrence: 1,
        usageKwh: onPeakKwh,
        source: "EV scenario"
      }
    );
  }

  return [...rows, ...additions];
}

export function runScenario(
  rows: UsageInterval[],
  inputs: ScenarioInputs,
  assumptions: BillingAssumptions = DEFAULT_BILLING_ASSUMPTIONS
): ScenarioResult {
  const shiftedRows = applyOnPeakShift(rows, inputs.shiftOnPeakPercent);
  const shiftedComparison = compareRates(evRows(shiftedRows, inputs), assumptions);
  const baseComparison = compareRates(rows, assumptions);
  const shiftedKwh = Math.max(0, baseComparison.overall.onPeakKwh * (inputs.shiftOnPeakPercent / 100));
  const evAnnualKwh = inputs.evMilesPerKwh > 0 ? (inputs.evAnnualMiles * inputs.evCount) / inputs.evMilesPerKwh : 0;
  const evMonthlyKwh = evAnnualKwh / 12;

  const weightedStandardAnnualCost = baseComparison.monthly.reduce((sum, month) => {
    return sum + effectiveStandardAdditionalRate(month.month) * evMonthlyKwh;
  }, 0);
  const weightedTouAnnualCost = baseComparison.monthly.reduce((sum, month) => {
    const onPeak = evMonthlyKwh * (1 - inputs.evOffPeakShare);
    const offPeak = evMonthlyKwh * inputs.evOffPeakShare;
    return (
      sum +
      effectiveTouEnergyRate(month.month, "onPeak") * onPeak +
      effectiveTouEnergyRate(month.month, "offPeak") * offPeak
    );
  }, 0);

  return {
    shiftedComparison,
    shiftedKwh,
    evMonthlyKwh,
    evAnnualKwh,
    evStandardAnnualCost: money(weightedStandardAnnualCost),
    evTouAnnualCost: money(weightedTouAnnualCost),
    evTouSavings: money(weightedStandardAnnualCost - weightedTouAnnualCost)
  };
}

export function runMonthlyScenario(
  buckets: MonthlyUsageAggregate[],
  summary: { loadedStart: string; loadedEnd: string; intervalCount: number },
  inputs: ScenarioInputs,
  assumptions: BillingAssumptions = DEFAULT_BILLING_ASSUMPTIONS
): ScenarioResult {
  const shift = Math.max(0, Math.min(100, inputs.shiftOnPeakPercent)) / 100;
  const shifted = buckets.map(bucket => {
    const shiftedKwh = bucket.onPeakKwh * shift;
    return {
      ...bucket,
      onPeakKwh: bucket.onPeakKwh - shiftedKwh,
      offPeakKwh: bucket.offPeakKwh + shiftedKwh
    };
  });

  const evAnnualKwh = inputs.evMilesPerKwh > 0 ? (inputs.evAnnualMiles * inputs.evCount) / inputs.evMilesPerKwh : 0;
  const evMonthlyKwh = evAnnualKwh / 12;
  const withEv = shifted.map(bucket => {
    const offPeakKwh = evMonthlyKwh * inputs.evOffPeakShare;
    const onPeakKwh = evMonthlyKwh - offPeakKwh;
    return {
      ...bucket,
      totalKwh: bucket.totalKwh + evMonthlyKwh,
      onPeakKwh: bucket.onPeakKwh + onPeakKwh,
      offPeakKwh: bucket.offPeakKwh + offPeakKwh
    };
  });

  const shiftedComparison = compareMonthlyUsage(withEv, summary, assumptions);
  const baseComparison = compareMonthlyUsage(buckets, summary, assumptions);
  const shiftedKwh = Math.max(0, baseComparison.overall.onPeakKwh * shift);

  const weightedStandardAnnualCost = baseComparison.monthly.reduce((sum, month) => {
    return sum + effectiveStandardAdditionalRate(month.month) * evMonthlyKwh;
  }, 0);
  const weightedTouAnnualCost = baseComparison.monthly.reduce((sum, month) => {
    const onPeak = evMonthlyKwh * (1 - inputs.evOffPeakShare);
    const offPeak = evMonthlyKwh * inputs.evOffPeakShare;
    return sum + effectiveTouEnergyRate(month.month, "onPeak") * onPeak + effectiveTouEnergyRate(month.month, "offPeak") * offPeak;
  }, 0);

  return {
    shiftedComparison,
    shiftedKwh,
    evMonthlyKwh,
    evAnnualKwh,
    evStandardAnnualCost: money(weightedStandardAnnualCost),
    evTouAnnualCost: money(weightedTouAnnualCost),
    evTouSavings: money(weightedStandardAnnualCost - weightedTouAnnualCost)
  };
}
