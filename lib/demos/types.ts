// Demo tenant data shape, shared by every prospect demo in lib/demos/.
// This is the authoring surface for the gated Forecast Room demo.

export type TenantSlug = string; // any registered demo slug

export type DealStatus = "at_risk" | "stalled" | "healthy";

export type Movement = {
  id: string;
  account: string;
  industry?: string;
  productContext?: string;
  arr: number;
  rep: string;
  status: DealStatus;
  repProb: number;
  repQuarter: string;
  repDate: string;
  lastProb: number;
  lastQuarter: string;
  lastDate: string;
  thisProb: number;
  thisQuarter: string;
  thisDate: string;
  delta: number;
  reason: string;
  convinceMe: number;
};

export type LeverageImpact = {
  label: string;
  value: string;
  bold?: boolean;
};

export type Leverage = {
  account: string;
  action: string;
  impacts: LeverageImpact[];
  confidence: "High" | "Medium";
  confidenceNote: string;
};

export type ForecastNumbers = {
  quarterTargetUsd: number;
  quarterLabel: string;
  ripeForecastUsd: number;
  repCommitUsd: number;
};

export type Calibration = {
  ripeAccuracyPct: number;
  ripeDeviationUsd: number;
  ripeDeviationFloorUsd: number;
  repAccuracyPct: number;
  repOvercommitUsd: number;
  dealsTrainedOn: number;
};

export type ForecastTenant = {
  slug: TenantSlug;
  name: string;
  product: string;          // shown in top bar context
  framework: "Scotsman" | "DUCT" | "MEDDPICC";
  weekOf: string;
  lastUpdatedAgo: string;
  changedCount: number;
  numbers: ForecastNumbers;
  movements: Movement[];
  leverage: Leverage[];
  leverageSummary: string;  // bottom paragraph below leverage cards
  calibration: Calibration;
};
