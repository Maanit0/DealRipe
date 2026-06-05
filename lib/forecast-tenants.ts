// Tenant-scoped data for the Forecast Room.
// Two tenants today: TopSort (Scotsman, marketplace SaaS) and
// Aware Inc. (DUCT, biometrics across financial services,
// government, healthcare, law enforcement, enterprise security).

export type TenantSlug = "topsort" | "aware";

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
  framework: "Scotsman" | "DUCT";
  weekOf: string;
  lastUpdatedAgo: string;
  changedCount: number;
  numbers: ForecastNumbers;
  movements: Movement[];
  leverage: Leverage[];
  leverageSummary: string;  // bottom paragraph below leverage cards
  calibration: Calibration;
};

// ============================================================
// TopSort tenant (Scotsman, marketplace SaaS)
// ============================================================

const TOPSORT: ForecastTenant = {
  slug: "topsort",
  name: "TopSort",
  product: "Retail media platform for marketplaces",
  framework: "Scotsman",
  weekOf: "May 18, 2026",
  lastUpdatedAgo: "12 minutes ago",
  changedCount: 3,
  numbers: {
    quarterTargetUsd: 2_500_000,
    quarterLabel: "Q2 2026",
    ripeForecastUsd: 1_330_000,
    repCommitUsd: 1_750_000,
  },
  movements: [
    {
      id: "kestrel",
      account: "Kestrel Apparel",
      arr: 680_000,
      rep: "Erica Klein",
      status: "at_risk",
      repProb: 85,
      repQuarter: "Q2 2026",
      repDate: "Apr 30, 2026",
      lastProb: 65,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 16",
      thisProb: 57,
      thisQuarter: "Q3 2026",
      thisDate: "Jul 23",
      delta: -8,
      reason:
        "CFO David Kowalski declined the meeting invite for Tuesday. Economic buyer now 21 days untouched.",
      convinceMe: 57,
    },
    {
      id: "northwind",
      account: "Northwind Grocers",
      arr: 520_000,
      rep: "Jimmy Park",
      status: "at_risk",
      repProb: 60,
      repQuarter: "Q2 2026",
      repDate: "May 31, 2026",
      lastProb: 54,
      lastQuarter: "Q3 2026",
      lastDate: "Jun 28",
      thisProb: 49,
      thisQuarter: "Q3 2026",
      thisDate: "Jul 12",
      delta: -5,
      reason:
        "Champion changed roles internally. Procurement still not engaged at typical day 60.",
      convinceMe: 49,
    },
    {
      id: "meridian",
      account: "Meridian Home",
      arr: 275_000,
      rep: "Sarah Chen",
      status: "at_risk",
      repProb: 30,
      repQuarter: "Q3 2026",
      repDate: "Jul 15, 2026",
      lastProb: 12,
      lastQuarter: "Q3 2026",
      lastDate: "Aug 25",
      thisProb: 0,
      thisQuarter: "Q3 2026",
      thisDate: "Sep 9",
      delta: -12,
      reason:
        "Two no shows on discovery this week. No qualified champion identified. Stalled before stage 2.",
      convinceMe: 0,
    },
    {
      id: "lumora",
      account: "Lumora Marketplace",
      arr: 340_000,
      rep: "Erica Klein",
      status: "stalled",
      repProb: 70,
      repQuarter: "Q2 2026",
      repDate: "Jun 15, 2026",
      lastProb: 47,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 24",
      thisProb: 44,
      thisQuarter: "Q3 2026",
      thisDate: "Jul 27",
      delta: -3,
      reason:
        "No new calls. Marcus has not responded to outreach for 6 days. Stage clock running.",
      convinceMe: 44,
    },
    {
      id: "harbor",
      account: "Harbor Outdoor",
      arr: 410_000,
      rep: "Marcus Webb",
      status: "healthy",
      repProb: 95,
      repQuarter: "Q2 2026",
      repDate: "Apr 25, 2026",
      lastProb: 92,
      lastQuarter: "Q2 2026",
      lastDate: "Apr 25",
      thisProb: 95,
      thisQuarter: "Q2 2026",
      thisDate: "Apr 25",
      delta: 3,
      reason:
        "Signing gate met. Procurement aligned. DealRipe now flags this as a clean commit.",
      convinceMe: 95,
    },
    {
      id: "atlas",
      account: "Atlas Pet Supply",
      arr: 180_000,
      rep: "Marcus Webb",
      status: "healthy",
      repProb: 85,
      repQuarter: "Q2 2026",
      repDate: "Apr 30, 2026",
      lastProb: 76,
      lastQuarter: "Q2 2026",
      lastDate: "May 14",
      thisProb: 80,
      thisQuarter: "Q2 2026",
      thisDate: "May 14",
      delta: 4,
      reason:
        "Decision maker confirmed in last call. Last open gate now closeable.",
      convinceMe: 80,
    },
  ],
  leverage: [
    {
      account: "Kestrel Apparel",
      action:
        "Get CFO David Kowalski into a working session this week. Marcus has the relationship. Ask him to broker the meeting before Friday.",
      impacts: [
        { label: "Close probability", value: "+18 points" },
        { label: "Close date pulled in", value: "14 days" },
        { label: "Weighted forecast", value: "+$61K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "Similar Kestrel stage deals required EB engagement within 30 days to close on time.",
    },
    {
      account: "Northwind Grocers",
      action:
        "Engage procurement now. This deal size always routes through procurement by day 60. We are at day 41 with no contact.",
      impacts: [
        { label: "Close probability", value: "+12 points" },
        { label: "Weighted forecast", value: "+$38K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "8 of 8 deals at this ACV in last 6 quarters went through procurement.",
    },
    {
      account: "Lumora Marketplace",
      action:
        "Confirm Q3 budget allocation with David Kowalski in writing. Marcus said “mid June feels doable” but the contract size exceeds his approval threshold.",
      impacts: [
        { label: "Close probability", value: "+15 points" },
        { label: "Weighted forecast", value: "+$24K", bold: true },
      ],
      confidence: "Medium",
      confidenceNote:
        "Budget confirmation in writing historically lifts close probability for Money gated deals.",
    },
    {
      account: "Meridian Home",
      action:
        "Identify and qualify the economic buyer before next call, or disqualify. Currently zero stakeholders verified as decision authority.",
      impacts: [
        { label: "Close probability", value: "+22 points" },
        { label: "Weighted forecast", value: "+$30K", bold: true },
      ],
      confidence: "Medium",
      confidenceNote:
        "Open stage deals without an EB by day 30 close at 8 percent.",
    },
    {
      account: "Lumora Marketplace",
      action:
        "Get Sarah, CEO, into the Validation call within 7 days. She has not been formally looped in and is required for any contract above $300K per Topsort patterns.",
      impacts: [
        { label: "Close probability", value: "+10 points" },
        { label: "Close date pulled in", value: "7 days" },
        { label: "Weighted forecast", value: "+$16K", bold: true },
      ],
      confidence: "Medium",
      confidenceNote:
        "Patterns from prior $300K+ TopSort deals indicate CEO engagement before Validation close.",
    },
  ],
  leverageSummary:
    "If all five actions are completed in the next 7 days, DealRipe projects forecast lifts to $1.50M, closing 60% of the gap to target.",
  calibration: {
    ripeAccuracyPct: 91,
    ripeDeviationUsd: 34_000,
    ripeDeviationFloorUsd: 200_000,
    repAccuracyPct: 64,
    repOvercommitUsd: 312_000,
    dealsTrainedOn: 247,
  },
};

// ============================================================
// Aware tenant (DUCT, biometrics)
// ============================================================

const AWARE: ForecastTenant = {
  slug: "aware",
  name: "Aware, Inc.",
  product: "Biometric authentication and identity verification",
  framework: "DUCT",
  weekOf: "May 18, 2026",
  lastUpdatedAgo: "9 minutes ago",
  changedCount: 4,
  numbers: {
    quarterTargetUsd: 2_500_000,
    quarterLabel: "Q2 2026",
    ripeForecastUsd: 1_330_000,
    repCommitUsd: 1_600_000,
  },
  movements: [
    {
      id: "banco-patagonia",
      account: "Banco Patagonia",
      industry: "Retail bank, Latin America",
      productContext: "Knomi mobile authentication for remote customer onboarding",
      arr: 480_000,
      rep: "Erica Klein",
      status: "at_risk",
      repProb: 78,
      repQuarter: "Q2 2026",
      repDate: "Jun 28, 2026",
      lastProb: 78,
      lastQuarter: "Q2 2026",
      lastDate: "Jun 28",
      thisProb: 71,
      thisQuarter: "Q3 2026",
      thisDate: "Aug 12",
      delta: -7,
      reason:
        "Customer said 'before our fiscal close' on April 7 call. Erica logged Q2 close from Head of Digital signal. Procurement not yet contacted. Banco Patagonia procurement adds 60 to 90 days on Knomi-scale contracts. DUCT Timing gate downgraded from green to amber.",
      convinceMe: 60,
    },
    {
      id: "us-customs",
      account: "U.S. Customs Border Modality Program",
      industry: "Government, border management",
      productContext:
        "AwareABIS multi modal biometric identification for border crossings",
      arr: 1_200_000,
      rep: "Jimmy Park",
      status: "at_risk",
      repProb: 32,
      repQuarter: "Q3 2026",
      repDate: "Aug 15, 2026",
      lastProb: 32,
      lastQuarter: "Q3 2026",
      lastDate: "Aug 15",
      thisProb: 25,
      thisQuarter: "Q4 2026",
      thisDate: "Nov 30",
      delta: -7,
      reason:
        "Day 41 of typical 60 to 90 day federal procurement cycle. Contracting officer not yet contacted on $1.2M contract. Decision Authority gate remains open. Slips one quarter at minimum.",
      convinceMe: 25,
    },
    {
      id: "pinnacle-health",
      account: "Pinnacle Health Network",
      industry: "Healthcare, multi state hospital system",
      productContext: "Knomi for EPCS prescriber authentication",
      arr: 310_000,
      rep: "Jimmy Park",
      status: "at_risk",
      repProb: 58,
      repQuarter: "Q2 2026",
      repDate: "Jun 30, 2026",
      lastProb: 58,
      lastQuarter: "Q2 2026",
      lastDate: "Jun 30",
      thisProb: 50,
      thisQuarter: "Q3 2026",
      thisDate: "Aug 22",
      delta: -8,
      reason:
        "Customer asking for on device matching but rep scoped server side architecture. Use Case gate flipped from amber to red. Mismatch on Knomi deployment model.",
      convinceMe: 50,
    },
    {
      id: "heritage-trust",
      account: "Heritage Trust Bank",
      industry: "Financial services, regional U.S. bank",
      productContext:
        "Knomi for KYC remote account opening plus AML transaction authentication",
      arr: 620_000,
      rep: "Erica Klein",
      status: "stalled",
      repProb: 41,
      repQuarter: "Q3 2026",
      repDate: "Jul 18, 2026",
      lastProb: 41,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 18",
      thisProb: 38,
      thisQuarter: "Q3 2026",
      thisDate: "Jul 25",
      delta: -3,
      reason:
        "Champion confirmed but Competition gate partial. FaceTec and Oz Forensics named in evaluation last week. No displacement strategy documented in deal notes.",
      convinceMe: 55,
    },
    {
      id: "riverside-sheriff",
      account: "Riverside County Sheriff",
      industry: "Law enforcement, county level",
      productContext:
        "AFIX Tracker for fingerprint, palmprint, and latent print identification",
      arr: 340_000,
      rep: "Marcus Webb",
      status: "healthy",
      repProb: 67,
      repQuarter: "Q2 2026",
      repDate: "May 28, 2026",
      lastProb: 67,
      lastQuarter: "Q2 2026",
      lastDate: "May 28",
      thisProb: 72,
      thisQuarter: "Q2 2026",
      thisDate: "May 28",
      delta: 5,
      reason:
        "Sheriff and IT lead confirmed in last call. Decision Authority gate now green. Clean commit forming.",
      convinceMe: 78,
    },
    {
      id: "apex-logistics",
      account: "Apex Logistics",
      industry: "Enterprise security, mid market logistics",
      productContext:
        "AwareID for workforce authentication and physical access control",
      arr: 220_000,
      rep: "Marcus Webb",
      status: "healthy",
      repProb: 80,
      repQuarter: "Q2 2026",
      repDate: "Apr 30, 2026",
      lastProb: 80,
      lastQuarter: "Q2 2026",
      lastDate: "Apr 30",
      thisProb: 84,
      thisQuarter: "Q2 2026",
      thisDate: "Apr 30",
      delta: 4,
      reason:
        "All four DUCT gates evidenced. Marcus Webb pattern: clean operator profile.",
      convinceMe: 84,
    },
  ],
  leverage: [
    {
      account: "Banco Patagonia",
      action:
        "Recalibrate timing with Adriana Vega, Banco Patagonia's Head of Digital. On April 7 call she said 'we want this in production before our fiscal close.' Erica logged Q2 close, but Adriana speaks for the digital team, not procurement. Banco Patagonia's procurement adds 60 to 90 days minimum on Knomi-scale contracts. Get written timeline confirmation from procurement before next technical review.",
      impacts: [
        { label: "Close probability", value: "+14 points" },
        { label: "Clarity gained", value: "21 days" },
        { label: "Weighted forecast", value: "+$48K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "7 of last 9 LATAM banking deals required procurement timeline confirmation separate from digital team signal before close commitment.",
    },
    {
      account: "U.S. Customs Border Modality Program",
      action:
        "Engage Operations program lead and contracting officer now. Adam Reyes is IT Director, no signing authority on $1M+ federal contracts. We are at day 41 on a 60 to 90 day procurement cycle.",
      impacts: [
        { label: "Close probability", value: "+18 points" },
        { label: "Weighted forecast", value: "+$76K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "Every federal contract above $1M in last 8 quarters required program lead and contracting officer engagement before signing.",
    },
    {
      account: "Pinnacle Health Network",
      action:
        "Re scope to on device Knomi D architecture or disqualify. Customer wants on device matching for EPCS compliance. Rep scoped server side Knomi S which mismatches their HIPAA posture.",
      impacts: [
        {
          label: "Loss avoidance",
          value: "$48K weighted forecast",
          bold: true,
        },
        {
          label: "Rep hours saved",
          value: "60 hours over Q3 if disqualified",
        },
      ],
      confidence: "Medium",
      confidenceNote:
        "Three of last four EPCS deals at Aware closed lost when deployment model was misaligned at validation stage.",
    },
    {
      account: "Heritage Trust Bank",
      action:
        "Surface FaceTec and Oz Forensics displacement strategy. Champion is friendly but Competition gate cannot close without a clear competitive narrative. Marcus Webb pattern: “who else made the shortlist and what is their gap?”",
      impacts: [
        { label: "Close probability", value: "+11 points" },
        { label: "Weighted forecast", value: "+$26K", bold: true },
      ],
      confidence: "Medium",
      confidenceNote:
        "Deals where Competition gate closes by stage 3 win at 1.6x the rate of deals where it stays open into negotiation.",
    },
    {
      account: "Riverside County Sheriff",
      action:
        "Lock signing date. All four DUCT gates green. Sheriff and IT lead confirmed. Push for AFIX Tracker signature in next 14 days before quarter roll.",
      impacts: [
        { label: "Close probability", value: "+6 points" },
        { label: "Close date pulled in", value: "9 days" },
        { label: "Weighted forecast", value: "+$22K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "Clean DUCT operator profile: 92% of deals at this gate state close on time when pushed.",
    },
  ],
  leverageSummary:
    "If all five actions are completed in the next 7 days, DealRipe projects forecast lifts to $1.45M, closing 55% of the gap to target.",
  calibration: {
    ripeAccuracyPct: 89,
    ripeDeviationUsd: 41_000,
    ripeDeviationFloorUsd: 250_000,
    repAccuracyPct: 61,
    repOvercommitUsd: 268_000,
    dealsTrainedOn: 184,
  },
};

export const TENANTS: Record<TenantSlug, ForecastTenant> = {
  topsort: TOPSORT,
  aware: AWARE,
};

export const TENANT_LIST: ForecastTenant[] = [TOPSORT, AWARE];

export function getTenant(slug: string | null | undefined): ForecastTenant {
  if (slug === "aware") return AWARE;
  return TOPSORT;
}
