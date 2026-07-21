import {
  SCOTSMAN_FIELDS,
  STAGES,
  type DealStatus,
  type ExtractionResult,
  type Stage,
} from "./scotsman";

// ============================================================
// Types
// ============================================================

export type Contact = {
  id: string;
  name: string;
  role: string;
  relationship: "champion" | "influencer" | "economic_buyer" | "user" | "unknown";
  lastContactedAt: string | null; // ISO date
};

export type CallRecord = {
  id: string;
  dealId: string;
  date: string;          // ISO date
  durationMinutes: number;
  participants: string[];
  source: "gong" | "manual_paste";
  // The transcript itself lives in seed-transcripts.ts to keep this file
  // readable. This file just references the transcript ID.
  transcriptId: string | null;
  hasBeenExtracted: boolean;
  // Call outcome: captured | no_conversation | no_show | rescheduled |
  // placeholder. Undefined/null for seed calls and in-progress rows.
  outcome?: string | null;
  // Meeting type: new_opportunity | existing_customer | internal. Null until
  // classified. Non-opportunity meetings are excluded from the sales pipeline.
  meetingType?: string | null;
};

export type Deal = {
  id: string;
  tenantId: string;       // always "topsort" for now, see CLAUDE.md
  account: string;
  industry: string;
  arr: number;            // annual contract value in USD
  stageKey: string;       // matches Stage.key in scotsman.ts
  daysInStage: number;
  repForecastProbability: number;     // 0.0 to 1.0, what the rep claims
  repForecastCloseDate: string;       // ISO date, what the rep claims
  contacts: Contact[];
  calls: CallRecord[];
  // Prior extraction state. For Lumora this is from Discovery Call #1.
  // For other deals this is just seeded to give the pipeline view shape.
  extraction: ExtractionResult;
  // Rep's free-text notes, what they would have written manually.
  repNotes: string;
  // The rep who owns this deal (their login email), when known. Seeded demo
  // deals leave this null; live Magaya deals carry it from the CRM/calendar.
  repEmail?: string | null;
};

// ============================================================
// The anchor demo deal: Lumora Marketplace
// ============================================================

export const LUMORA_DEAL: Deal = {
  id: "lumora-2026-q2",
  tenantId: "topsort",
  account: "Lumora Marketplace",
  industry: "Online marketplace, home & lifestyle",
  arr: 340000,
  stageKey: "validation",       // rep moved it here, but DealRipe will show
                                 // it shouldn't be at 20% yet
  daysInStage: 23,
  repForecastProbability: 0.70,
  repForecastCloseDate: "2026-06-15",
  contacts: [
    {
      id: "marcus-chen",
      name: "Marcus Chen",
      role: "VP Monetization",
      relationship: "champion",
      lastContactedAt: "2026-04-14",
    },
    {
      id: "priya-raman",
      name: "Priya Raman",
      role: "CTO",
      relationship: "influencer",
      lastContactedAt: "2026-04-08",
    },
    {
      id: "david-kowalski",
      name: "David Kowalski",
      role: "CFO",
      relationship: "economic_buyer",
      lastContactedAt: null,
    },
    {
      id: "sarah-unknown",
      name: "Sarah (last name unknown)",
      role: "CEO",
      relationship: "unknown",
      lastContactedAt: null,
    },
  ],
  calls: [
    {
      id: "lumora-call-1",
      dealId: "lumora-2026-q2",
      date: "2026-04-04",
      durationMinutes: 32,
      participants: ["Jess Tanaka (TopSort)", "Marcus Chen (Lumora)"],
      source: "gong",
      transcriptId: null,            // not used in demo, just here for shape
      hasBeenExtracted: true,
    },
    {
      id: "lumora-call-2",
      dealId: "lumora-2026-q2",
      date: "2026-04-14",
      durationMinutes: 38,
      participants: ["Jess Tanaka (TopSort)", "Marcus Chen (Lumora)"],
      source: "gong",
      transcriptId: "lumora-discovery-2",  // matches seed-transcripts.ts
      hasBeenExtracted: false,             // THIS is what Paul will extract
    },
  ],
  // State from Discovery Call #1 only. Several fields are still Unknown
  // because Jess didn't ask. The new transcript will fill many of them.
  extraction: {
    Sc1: {
      status: "Yes",
      answer: "Sponsored listings, banners, self-serve advertiser portal",
      evidence: "We want to monetize our seller traffic, basically what Poshmark did",
      confidence: 0.85,
      lastUpdatedFromCallId: "lumora-call-1",
    },
    Sc2: { status: "Unknown" },
    C1:  { status: "Unknown" },
    O1:  {
      status: "Yes",
      answer: "Marcus reached out inbound after reading TopSort blog post",
      evidence: "Found you through your post on retail media for marketplaces",
      confidence: 0.95,
      lastUpdatedFromCallId: "lumora-call-1",
    },
    T1:  {
      status: "Yes",
      answer: "Wants to be live before Q4 holiday traffic",
      evidence: "We need to monetize peak Q4 or we're waiting another year",
      confidence: 0.9,
      lastUpdatedFromCallId: "lumora-call-1",
    },
    T2:  { status: "Unknown" },
    T3:  { status: "Unknown" },
    S1:  {
      status: "Yes",
      answer: "$340K ACV agreed in principle for phase one",
      evidence: "Marcus confirmed budget range in initial conversation",
      confidence: 0.8,
      lastUpdatedFromCallId: "lumora-call-1",
    },
    S2:  {
      status: "Yes",
      answer: "8M MAU marketplace, 12K active sellers, ~800 high-volume",
      evidence: "Top 800 sellers do real volume, that's the ad budget pool",
      confidence: 0.95,
      lastUpdatedFromCallId: "lumora-call-1",
    },
    M1:  { status: "No" },
    M2:  { status: "No" },
    M3:  { status: "Unknown" },
    A1:  {
      status: "Yes",
      answer: "Marcus Chen, VP Monetization, ex-Wayfair",
      evidence: "Marcus owns the monetization initiative",
      confidence: 0.95,
      lastUpdatedFromCallId: "lumora-call-1",
    },
    A2:  { status: "No" },
    A3:  { status: "No" },
    A4:  { status: "Unknown" },
    N1:  {
      status: "Yes",
      answer: "Aligns to monetize seller traffic before holiday season",
      evidence: "Sellers begging for sponsored placement, Lumora has no infra",
      confidence: 0.9,
      lastUpdatedFromCallId: "lumora-call-1",
    },
    N2:  { status: "Unknown" },
  },
  repNotes:
    "Marcus is bought in. Phase one scope locked. Need to bring CTO Priya into next meeting for technical deep-dive. Confident on Q2 close.",
};

// ============================================================
// The other 6 deals in the pipeline (static visual context)
// ============================================================
// Each one tells a quick story when Paul scans the pipeline view.
// Story shape: green pipeline with a couple red flags, so DealRipe's
// triage value is visible at a glance.

export const OTHER_DEALS: Deal[] = [
  {
    id: "atlas-2026-q1",
    tenantId: "topsort",
    account: "Atlas Pet Supply",
    industry: "Pet retail, omni-channel",
    arr: 180000,
    stageKey: "negotiation",
    daysInStage: 8,
    repForecastProbability: 0.85,
    repForecastCloseDate: "2026-04-30",
    contacts: [],   // simplified for demo, no need to fill these
    calls: [],
    extraction: makeFullStatus({
      // Healthy deal, all fields green except a soft Authority gap
      M1: "Yes", M2: "Yes", A1: "Yes", A2: "Yes", A3: "Yes", A4: "Unknown",
    }),
    repNotes: "On track. Legal review final pass this week.",
  },
  {
    id: "northwind-2026-q2",
    tenantId: "topsort",
    account: "Northwind Grocers",
    industry: "Grocery, regional chain",
    arr: 520000,
    stageKey: "proposal",
    daysInStage: 41,         // RED FLAG: stuck in stage
    repForecastProbability: 0.60,
    repForecastCloseDate: "2026-05-31",
    contacts: [],
    calls: [],
    extraction: makeFullStatus({
      // Stuck deal, looks like Lumora-shaped problems
      M1: "No", M2: "Unknown", A2: "Unknown", A3: "No",
    }),
    repNotes: "Champion went quiet, trying to re-engage.",
  },
  {
    id: "harbor-2026-q3",
    tenantId: "topsort",
    account: "Harbor Outdoor",
    industry: "Outdoor & sporting goods marketplace",
    arr: 410000,
    stageKey: "signing",
    daysInStage: 4,
    repForecastProbability: 0.95,
    repForecastCloseDate: "2026-04-25",
    contacts: [],
    calls: [],
    extraction: makeFullStatus({}),  // all Yes, clean deal
    repNotes: "Signature expected Friday. CFO approved Tuesday.",
  },
  {
    id: "meridian-2026-q2",
    tenantId: "topsort",
    account: "Meridian Home",
    industry: "Home goods marketplace",
    arr: 275000,
    stageKey: "open",
    daysInStage: 6,
    repForecastProbability: 0.30,
    repForecastCloseDate: "2026-07-15",
    contacts: [],
    calls: [],
    extraction: makeFullStatus({
      // Brand new, only Scope and Need confirmed from the inbound conversation.
      Sc1: "Yes", N1: "Yes",
      Sc2: "Unknown", C1: "Unknown", O1: "Unknown",
      T1: "Unknown", T2: "Unknown", T3: "Unknown",
      S1: "Unknown", S2: "Unknown",
      M1: "Unknown", M2: "Unknown", M3: "Unknown",
      A1: "Unknown", A2: "Unknown", A3: "Unknown", A4: "Unknown",
      N2: "Unknown",
    }),
    repNotes: "Inbound from website, first call scheduled.",
  },
  {
    id: "kestrel-2025-q4",
    tenantId: "topsort",
    account: "Kestrel Apparel",
    industry: "Apparel marketplace",
    arr: 680000,
    stageKey: "negotiation",
    daysInStage: 67,          // BIG RED FLAG: deal is rotting
    repForecastProbability: 0.85,     // rep is still calling it hot
    repForecastCloseDate: "2026-04-30",
    contacts: [],
    calls: [],
    extraction: makeFullStatus({
      M1: "Yes", M2: "No", M3: "No", A2: "No", A3: "No",
      T2: "Unknown", T3: "Unknown",
    }),
    repNotes: "Working through procurement, expecting close end of month.",
  },
];

// ============================================================
// Helper to build extraction state without writing every field
// ============================================================
// Pass an overrides object with the fields that aren't "Yes".
// Everything else gets filled in as Yes with a generic answer.
// This keeps the seed file readable for the 6 context deals.
function makeFullStatus(
  overrides: Partial<Record<string, "Yes" | "No" | "Unknown">>
): ExtractionResult {
  const result: ExtractionResult = {};
  for (const field of SCOTSMAN_FIELDS) {
    const status = overrides[field.id] ?? "Yes";
    if (status === "Yes") {
      result[field.id] = {
        status: "Yes",
        answer: "Confirmed in prior conversation.",
        evidence: "Captured during prior discovery, see call history.",
        confidence: 0.85,
      };
    } else {
      result[field.id] = { status };
    }
  }
  return result;
}

// ============================================================
// Public API: how the rest of the app gets to deals
// ============================================================

export const ALL_DEALS: Deal[] = [LUMORA_DEAL, ...OTHER_DEALS];

export function getDealById(id: string): Deal | undefined {
  return ALL_DEALS.find((d) => d.id === id);
}

export function getStageForDeal(deal: Deal): Stage | undefined {
  return STAGES.find((s) => s.key === deal.stageKey);
}

// ============================================================
// DealRipe's adjusted forecast logic (the demo's intelligence layer)
// ============================================================
// Rule: if a deal is in a stage but has unfilled "required" fields
// for that stage, DealRipe flags it as at-risk and proposes:
//   - Adjusted probability = rep probability * (filled / required)
//   - Adjusted close date = rep close date + (unfilled fields * 14 days)
// This is intentionally simple. Paul will appreciate that it's
// transparent, not a black-box ML model.

export type DealRipeAssessment = {
  filledRequiredFields: number;
  totalRequiredFields: number;
  unfilledFieldIds: string[];
  adjustedProbability: number;
  adjustedCloseDate: string;
  riskLevel: "green" | "amber" | "red";
  riskReasons: string[];
};

export function assessDeal(deal: Deal): DealRipeAssessment {
  const stage = getStageForDeal(deal);
  if (!stage) {
    return {
      filledRequiredFields: 0,
      totalRequiredFields: 0,
      unfilledFieldIds: [],
      adjustedProbability: deal.repForecastProbability,
      adjustedCloseDate: deal.repForecastCloseDate,
      riskLevel: "amber",
      riskReasons: ["Stage not recognized"],
    };
  }

  const unfilled = stage.required.filter(
    (id) => deal.extraction[id]?.status !== "Yes"
  );
  const filled = stage.required.length - unfilled.length;
  const fillRatio = filled / stage.required.length;

  // Adjusted probability: scale down by how much of the required
  // qualification is actually done.
  const adjustedProbability = Math.round(
    deal.repForecastProbability * fillRatio * 100
  ) / 100;

  // Adjusted close date: each unfilled field adds ~2 weeks of likely slip.
  const slipDays = unfilled.length * 14;
  const repDate = new Date(deal.repForecastCloseDate);
  const adjustedDate = new Date(repDate);
  adjustedDate.setDate(adjustedDate.getDate() + slipDays);

  // Risk level: red if Money or Authority gaps, amber if other gaps,
  // green if everything required is filled.
  const moneyAuthorityGaps = unfilled.filter(
    (id) => id.startsWith("M") || id.startsWith("A")
  );
  let riskLevel: "green" | "amber" | "red" = "green";
  const riskReasons: string[] = [];

  if (moneyAuthorityGaps.length > 0) {
    riskLevel = "red";
    if (moneyAuthorityGaps.some((id) => id.startsWith("M"))) {
      riskReasons.push("Budget not confirmed");
    }
    if (moneyAuthorityGaps.some((id) => id.startsWith("A"))) {
      riskReasons.push("Decision authority not engaged");
    }
  } else if (unfilled.length > 0) {
    riskLevel = "amber";
    riskReasons.push(`${unfilled.length} required field(s) still unfilled`);
  }

  // Stuck-in-stage check, regardless of fields
  if (deal.daysInStage > 30 && riskLevel !== "red") {
    riskLevel = "amber";
    riskReasons.push(`Deal stuck in stage for ${deal.daysInStage} days`);
  }
  if (deal.daysInStage > 60) {
    riskLevel = "red";
    riskReasons.push(`Deal stuck in stage for ${deal.daysInStage} days`);
  }

  return {
    filledRequiredFields: filled,
    totalRequiredFields: stage.required.length,
    unfilledFieldIds: unfilled,
    adjustedProbability,
    adjustedCloseDate: adjustedDate.toISOString().split("T")[0],
    riskLevel,
    riskReasons,
  };
}