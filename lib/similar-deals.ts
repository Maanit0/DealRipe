// ============================================================
// Similar deals and plays (demo intelligence layer)
// ============================================================
// Powers the "How deals like this were won and lost" card on the
// TopSort demo deal inspection view. This is STATIC demo data, keyed
// by the seed-data deal id. Real pilots (Magaya) never read this file.
//
// Design intent (see product notes): the actionable unit is the
// recurring OBJECTION and its resolution, scoped by account similarity,
// grounded in a real won-deal quote and outcome, with the losing
// pattern surfaced so reps avoid it. The tied insight connects the
// segment's loss pattern to THIS deal's open gaps.

export type SimilarOutcome = "won" | "lost";

export type SimilarAccount = {
  name: string;
  descriptor: string;
  arr: number;
  outcome: SimilarOutcome;
};

export type ObjectionPlay = {
  id: string;
  /** The objection in the customer's own language. */
  objection: string;
  /** How often this shows up in the segment. */
  frequency: string;
  /** The winning move, one line. */
  winningPlay: string;
  /** Account where this play won. */
  provenAt: string;
  /** Verbatim customer quote from the won deal. */
  evidenceQuote: string;
  /** What the win looked like. */
  outcome: string;
  /** The handling pattern that correlated with losses. */
  losingPattern: string;
  // ---- Optional fields consumed by the learning-engine view ----
  // These let the "how it learns" module render a worked rule from the
  // same objection data the similar-deals card uses, so both features
  // tell one story. The similar-deals card ignores them.
  /** How much this signal moves the model, e.g. "+16 points". */
  weight?: string;
  /** Wins that used the winning behavior, e.g. { count: 7, total: 9 }. */
  wonEvidence?: { count: number; total: number };
  /** Losses that used it, e.g. { count: 1, total: 4 }. */
  lostEvidence?: { count: number; total: number };
  /** The concrete move it now fires to the rep. */
  prescription?: string;
  /** Punchy one-liner for the "what it just learned" feed. */
  insight?: string;
};

export type SimilarDealsIntel = {
  dealId: string;
  /** One-line profile the current account matches on. */
  profileLabel: string;
  wonCount: number;
  lostCount: number;
  /** Closed deals this was learned from. */
  trainedOn: number;
  references: SimilarAccount[];
  objections: ObjectionPlay[];
  /** Callout tying the segment's loss pattern to this deal's gaps. */
  tiedInsight: string;
};

const INTEL: Record<string, SimilarDealsIntel> = {
  "lumora-2026-q2": {
    dealId: "lumora-2026-q2",
    profileLabel:
      "Home and lifestyle marketplace, seller-traffic monetization, VP Monetization champion",
    wonCount: 3,
    lostCount: 1,
    trainedOn: 34,
    references: [
      {
        name: "Maison Market",
        descriptor: "Home and lifestyle marketplace",
        arr: 420000,
        outcome: "won",
      },
      {
        name: "Poshvale",
        descriptor: "Apparel and resale marketplace",
        arr: 610000,
        outcome: "won",
      },
      {
        name: "GreenElm Goods",
        descriptor: "Home goods marketplace",
        arr: 300000,
        outcome: "won",
      },
      {
        name: "Tradewell",
        descriptor: "General merchandise marketplace",
        arr: 380000,
        outcome: "lost",
      },
    ],
    objections: [
      {
        id: "seller-demand",
        objection:
          "Our sellers are mostly long tail. I am not sure enough of them will actually buy ads.",
        frequency: "Raised in 6 of your last 9 marketplace deals",
        winningPlay:
          "Anchor on the top high-volume sellers, not the whole base. Pilot ad demand with the sellers already spending on growth.",
        provenAt: "Maison Market",
        evidenceQuote:
          "We assumed the long tail would not spend. The top 5% of sellers funded the entire program in month one.",
        outcome: "Won $420K, expanded to a phase two the next quarter.",
        losingPattern:
          "Reps who pitched the full seller base up front stalled. The buyer could not model where demand would come from and pushed the deal to next year.",
        weight: "+16 points",
        wonEvidence: { count: 7, total: 9 },
        lostEvidence: { count: 1, total: 4 },
        prescription:
          "Before the next call, pull the top 800 seller spend and lead with the concentrated ad-budget pool. Do not pitch the long tail.",
        insight:
          "Anchoring on top high-volume sellers beats pitching the long tail: +16 points on marketplace deals.",
      },
      {
        id: "buyer-experience",
        objection:
          "I do not want sponsored listings to wreck the browse experience for buyers.",
        frequency: "Raised in 5 of your last 9 marketplace deals",
        winningPlay:
          "Lead with native ad formats and relevance controls, and show the buyer-experience metrics that held flat. Do not open with ad load.",
        provenAt: "Poshvale",
        evidenceQuote:
          "The moment I saw conversion and session length hold flat with ads on, my product team stopped blocking it.",
        outcome: "Won $610K after a two-week buyer-experience readout.",
        losingPattern:
          "Pitching more ad units as more revenue spooked product-led buyers. The deals that died led with monetization upside instead of buyer safeguards.",
        weight: "+22 points",
        wonEvidence: { count: 5, total: 6 },
        lostEvidence: { count: 2, total: 5 },
        prescription:
          "Open with native ad formats and the flat buyer-experience metrics. Offer a two-week experience readout before any ad-load conversation.",
        insight:
          "Leading with buyer-experience proof before ad load: +22 points, and product stops blocking the deal.",
      },
      {
        id: "build-in-house",
        objection: "Our CTO thinks we can just build this ourselves.",
        frequency: "Raised in 4 of your last 9 marketplace deals",
        winningPlay:
          "Do not debate feature parity. Reframe to engineering opportunity cost and Q4 timing, and offer the CTO a session on the self-serve advertiser portal.",
        provenAt: "GreenElm Goods",
        evidenceQuote:
          "Once we priced our own eng time against missing Q4, build in-house stopped making sense.",
        outcome: "Won $300K, the CTO became the internal sponsor.",
        losingPattern:
          "Arguing your platform beats their engineers feature by feature lost every time. It turns the CTO into an opponent instead of a sponsor.",
        weight: "+11 points",
        wonEvidence: { count: 4, total: 5 },
        lostEvidence: { count: 2, total: 4 },
        prescription:
          "Offer the CTO a session on the self-serve advertiser portal. Frame it as engineering opportunity cost against Q4, not feature parity.",
        insight:
          "Reframing build in-house to eng opportunity cost against Q4 turns the CTO into a sponsor.",
      },
    ],
    tiedInsight:
      "The one deal like this that you lost, Tradewell, died the same way: the CFO was never engaged and it stalled in procurement at the finish. Lumora's CFO David Kowalski is still untouched and the CEO has not been looped in. Close the Money and Authority gaps before this looks like Tradewell.",
  },
};

export function getSimilarDealsIntel(
  dealId: string,
): SimilarDealsIntel | undefined {
  return INTEL[dealId];
}

// ============================================================
// Learning-engine view: one shared story
// ============================================================
// The "how DealRipe learns" module renders its worked rule and its
// "what it just learned" feed from the SAME objection data the
// similar-deals card uses, so the two demo surfaces stay coherent.

export type LearnedRule = {
  id: string;
  label: string;
  objection: string;
  frequency: string;
  provenAt: string;
  evidenceQuote: string;
  outcome: string;
  rule: string;
  weight: string;
  won: { count: number; total: number };
  lost: { count: number; total: number };
  prescription: string;
};

export type LearningData = {
  workedRules: LearnedRule[];
  insights: string[];
  tiedInsight: string | null;
};

const RULE_LABELS: Record<string, string> = {
  "seller-demand": "Sellers too small",
  "buyer-experience": "Buyer experience",
  "build-in-house": "Build in-house",
};

const DEMO_INTEL_KEY = "lumora-2026-q2";

export function getLearningData(
  dealId: string = DEMO_INTEL_KEY,
): LearningData {
  const intel = getSimilarDealsIntel(dealId);
  if (!intel) return { workedRules: [], insights: [], tiedInsight: null };

  const workedRules: LearnedRule[] = intel.objections.map((o) => ({
    id: o.id,
    label: RULE_LABELS[o.id] ?? o.provenAt,
    objection: o.objection,
    frequency: o.frequency,
    provenAt: o.provenAt,
    evidenceQuote: o.evidenceQuote,
    outcome: o.outcome,
    rule: o.winningPlay,
    weight: o.weight ?? "+14 points",
    won: o.wonEvidence ?? { count: 6, total: 8 },
    lost: o.lostEvidence ?? { count: 1, total: 4 },
    prescription: o.prescription ?? o.winningPlay,
  }));

  const fromObjections = intel.objections
    .map((x) => x.insight)
    .filter((s): s is string => Boolean(s));

  const generic = [
    "Confirming budget in writing correlated with 1.8x more closed Money-gated deals.",
    "Multithreading a second stakeholder before Validation cut slip rate by a third.",
    "A champion gone quiet past 7 days is the single biggest late-stage slip signal.",
    "Economic buyer engaged by day 30 now weighted heavily on win probability.",
  ];

  return {
    workedRules,
    insights: [...fromObjections, ...generic],
    tiedInsight: intel.tiedInsight,
  };
}
