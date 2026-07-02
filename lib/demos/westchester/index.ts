import type { ForecastTenant } from "../types";

/**
 * Westchester Publishing Services -- prospect demo for Tyler Carey (CRO).
 *
 * Built from his own discovery call. The world is editorial/production services
 * for book publishers, sold on Scotsman-style qualification. The numbers reflect
 * what he told us: a small key-account sales team, a 6 to 8 month lag from signed
 * work to recognized revenue, conservative forecasting, and his single most
 * painful failure pattern -- the c-suite buys in but a middle-management gate
 * (usually the production director) quietly kills or stalls the deal.
 *
 * No live data, no integrations. Static pitch artifact only.
 */
export const WESTCHESTER: ForecastTenant = {
  slug: "westchester",
  name: "Westchester Publishing Services",
  product: "Editorial and production services for book publishers",
  framework: "Scotsman",
  weekOf: "Jun 29, 2026",
  lastUpdatedAgo: "9 minutes ago",
  changedCount: 3,
  numbers: {
    quarterTargetUsd: 3_200_000,
    quarterLabel: "Q3 2026",
    ripeForecastUsd: 2_140_000,
    repCommitUsd: 2_760_000,
  },
  movements: [
    {
      id: "halliwell",
      account: "Halliwell Press",
      industry: "Mid-size trade publisher",
      productContext: "Full-service editorial + typesetting, moving off incumbent",
      arr: 480_000,
      rep: "Dana Whitfield",
      status: "at_risk",
      repProb: 85,
      repQuarter: "Q3 2026",
      repDate: "Aug 14, 2026",
      lastProb: 62,
      lastQuarter: "Q4 2026",
      lastDate: "Oct 9",
      thisProb: 46,
      thisQuarter: "Q4 2026",
      thisDate: "Oct 23",
      delta: -16,
      reason:
        "Publisher and COO bought in on the full suite. The production director, who controls when work actually moves off the incumbent, has never been confirmed as a decision authority. Authority gap unmapped at the exact tier that has killed deals like this before.",
      convinceMe: 46,
    },
    {
      id: "sourcebend",
      account: "Sourcebend Media",
      industry: "Mid-size trade publisher",
      productContext: "Existing account, full production on fall list",
      arr: 360_000,
      rep: "Dana Whitfield",
      status: "stalled",
      repProb: 70,
      repQuarter: "Q3 2026",
      repDate: "Sep 2, 2026",
      lastProb: 58,
      lastQuarter: "Q4 2026",
      lastDate: "Nov 4",
      thisProb: 52,
      thisQuarter: "Q4 2026",
      thisDate: "Nov 18",
      delta: -6,
      reason:
        "Not a buying problem. Client-side delay. Two acquisitions held up in legal and an author manuscript slipped, so the expected volume has not arrived. Revenue will land a quarter later than the rep booked it.",
      convinceMe: 52,
    },
    {
      id: "beacon-quill",
      account: "Beacon & Quill",
      industry: "Key account, illustrated nonfiction",
      productContext: "Upsell: accessibility + PDF production they do in-house",
      arr: 290_000,
      rep: "Priya Nadkarni",
      status: "at_risk",
      repProb: 60,
      repQuarter: "Q3 2026",
      repDate: "Aug 28, 2026",
      lastProb: 44,
      lastQuarter: "Q4 2026",
      lastDate: "Oct 16",
      thisProb: 33,
      thisQuarter: "Q4 2026",
      thisDate: "Oct 30",
      delta: -11,
      reason:
        "C-suite sees the cost case. The in-house manager who owns this work treats her own time as a free soft cost, so the savings math does not land for her. Same middle-tier stall pattern. Need-payoff never reframed at her level.",
      convinceMe: 33,
    },
    {
      id: "ardent",
      account: "Ardent House",
      industry: "Independent publisher",
      productContext: "Complex projects priced at 3x standard for margin",
      arr: 220_000,
      rep: "Tyler Carey",
      status: "healthy",
      repProb: 80,
      repQuarter: "Q3 2026",
      repDate: "Jul 31, 2026",
      lastProb: 72,
      lastQuarter: "Q3 2026",
      lastDate: "Aug 7",
      thisProb: 88,
      thisQuarter: "Q3 2026",
      thisDate: "Jul 31",
      delta: 16,
      reason:
        "Sold to the publisher directly, top of the company. Buyer confirmed authority to move the work immediately. Surprise win flagged early so ops can staff for it instead of scrambling after signature.",
      convinceMe: 88,
    },
    {
      id: "mariner",
      account: "Mariner Trade Books",
      industry: "Large key account",
      productContext: "Renewal + expansion across imprints",
      arr: 540_000,
      rep: "Dana Whitfield",
      status: "healthy",
      repProb: 92,
      repQuarter: "Q3 2026",
      repDate: "Jul 18, 2026",
      lastProb: 90,
      lastQuarter: "Q3 2026",
      lastDate: "Jul 18",
      thisProb: 93,
      thisQuarter: "Q3 2026",
      thisDate: "Jul 18",
      delta: 3,
      reason:
        "Annuity work. Economic buyer aligned, production team aligned, schedule confirmed. DealRipe flags this as a clean commit, not a hope.",
      convinceMe: 93,
    },
    {
      id: "thornfield",
      account: "Thornfield Academic",
      industry: "University press",
      productContext: "Cold RFP, no buying signals yet",
      arr: 165_000,
      rep: "Priya Nadkarni",
      status: "at_risk",
      repProb: 35,
      repQuarter: "Q3 2026",
      repDate: "Sep 30, 2026",
      lastProb: 18,
      lastQuarter: "Q4 2026",
      lastDate: "Dec 4",
      thisProb: 10,
      thisQuarter: "Q4 2026",
      thisDate: "Dec 11",
      delta: -8,
      reason:
        "Cold RFP with no qualified champion and no engaged buyer after three touches. Sitting at the floor probability until a real buying signal appears, instead of inflating the pipeline.",
      convinceMe: 10,
    },
  ],
  leverage: [
    {
      account: "Halliwell Press",
      action:
        "Get the production director into a working session this week and qualify their real authority. Ask the SPIN problem question: when this moves off the incumbent, what changes for your team day to day. That surfaces whether they are a driver or a gate before the deal slips again.",
      impacts: [
        { label: "Close probability", value: "+19 points" },
        { label: "Close date pulled in", value: "21 days" },
        { label: "Weighted forecast", value: "+$91K", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "Deals at this account shape that mapped middle-management authority before close converted at roughly double the rate of those that did not.",
    },
    {
      account: "Beacon & Quill",
      action:
        "Reframe the value at the in-house manager's level, not the c-suite's. Quantify her 50 hours a week against the blended production rate so the soft cost becomes a real number she owns. This is a need-payoff conversation, not another exec pitch.",
      impacts: [
        { label: "Close probability", value: "+15 points" },
        { label: "Weighted forecast", value: "+$44K", bold: true },
      ],
      confidence: "Medium",
      confidenceNote:
        "Upsells stalled at the middle tier historically recover when the cost case is reframed in the blocker's own workload.",
    },
    {
      account: "Sourcebend Media",
      action:
        "Get a written volume commitment for the fall list and confirm the revised author and legal timeline. The work is won. The job now is to forecast the lag accurately so ops staffs to the real date, not the optimistic one.",
      impacts: [
        { label: "Forecast accuracy", value: "Corrected by one quarter" },
        { label: "Capacity planning", value: "Avoids an over-staff", bold: true },
      ],
      confidence: "High",
      confidenceNote:
        "Client-side delays at mid-size publishers cluster around acquisitions and author timing, both visible 60 to 90 days out when asked for directly.",
    },
    {
      account: "Thornfield Academic",
      action:
        "Qualify for a real buying signal on the next touch or disqualify and reclaim the rep's time. With 80 to 100 open opportunities per rep, a cold RFP with no champion is a time sink, not a forecast line.",
      impacts: [
        { label: "Rep time reclaimed", value: "Redeployed to top 20%" },
        { label: "Forecast hygiene", value: "Removes a phantom", bold: true },
      ],
      confidence: "Medium",
      confidenceNote:
        "Cold RFPs without a buying signal by the third touch close in the single digits.",
    },
  ],
  leverageSummary:
    "Two of these deals are not buying problems, they are visibility problems. Halliwell and Beacon & Quill are both stalling at the exact middle-management tier that has surprised you before, and DealRipe flagged it weeks before the quarterly checkpoint would have. Acting on all four this week lifts the forecast toward $2.46M and, just as important, tells ops where to staff.",
  calibration: {
    ripeAccuracyPct: 89,
    ripeDeviationUsd: 41_000,
    ripeDeviationFloorUsd: 240_000,
    repAccuracyPct: 61,
    repOvercommitUsd: 420_000,
    dealsTrainedOn: 180,
  },
};
