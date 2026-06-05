// Aware, Inc. demo variant. Self-contained data, no Supabase, no API.
// Configured for Brian Krause's call. DUCT framework, biometrics deals.
//
// Brian's exact phrasing is preserved in gate descriptions and label copy.
// Em-dashes converted to commas/periods per project rule.

export type DuctKey = "D" | "U" | "C" | "T";
export type GateStatus = "green" | "yellow" | "red";

export type GateDefinition = {
  key: DuctKey;
  letter: string;
  name: string;
  description: string; // Brian's framing
  lookFor: string;     // what we extract from calls
};

export const DUCT: Record<DuctKey, GateDefinition> = {
  D: {
    key: "D",
    letter: "D",
    name: "Decision Authority",
    description:
      "Does this person have the juice to move it forward, or do we need to surround the deal? Nobody buys alone, nobody sells alone.",
    lookFor:
      "Stakeholder identified, title verified, multi-threading status (1 contact, 2 to 3, or 4+).",
  },
  U: {
    key: "U",
    letter: "U",
    name: "Use Case",
    description:
      "How specifically will they use the technology? Is this actually a problem we can solve, or are they trying to do something we weren't designed for?",
    lookFor:
      "Current state described, specific workflow articulated, dislikes about current solution captured.",
  },
  C: {
    key: "C",
    letter: "C",
    name: "Competition",
    description:
      "Is this a compete project? Who else is on the list? Back into it. Never ask directly.",
    lookFor:
      "Competitive set inferred, incumbent named, displacement vs net new identified.",
  },
  T: {
    key: "T",
    letter: "T",
    name: "Timing",
    description:
      "Are they trying to solve a problem that hurts now, or is this 2027 planning? How much does it hurt?",
    lookFor:
      "Compelling event identified, internal deadline captured, urgency level (high, medium, low) backed by quote.",
  },
};

export const DUCT_ORDER: DuctKey[] = ["D", "U", "C", "T"];

// ============================================================
// Deals
// ============================================================

export type Gate = {
  key: DuctKey;
  status: GateStatus;
  evidence: { speaker: string; quote: string; callDate: string }[];
  missing: string[];
};

export type AwareDeal = {
  id: string;
  account: string;
  vertical: string;
  arr: number;
  repName: string;
  champion: string;
  championRole: string;
  championAuthorityNote: string;
  // Forecast comparison
  repCloseQuarter: string;
  repCloseDate: string;
  ripeCloseQuarter: string;
  ripeCloseDate: string;
  forecastDeltaLabel: string;
  forecastDiscrepancyNote: string | null;
  // The story this deal tells
  headline: string;
  repNotes: string;
  // Optional per-deal score override and interpretation
  convinceMeScore?: number;          // 0..100; overrides computed paranoiaScore if set
  scoreInterpretation?: string;      // overrides the tier-based default text
  // Gate state
  gates: Record<DuctKey, Gate>;
  // Derived narrative
  whatYouDontKnow: string[];
  nextStepQuestions: string[];
};

export const DEALS: AwareDeal[] = [
  // ---------------------------------------------------------
  // 1. U.S. Customs Border Modality Program
  //    Federal RFP, missing decision authority, single threaded into
  //    the technical lead.
  // ---------------------------------------------------------
  {
    id: "us-customs",
    account: "U.S. Customs Border Modality Program",
    vertical: "Federal, border identification",
    arr: 1200000,
    repName: "Jimmy Park",
    champion: "Adam Reyes",
    championRole: "Contracting Officer Technical Representative",
    championAuthorityNote:
      "Adam is the technical lead on the RFP. He cannot sign a $1.2M federal contract. The contracting officer and Operations program lead must approve.",
    repCloseQuarter: "Q3 2026",
    repCloseDate: "Aug 15, 2026",
    ripeCloseQuarter: "Q4 2026",
    ripeCloseDate: "Nov 30, 2026",
    forecastDeltaLabel: "Slips one quarter at minimum",
    forecastDiscrepancyNote:
      "Federal procurement on a $1.2M contract is 60 to 90 days minimum after RFP award. Rep's Aug 15 close ignores the procurement window even if the RFP picks Aware.",
    headline:
      "Rep is single-threaded into the IT lead on a $1.2M federal RFP for AwareABIS multi-modal deployment at high-volume crossings. Contracting officer and Operations program lead have not been touched.",
    repNotes:
      "Adam is bought in on technical fit. RFP closes Aug 15. Contract execution late Q3.",
    convinceMeScore: 25,
    scoreInterpretation:
      "Most gates open or contradicted. Stop forecasting this deal until you close gaps.",
    gates: {
      D: {
        key: "D",
        status: "red",
        evidence: [],
        missing: [
          "Adam Reyes is Contracting Officer Technical Representative, not the contracting officer. He has no signing authority on $1M+ contracts.",
          "The contracting officer has not been engaged on any of the four calls so far.",
          "Operations program lead, who owns checkpoint workflows day to day, has never been on a call.",
          "Multi-threading: 1 contact.",
        ],
      },
      U: {
        key: "U",
        status: "yellow",
        evidence: [
          {
            speaker:
              "Adam Reyes (Contracting Officer Technical Representative)",
            quote:
              "Our current Idemia system is generating too many false positives at high-traffic crossings.",
            callDate: "Mar 22, 2026",
          },
        ],
        missing: [
          "No specific volume requirements captured (transactions per hour at peak crossing times).",
          "No integration requirements with existing checkpoint systems.",
          "False positive rate target unspecified.",
        ],
      },
      C: {
        key: "C",
        status: "yellow",
        evidence: [
          {
            speaker:
              "Adam Reyes (Contracting Officer Technical Representative)",
            quote: "We're evaluating three vendors total. You're one of them.",
            callDate: "Mar 22, 2026",
          },
        ],
        missing: [
          "Other two vendors not named.",
          "Evaluation criteria for the RFP not shared.",
          "Incumbent (Idemia) displacement timeline unclear.",
        ],
      },
      T: {
        key: "T",
        status: "green",
        evidence: [
          {
            speaker:
              "Adam Reyes (Contracting Officer Technical Representative)",
            quote:
              "We need this signed by September 30 or the budget rolls over to next year.",
            callDate: "Mar 22, 2026",
          },
        ],
        missing: [],
      },
    },
    whatYouDontKnow: [
      "You don't know who has signing authority. Adam is the technical lead. This is a $1.2M federal contract. The contracting officer must approve.",
      "You don't know if procurement has been engaged. Federal procurement on contracts this size is 60 to 90 days. The RFP closes August 15.",
      "You don't know who the other two vendors are.",
      "You don't know what the Operations program lead thinks. They run the checkpoints day to day. Nobody has talked to them.",
    ],
    nextStepQuestions: [
      "Walk me through federal procurement on a $1.2M contract. Who's the contracting officer and when do we get in front of them?",
      "Who is going to operate this system day to day at the checkpoints? I'd love to get them in a room before the RFP closes so we can validate fit.",
      "We hear you're evaluating two other vendors. I want to make sure I'm helping you compare on the right axes. Who else is on the list?",
    ],
  },

  // ---------------------------------------------------------
  // 2. Banco Patagonia
  //    LATAM retail bank. Head of Digital says yes. Procurement and
  //    CFO have not been touched. Fiscal year ends December, not June.
  // ---------------------------------------------------------
  {
    id: "banco-patagonia",
    account: "Banco Patagonia",
    vertical: "Retail bank, Latin America",
    arr: 480000,
    repName: "Erica Klein",
    champion: "Adriana Vega",
    championRole: "Head of Digital Channels",
    championAuthorityNote:
      "Adriana drives digital transformation but does not sign procurement contracts above $250K. CFO and procurement lead must approve.",
    repCloseQuarter: "Q2 2026",
    repCloseDate: "Jun 28, 2026",
    ripeCloseQuarter: "Q3 2026",
    ripeCloseDate: "Sep 12, 2026",
    forecastDeltaLabel: "Slips one quarter",
    forecastDiscrepancyNote:
      "Customer said 'before our fiscal close' on April 7 call. Rep logged Q2 close. Banco Patagonia fiscal year ends in December, not June. Procurement adds 60 to 90 days on Knomi-scale contracts at this customer size.",
    headline:
      "Rep has signal from Head of Digital that customer wants Knomi mobile authentication live 'before fiscal close.' Procurement and CFO have not been engaged. Banco Patagonia fiscal year ends in December, not June.",
    repNotes:
      "Adriana wants this in production before fiscal close. Mobile rollout is her top priority. Closing Q2.",
    convinceMeScore: 60,
    scoreInterpretation: "Most gates evidenced. Read the discrepancy note.",
    gates: {
      D: {
        key: "D",
        status: "yellow",
        evidence: [
          {
            speaker: "Adriana Vega (Head of Digital Channels)",
            quote: "I drive the digital roadmap and Knomi fits the 2026 plan.",
            callDate: "Apr 07, 2026",
          },
        ],
        missing: [
          "CFO not engaged. Procurement not engaged.",
          "Adriana's signing authority above $250K not verified.",
          "Multi-threading: 1 contact.",
        ],
      },
      U: {
        key: "U",
        status: "green",
        evidence: [
          {
            speaker: "Adriana Vega (Head of Digital Channels)",
            quote:
              "We need Knomi for our mobile-first onboarding rollout across all retail branches.",
            callDate: "Apr 07, 2026",
          },
          {
            speaker: "Adriana Vega (Head of Digital Channels)",
            quote:
              "Our remote onboarding drop-off is at 31 percent. We need to get this below 15.",
            callDate: "Apr 07, 2026",
          },
        ],
        missing: [],
      },
      C: {
        key: "C",
        status: "green",
        evidence: [
          {
            speaker: "Adriana Vega (Head of Digital Channels)",
            quote:
              "We've also evaluated FaceTec, and Oz Forensics did a pilot with our retail team.",
            callDate: "Apr 07, 2026",
          },
        ],
        missing: [],
      },
      T: {
        key: "T",
        status: "yellow",
        evidence: [
          {
            speaker: "Adriana Vega (Head of Digital Channels)",
            quote: "We want this in production before our fiscal close.",
            callDate: "Apr 07, 2026",
          },
        ],
        missing: [
          "Banco Patagonia fiscal year ends December 31. Rep is forecasting Jun 28. Mismatch.",
          "Procurement cycle for Banco Patagonia not modeled in rep forecast.",
        ],
      },
    },
    whatYouDontKnow: [
      "You don't know if Adriana has procurement sign-off above $250K at Banco Patagonia. Most LATAM banks require CFO approval at this contract size.",
      "You don't know when Banco Patagonia procurement starts the vendor qualification cycle. Default is 60 to 90 days.",
      "You don't know what the customer means by 'fiscal close.' Banco Patagonia FY ends December 31.",
    ],
    nextStepQuestions: [
      "Walk me through procurement at Banco Patagonia for software contracts at $500K. Who else needs to sign off, and how long does that typically take?",
      "You mentioned 'fiscal close.' For planning, is that Banco Patagonia's December 31 close, or is there a Knomi production deadline tied to a different date?",
      "You mentioned FaceTec and Oz Forensics. Where did each of them fall short, and what's the displacement timeline for the incumbent if there is one?",
    ],
  },

  // ---------------------------------------------------------
  // 3. Pinnacle Health Network
  //    DEA EPCS compliance. Customer needs on-device Knomi D, rep
  //    scoped server-side Knomi S. Architecture mismatch.
  // ---------------------------------------------------------
  {
    id: "pinnacle-health",
    account: "Pinnacle Health Network",
    vertical: "Healthcare, multi-state hospital network",
    arr: 310000,
    repName: "Jimmy Park",
    champion: "David Kowalski",
    championRole: "VP Clinical Informatics",
    championAuthorityNote:
      "David has CTO sign-off authority for clinical tech under $500K. Authority is clean. The product fit is the problem.",
    repCloseQuarter: "Q2 2026",
    repCloseDate: "Jun 30, 2026",
    ripeCloseQuarter: "Q3 2026 at earliest",
    ripeCloseDate: "Only if re-scoped to Knomi D",
    forecastDeltaLabel: "Likely re-scope to Knomi D or disqualification",
    forecastDiscrepancyNote:
      "Customer requires on-device Knomi D for EPCS DEA compliance. Rep scoped server-side Knomi S. This is a hard architecture mismatch, not a configuration choice.",
    headline:
      "Customer requires on-device Knomi D for EPCS DEA compliance. Rep scoped server-side Knomi S in the proposal. Architecture mismatch on a HIPAA-regulated prescriber authentication workflow.",
    repNotes:
      "David is enthusiastic. EPCS audit is non-negotiable. Closing Q2 with Knomi S deployment.",
    convinceMeScore: 50,
    scoreInterpretation:
      "Half the story is missing or contradicted by evidence.",
    gates: {
      D: {
        key: "D",
        status: "green",
        evidence: [
          {
            speaker: "David Kowalski (VP Clinical Informatics)",
            quote:
              "I have sign-off for clinical tech under five hundred, full stop.",
            callDate: "Apr 02, 2026",
          },
          {
            speaker: "David Kowalski (VP Clinical Informatics)",
            quote:
              "I'm the one bringing this to the EPCS compliance review. The CMO defers to me on technical fit.",
            callDate: "Apr 02, 2026",
          },
        ],
        missing: [],
      },
      U: {
        key: "U",
        status: "red",
        evidence: [
          {
            speaker: "David Kowalski (VP Clinical Informatics)",
            quote:
              "We need biometric authentication for every controlled-substance prescription, per DEA EPCS.",
            callDate: "Apr 02, 2026",
          },
        ],
        missing: [
          "DEA EPCS requires on-device matching. Rep scoped Knomi S (server-side). This is a hard architecture mismatch.",
          "No prototype, sandbox, or pilot has validated Knomi D fits Pinnacle's existing prescriber workflow.",
          "Rep has not raised the architecture mismatch with the customer.",
        ],
      },
      C: {
        key: "C",
        status: "yellow",
        evidence: [
          {
            speaker: "David Kowalski (VP Clinical Informatics)",
            quote:
              "We have Imprivata today and we're not happy with the authentication speed at the bedside.",
            callDate: "Apr 02, 2026",
          },
        ],
        missing: [
          "Imprivata displacement timeline not captured.",
          "Whether Pinnacle is also evaluating other DEA EPCS vendors not confirmed.",
        ],
      },
      T: {
        key: "T",
        status: "yellow",
        evidence: [
          {
            speaker: "David Kowalski (VP Clinical Informatics)",
            quote:
              "Our next DEA audit is in Q4. We want this in place before then.",
            callDate: "Apr 02, 2026",
          },
        ],
        missing: [
          "Specific DEA audit date not captured.",
          "No business consequence captured if audit slips into Q1 2027.",
        ],
      },
    },
    whatYouDontKnow: [
      "You don't know if Jimmy understands the difference between Knomi D and Knomi S. The proposal scoped server-side. DEA EPCS compliance requires on-device matching.",
      "You don't know what Pinnacle's current EPCS vendor is, and what it would take to displace them. Imprivata is the most common incumbent in this segment.",
      "You don't know when Pinnacle's next DEA audit is. That's the real compelling event, and it has not been anchored in the deal.",
    ],
    nextStepQuestions: [
      "Walk me through prescriber authentication at Pinnacle today. At the bedside, what does that workflow look like end to end? We need to confirm Knomi D fits before we go further.",
      "When is your next DEA EPCS audit? If we work backward from that date, what's the latest we can be in production?",
      "You're on Imprivata today. What would it take to displace them? Is there a contract end date or escape clause?",
    ],
  },
];

// ============================================================
// Reps (UNCHANGED per spec)
// ============================================================

export type Rep = {
  id: string;
  name: string;
  initials: string;
  scores: Record<DuctKey, number>; // 0..1, share of deals where this gate is filled with evidence
  winRate: number;                  // 0..1
  weakness: DuctKey;
  weaknessNote: string;             // one-line, sales-leader voice
};

export const REPS: Rep[] = [
  {
    id: "jimmy",
    name: "Jimmy Park",
    initials: "JP",
    scores: { D: 0.33, U: 0.78, C: 0.71, T: 0.65 },
    winRate: 0.22,
    weakness: "D",
    weaknessNote:
      "Jimmy single-threads. He'll close the IT champion and forecast the deal, then procurement walks in and the date slips three months.",
  },
  {
    id: "erica",
    name: "Erica Klein",
    initials: "EK",
    scores: { D: 0.88, U: 0.80, C: 0.75, T: 0.41 },
    winRate: 0.38,
    weakness: "T",
    weaknessNote:
      "Erica gets multi-threaded fast. She also forecasts every deal current quarter. Customer said \"year end\" and she heard \"this Friday.\"",
  },
  {
    id: "marcus",
    name: "Marcus Webb",
    initials: "MW",
    scores: { D: 0.90, U: 0.87, C: 0.84, T: 0.80 },
    winRate: 0.51,
    weakness: "D", // least weak; weakness is statistical not narrative
    weaknessNote:
      "Marcus is the closest thing to a clean DUCT operator on the team. Win rate is double Jimmy's.",
  },
];

// ============================================================
// Helpers
// ============================================================

export function paranoiaScore(deal: AwareDeal): number {
  // If a per-deal score is set, use it. Otherwise compute from gates.
  if (typeof deal.convinceMeScore === "number") return deal.convinceMeScore;
  const greenWithEvidence = DUCT_ORDER.filter((k) => {
    const g = deal.gates[k];
    return g.status === "green" && g.evidence.length > 0;
  }).length;
  return Math.round((greenWithEvidence / DUCT_ORDER.length) * 100);
}

export function getDealById(id: string): AwareDeal | undefined {
  return DEALS.find((d) => d.id === id);
}

export function formatMoney(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${v}`;
}

export function formatPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

// Salesforce-style field names that DUCT writes back.
export const SALESFORCE_FIELD_MAP: Record<DuctKey, string> = {
  D: "DUCT_Decision_Authority__c",
  U: "DUCT_Use_Case__c",
  C: "DUCT_Competition__c",
  T: "DUCT_Timing__c",
};
