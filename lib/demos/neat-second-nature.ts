// ============================================================
// Isolated demo module: Second Nature (NEAT framework)
// ============================================================
// Self-contained. Imports nothing from scotsman.ts / seed-data.ts /
// any Magaya code, so it cannot affect the live pilot or the TopSort
// demo. Built for the Alisha / Alex Loom: property-management SaaS
// world, NEAT methodology, Zoom cloud-recording source, Salesforce
// writeback, Slack pre-call briefing.
//
// Everything here is representative seed data, not a live integration.

export type NeatStatus = "Yes" | "No" | "Unknown";

export type NeatCategory =
  | "Need"
  | "Economic Impact"
  | "Access to Authority"
  | "Timeline";

export type NeatField = {
  id: string;
  category: NeatCategory;
  question: string;
  // The question a rep would ask to close this gap (NEAT-style discovery).
  ask: string;
};

// NEAT = Need, Economic impact, Access to authority, Timeline.
// Ten sub-questions, the shape of a real qualification sheet.
export const NEAT_FIELDS: NeatField[] = [
  {
    id: "N1",
    category: "Need",
    question: "Has the resident-experience problem been clearly articulated?",
    ask: "What's the resident experience costing you today, in tickets, complaints, or churn?",
  },
  {
    id: "N2",
    category: "Need",
    question: "Is there a specific operational pain tied to the current approach?",
    ask: "Where does your team lose the most time on resident issues that a benefits package would absorb?",
  },
  {
    id: "E1",
    category: "Economic Impact",
    question: "Is the revenue or cost impact quantified per door?",
    ask: "If we cut maintenance tickets and lifted retention, what's that worth per door per year to you?",
  },
  {
    id: "E2",
    category: "Economic Impact",
    question: "Is the ROI tied to a metric ownership already tracks (NOI, retention, ancillary income)?",
    ask: "Which number does ownership judge the portfolio on, and how would this move it?",
  },
  {
    id: "A1",
    category: "Access to Authority",
    question: "Is the economic buyer (owner / principal) identified?",
    ask: "Who signs a contract at this level, and are they aware of this yet?",
  },
  {
    id: "A2",
    category: "Access to Authority",
    question: "Do we have access to the decision process, not just the champion?",
    ask: "Would you be comfortable taking this to the principal without us, or should we be in that room?",
  },
  {
    id: "A3",
    category: "Access to Authority",
    question: "Are finance and ops both engaged, not just the operations lead?",
    ask: "Other than you, who has to be a yes for a portfolio-wide rollout?",
  },
  {
    id: "T1",
    category: "Timeline",
    question: "Is there a compelling event driving the timing?",
    ask: "What's forcing the timing, a renewal, a budget cycle, a portfolio change?",
  },
  {
    id: "T2",
    category: "Timeline",
    question: "Is the rollout / go-live timeline defined?",
    ask: "Working back from go-live, when would we need a signature to hit it?",
  },
  {
    id: "T3",
    category: "Timeline",
    question: "Is the procurement / contracting path known?",
    ask: "Walk me through how a deal this size gets papered and approved on your side.",
  },
];

export type NeatExtractionEntry =
  | {
      status: "Yes";
      answer: string;
      evidence: string; // verbatim quote from the Zoom transcript
      confidence: number;
    }
  | { status: "No" | "Unknown" };

export type NeatExtraction = Record<string, NeatExtractionEntry>;

// The deal being sold: a mid-market property-management company.
export const SECOND_NATURE_DEAL = {
  id: "cascade-2026-q3",
  vendor: "Second Nature",
  account: "Cascade Property Group",
  industry: "Residential property management",
  doors: 9200, // units under management
  carr: 214000, // contracted annual recurring revenue, per-door RBP
  methodology: "NEAT",
  crm: "Salesforce",
  recorder: "Zoom",
  stageLabel: "Evaluation",
  repForecastProbability: 0.75,
  repForecastCloseDate: "2026-08-28",
  // DealRipe's honest read after reading the call:
  adjustedProbability: 0.4,
  adjustedCloseDate: "2026-10-30",
  champion: {
    name: "Dana Whitfield",
    role: "Director of Operations",
    relationship: "champion",
  },
  economicBuyer: {
    name: "Ken Marsh",
    role: "Principal / Owner",
    relationship: "not engaged",
  },
  call: {
    id: "cascade-zoom-2026-07-20",
    date: "2026-07-20",
    durationMinutes: 34,
    source: "Zoom cloud recording",
    participants: ["Alex Rivera (Second Nature)", "Dana Whitfield (Cascade)"],
  },
};

// A short, realistic Zoom transcript. The champion loves the resident
// benefits package for retention and lower maintenance load, but the
// owner who controls budget has never been engaged, and no one has
// put a dollar figure on the impact. That's the extractable story.
export const SECOND_NATURE_TRANSCRIPT = `Alex (Second Nature): Thanks for making time, Dana. Last we talked you were digging into the resident benefits package for the portfolio. Where'd that land?

Dana (Cascade): Honestly the team's excited. The air filter delivery alone would take a real bite out of our maintenance tickets, we're drowning in HVAC calls that are just clogged filters. And the retention angle is the big one for us. Turnover is brutal right now.

Alex: That's the pattern we see. On the filters, most portfolios your size see a meaningful drop in that specific ticket type. On retention, what's turnover running for you?

Dana: It's high, I don't have the exact number in front of me. Enough that we talk about it every ops meeting. Residents leave and the make-ready plus vacancy eats us alive.

Alex: Got it. So if we lifted retention even a few points and cut the filter tickets, that's the value. Have you and I put an actual dollar figure on that yet for the portfolio?

Dana: Not really. I know it's real, I just haven't modeled it out. That's a fair thing to pin down.

Alex: Let's do that. Different question, when it comes time to actually sign something across 9,000-plus doors, who owns that call?

Dana: That'd be Ken, our principal. He's the owner. He hasn't been in any of these conversations yet, it's been me and my ops folks.

Alex: Okay. And how does Ken usually make a call like this?

Dana: He wants the numbers. If I bring him something with a clear return he moves fast, but if it's fuzzy he'll sit on it. So we'd need that impact case tight before I take it to him.

Dana: Timing-wise, we're redoing our resident policy for the new leasing season, so we'd want this live before September renewals really kick off. That's the window.

Alex: That's helpful, that gives us a real date to work back from. Let me pull together next steps.

Dana: Sounds good. I'm bought in, I just need to get Ken there.`;

// State BEFORE this call's extraction (from an earlier intro call).
// Only the surface need is confirmed; everything else is open.
export const NEAT_BEFORE: NeatExtraction = {
  N1: {
    status: "Yes",
    answer: "Resident retention and filter-driven maintenance load flagged as the core pain.",
    evidence: "The retention angle is the big one for us. Turnover is brutal right now.",
    confidence: 0.8,
  },
  N2: { status: "Unknown" },
  E1: { status: "Unknown" },
  E2: { status: "Unknown" },
  A1: { status: "Unknown" },
  A2: { status: "Unknown" },
  A3: { status: "Unknown" },
  T1: { status: "Unknown" },
  T2: { status: "Unknown" },
  T3: { status: "Unknown" },
};

// State AFTER DealRipe reads the Zoom transcript. Need and Timeline
// fill in green from the champion's own words. Economic Impact and
// Access to Authority surface as hard gaps, the two things that
// actually decide this deal.
export const NEAT_AFTER: NeatExtraction = {
  N1: {
    status: "Yes",
    answer: "Retention and filter-driven HVAC tickets are the core operational pain.",
    evidence: "The retention angle is the big one for us. Turnover is brutal right now.",
    confidence: 0.9,
  },
  N2: {
    status: "Yes",
    answer: "Make-ready and vacancy costs from turnover are a recurring ops-meeting topic.",
    evidence: "Residents leave and the make-ready plus vacancy eats us alive.",
    confidence: 0.85,
  },
  E1: { status: "No" },
  E2: { status: "No" },
  A1: {
    status: "Yes",
    answer: "Economic buyer identified: Ken Marsh, principal/owner. Not yet engaged.",
    evidence: "That'd be Ken, our principal. He's the owner. He hasn't been in any of these conversations yet.",
    confidence: 0.9,
  },
  A2: { status: "No" },
  A3: { status: "Unknown" },
  T1: {
    status: "Yes",
    answer: "Compelling event: resident policy refresh ahead of September leasing season.",
    evidence: "We'd want this live before September renewals really kick off. That's the window.",
    confidence: 0.85,
  },
  T2: {
    status: "Yes",
    answer: "Go-live target before September renewals; contract needed ahead of that.",
    evidence: "We're redoing our resident policy for the new leasing season.",
    confidence: 0.75,
  },
  T3: { status: "Unknown" },
};

// Rows written back to Salesforce automatically after the call.
export type WritebackRow = {
  sfField: string; // Salesforce field name
  value: string;
  evidence: string;
};

export const SALESFORCE_WRITEBACK: WritebackRow[] = [
  {
    sfField: "Primary_Need__c",
    value: "Resident retention + filter-driven HVAC ticket load",
    evidence: "The retention angle is the big one for us. Turnover is brutal right now.",
  },
  {
    sfField: "Economic_Buyer__c",
    value: "Ken Marsh (Principal / Owner) — not yet engaged",
    evidence: "That'd be Ken, our principal. He hasn't been in any of these conversations yet.",
  },
  {
    sfField: "Compelling_Event__c",
    value: "Live before September renewals (leasing-season policy refresh)",
    evidence: "We'd want this live before September renewals really kick off.",
  },
  {
    sfField: "Next_Step__c",
    value: "Build per-door impact model; get principal (Ken) into next session",
    evidence: "I'm bought in, I just need to get Ken there.",
  },
  {
    sfField: "NEAT_Gaps__c",
    value: "Economic Impact not quantified; economic buyer not engaged",
    evidence: "Not really. I know it's real, I just haven't modeled it out.",
  },
];

// The pre-call briefing DealRipe pushes to the rep for the NEXT call,
// delivered in Slack. No new tool to log into.
export const SLACK_BRIEFING = {
  channel: "Slack · direct message to Alex Rivera",
  when: "Pushed 30 min before the next Cascade call",
  deal: "Cascade Property Group · 9,200 doors · $214K CARR",
  objective:
    "Quantify the per-door economic impact and get the principal, Ken Marsh, into the room. The deal cannot close on the champion alone.",
  questions: [
    "If we lifted retention a few points and cut filter tickets, what's that worth per door per year across the portfolio?",
    "Which number does Ken judge the portfolio on, and how would this move it? Let's build that one-pager together.",
    "What would make you comfortable getting Ken on the next call, and would you rather introduce us or have us frame it?",
  ],
  risk: "If this call doesn't produce a dollar figure and a path to Ken, the September go-live slips to next leasing season, and Dana can't move Ken on a fuzzy case. She told us so.",
};
