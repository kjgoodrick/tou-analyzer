import {
  AdjustmentCharges,
  BillBreakdown,
  BillingAssumptions,
  CustomerClassId,
  TaxJurisdiction
} from "./types";

export const SUMMER_MONTHS = new Set([6, 7, 8, 9]);

export const CUSTOMER_CLASS_CHARGES: Record<CustomerClassId, number> = {
  SINGLE_FAMILY_SINGLE_PHASE: 12,
  SINGLE_FAMILY_THREE_PHASE: 19.5,
  MULTI_FAMILY_SINGLE_PHASE: 7,
  MULTI_FAMILY_THREE_PHASE: 14.5
};

export const CUSTOMER_CLASS_LABELS: Record<CustomerClassId, string> = {
  SINGLE_FAMILY_SINGLE_PHASE: "Single-family single-phase",
  SINGLE_FAMILY_THREE_PHASE: "Single-family three-phase",
  MULTI_FAMILY_SINGLE_PHASE: "Multi-family single-phase",
  MULTI_FAMILY_THREE_PHASE: "Multi-family three-phase"
};

export const DEFAULT_TAX_JURISDICTIONS: TaxJurisdiction[] = [
  { name: "Municipal Energy Sales/use Tax", rate: 0.06 },
  { name: "Utah Sales Tax", rate: 0.046 }
];

export const DEFAULT_BILLING_ASSUMPTIONS: BillingAssumptions = {
  customerClass: "SINGLE_FAMILY_SINGLE_PHASE",
  paperlessCredit: -0.5,
  taxJurisdictions: DEFAULT_TAX_JURISDICTIONS
};

const STANDARD_RATES = {
  summer: { firstBlock: 0.093199, additional: 0.12013 },
  winter: { firstBlock: 0.082477, additional: 0.106309 }
};

const TOU_RATES = {
  summer: { onPeak: 0.320834, offPeak: 0.071296 },
  winter: { onPeak: 0.283924, offPeak: 0.063094 }
};

const ADJUSTMENT_RATES = {
  schedule_94: 0.2214,
  schedule_98: -0.0048,
  schedule_193: 0.0384,
  schedule_196: 0,
  schedule_198: 0.0017,
  schedule_97: 0.0033
};

export const RIDER_DETAILS = [
  { name: "Schedule 94", friendlyName: "Energy Balancing Account", rateLabel: "22.14% of base energy" },
  { name: "Schedule 98", friendlyName: "Renewable Energy Adjustment", rateLabel: "-0.48% of base energy" },
  { name: "Schedule 193", friendlyName: "Customer Efficiency Services", rateLabel: "3.84% including Schedules 94 and 98" },
  { name: "Schedule 196", friendlyName: "STEP", rateLabel: "0.00% including Schedules 94 and 98" },
  { name: "Schedule 198", friendlyName: "Electric Vehicle Infrastructure", rateLabel: "0.17% including Schedules 94 and 98" },
  { name: "Schedule 97", friendlyName: "Wildfire Mitigation Balancing Account", rateLabel: "0.33% of customer and base energy" },
  { name: "Schedule 91", friendlyName: "Home Electric Lifeline Program", rateLabel: "$0.16 per month" }
];

export function money(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(value) * 100 + 0.5 + 1e-9) / 100;
}

function monthNumber(month: string): number {
  const parts = month.split("-");
  const value = Number(parts.length > 1 ? parts[1] : parts[0]);
  if (!Number.isInteger(value) || value < 1 || value > 12) {
    throw new Error(`Invalid month: ${month}`);
  }
  return value;
}

function season(month: string): "summer" | "winter" {
  return SUMMER_MONTHS.has(monthNumber(month)) ? "summer" : "winter";
}

function standardBaseEnergyCharge(month: string, totalKwh: number): number {
  const rates = STANDARD_RATES[season(month)];
  const firstBlockKwh = Math.min(Math.max(totalKwh, 0), 400);
  const additionalKwh = Math.max(totalKwh - 400, 0);
  return money(firstBlockKwh * rates.firstBlock) + money(additionalKwh * rates.additional);
}

function touBaseEnergyCharge(month: string, onPeakKwh: number, offPeakKwh: number): number {
  const rates = TOU_RATES[season(month)];
  return money(onPeakKwh * rates.onPeak) + money(offPeakKwh * rates.offPeak);
}

function adjustmentCharges(
  baseEnergyCharge: number,
  customerCharge: number
): AdjustmentCharges {
  const schedule94 = money(baseEnergyCharge * ADJUSTMENT_RATES.schedule_94);
  const schedule98 = money(baseEnergyCharge * ADJUSTMENT_RATES.schedule_98);
  const basisBase9498 = baseEnergyCharge + schedule94 + schedule98;

  return {
    schedule_94: schedule94,
    schedule_98: schedule98,
    schedule_193: money(basisBase9498 * ADJUSTMENT_RATES.schedule_193),
    schedule_196: money(basisBase9498 * ADJUSTMENT_RATES.schedule_196),
    schedule_198: money(basisBase9498 * ADJUSTMENT_RATES.schedule_198),
    schedule_97: money((customerCharge + baseEnergyCharge) * ADJUSTMENT_RATES.schedule_97),
    schedule_91: 0.16
  };
}

function calculateBill({
  month,
  totalKwh,
  onPeakKwh,
  offPeakKwh,
  assumptions,
  baseEnergyCharge,
  rateClass
}: {
  month: string;
  totalKwh: number;
  onPeakKwh: number;
  offPeakKwh: number;
  assumptions: BillingAssumptions;
  baseEnergyCharge: number;
  rateClass: string;
}): BillBreakdown {
  const customerCharge = CUSTOMER_CLASS_CHARGES[assumptions.customerClass];
  const adjustments = adjustmentCharges(baseEnergyCharge, customerCharge);
  const adjustmentTotal = money(Object.values(adjustments).reduce((sum, value) => sum + value, 0));
  const taxableSubtotal = money(
    customerCharge + baseEnergyCharge + adjustmentTotal + assumptions.paperlessCredit
  );
  const municipalEnergySalesUseTax = money(
    taxableSubtotal *
      (assumptions.taxJurisdictions.find(j => j.name === "Municipal Energy Sales/use Tax")?.rate ??
        0)
  );
  const utahSalesTax = money(
    taxableSubtotal *
      (assumptions.taxJurisdictions.find(j => j.name === "Utah Sales Tax")?.rate ?? 0)
  );
  const otherTaxes = assumptions.taxJurisdictions
    .filter(j => j.name !== "Municipal Energy Sales/use Tax" && j.name !== "Utah Sales Tax")
    .reduce((sum, jurisdiction) => sum + money(taxableSubtotal * jurisdiction.rate), 0);
  const taxes = money(municipalEnergySalesUseTax + utahSalesTax + otherTaxes);

  return {
    scheduleNumber: 1,
    scheduleName: "Residential Service",
    rateClass,
    month,
    customerClass: assumptions.customerClass,
    totalKwh,
    onPeakKwh,
    offPeakKwh,
    customerCharge,
    baseEnergyCharge,
    ...adjustments,
    paperlessCredit: money(assumptions.paperlessCredit),
    taxableSubtotal,
    municipalEnergySalesUseTax,
    utahSalesTax,
    taxes,
    total: money(taxableSubtotal + taxes)
  };
}

export function calculateStandardBill(
  month: string,
  totalKwh: number,
  assumptions: BillingAssumptions = DEFAULT_BILLING_ASSUMPTIONS
): BillBreakdown {
  const currentSeason = season(month);
  return calculateBill({
    month,
    totalKwh,
    onPeakKwh: 0,
    offPeakKwh: 0,
    assumptions,
    baseEnergyCharge: standardBaseEnergyCharge(month, totalKwh),
    rateClass: currentSeason === "summer" ? "Schedule_1_Summer" : "Schedule_1_Winter"
  });
}

export function calculateTouBill(
  month: string,
  onPeakKwh: number,
  offPeakKwh: number,
  assumptions: BillingAssumptions = DEFAULT_BILLING_ASSUMPTIONS
): BillBreakdown {
  const currentSeason = season(month);
  return calculateBill({
    month,
    totalKwh: onPeakKwh + offPeakKwh,
    onPeakKwh,
    offPeakKwh,
    assumptions,
    baseEnergyCharge: touBaseEnergyCharge(month, onPeakKwh, offPeakKwh),
    rateClass: currentSeason === "summer" ? "Schedule_1_TOU_Summer" : "Schedule_1_TOU_Winter"
  });
}

export function effectiveTouEnergyRate(month: string, period: "onPeak" | "offPeak"): number {
  return TOU_RATES[season(month)][period];
}

export function effectiveStandardAdditionalRate(month: string): number {
  return STANDARD_RATES[season(month)].additional;
}
