export type CustomerClassId =
  | "SINGLE_FAMILY_SINGLE_PHASE"
  | "SINGLE_FAMILY_THREE_PHASE"
  | "MULTI_FAMILY_SINGLE_PHASE"
  | "MULTI_FAMILY_THREE_PHASE";

export type RateScheduleId = "standard" | "tou";

export type RecommendationKind = "good" | "could_work" | "poor";

export interface UsageInterval {
  id: string;
  timestampLocal: string;
  intervalIndex: number;
  readDate: string | null;
  readTime: string | null;
  readTimeOccurrence: number;
  usageKwh: number;
  source?: string;
}

export interface MonthlyUsageAggregate {
  month: string;
  totalKwh: number;
  onPeakKwh: number;
  offPeakKwh: number;
  daysWithData: number;
  missingDays: number;
}

export interface UsageSummary {
  loadedStart: string;
  loadedEnd: string;
  intervalCount: number;
  totalKwh: number;
  onPeakKwh: number;
  offPeakKwh: number;
}

export interface ImportResult {
  rows: UsageInterval[];
  importedAt: string;
  sourceName: string;
  sourceKind: "csv" | "parquet" | "sample";
  negativeRowsClipped: number;
  kwhClippedToZero: number;
  monthlyUsage?: MonthlyUsageAggregate[];
  usageSummary?: UsageSummary;
  dataSource?: UsageDataSource;
}

export interface UsageDataSource {
  tableName: string;
  sourceName: string;
  sourceKind: ImportResult["sourceKind"];
  importedAt: string;
  rowCount: number;
  loaded: boolean;
  file?: StoredUsageFile;
}

export interface StoredUsageFile {
  name: string;
  kind: "csv" | "parquet";
  bytes: ArrayBuffer;
  mimeType?: string;
  canonical?: boolean;
}

export interface TaxJurisdiction {
  name: string;
  rate: number;
}

export interface BillingAssumptions {
  customerClass: CustomerClassId;
  paperlessCredit: number;
  taxJurisdictions: TaxJurisdiction[];
}

export interface AdjustmentCharges {
  schedule_94: number;
  schedule_98: number;
  schedule_193: number;
  schedule_196: number;
  schedule_198: number;
  schedule_97: number;
  schedule_91: number;
}

export interface BillBreakdown extends AdjustmentCharges {
  scheduleNumber: number;
  scheduleName: string;
  rateClass: string;
  month: string;
  customerClass: CustomerClassId;
  totalKwh: number;
  onPeakKwh: number;
  offPeakKwh: number;
  customerCharge: number;
  baseEnergyCharge: number;
  paperlessCredit: number;
  taxableSubtotal: number;
  municipalEnergySalesUseTax: number;
  utahSalesTax: number;
  taxes: number;
  total: number;
}

export interface MonthlyComparison {
  month: string;
  totalKwh: number;
  onPeakKwh: number;
  offPeakKwh: number;
  daysWithData: number;
  missingDays: number;
  standard: BillBreakdown;
  tou: BillBreakdown;
  touMinusStandard: number;
  savings: number;
  savingsPercent: number;
}

export interface AnnualComparison {
  year: string;
  totalKwh: number;
  onPeakKwh: number;
  offPeakKwh: number;
  standardTotal: number;
  touTotal: number;
  savings: number;
  savingsPercent: number;
}

export interface OverallComparison {
  loadedStart: string;
  loadedEnd: string;
  intervalCount: number;
  totalKwh: number;
  onPeakKwh: number;
  offPeakKwh: number;
  standardTotal: number;
  touTotal: number;
  savings: number;
  savingsPercent: number;
  recommendation: Recommendation;
}

export interface Recommendation {
  kind: RecommendationKind;
  label: string;
  message: string;
}

export interface RateComparison {
  rows: UsageInterval[];
  monthly: MonthlyComparison[];
  annual: AnnualComparison[];
  overall: OverallComparison;
}

export interface ScenarioInputs {
  shiftOnPeakPercent: number;
  evCount: number;
  evAnnualMiles: number;
  evMilesPerKwh: number;
  evOffPeakShare: number;
}

export interface ScenarioResult {
  shiftedComparison: RateComparison;
  shiftedKwh: number;
  evMonthlyKwh: number;
  evAnnualKwh: number;
  evStandardAnnualCost: number;
  evTouAnnualCost: number;
  evTouSavings: number;
}
