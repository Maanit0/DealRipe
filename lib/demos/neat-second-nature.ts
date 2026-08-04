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

// The deal being sold: a mid-market property-management company. Reskinned
// to Rowan Hill Residential, a real account off Alisha's own board,
// so the deal inspection matches the deal the Forecast Room flags.
export const SECOND_NATURE_DEAL = {
  id: "lowry-hill-2026-q3",
  vendor: "Second Nature",
  account: "Rowan Hill Residential",
  industry: "Residential property management",
  doors: 400, // units under management
  carr: 137242, // contracted annual recurring revenue, per-door RBP
  methodology: "NEAT",
  crm: "Salesforce",
  recorder: "Zoom",
  stageLabel: "Evaluation",
  repForecastProbability: 0.7,
  repForecastCloseDate: "2026-07-27",
  // DealRipe's honest read after reading the call:
  adjustedProbability: 0.35,
  adjustedCloseDate: "2026-10-09",
  champion: {
    name: "Renee Alvarez",
    role: "Director of Operations",
    relationship: "champion",
  },
  economicBuyer: {
    name: "Greg Hollis",
    role: "Principal / Owner",
    relationship: "not engaged",
  },
  call: {
    id: "lowry-hill-zoom-2026-07-21",
    date: "2026-07-21",
    durationMinutes: 31,
    source: "Zoom cloud recording",
    participants: ["Casey Boyd (Second Nature)", "Renee Alvarez (Rowan Hill)"],
  },
};

// A short, realistic Zoom transcript. The champion loves the resident
// benefits package for retention and lower maintenance load, and came off
// a failed Beagle rollout, but the owner who controls budget has never been
// engaged, and no one has put a dollar figure on the impact. That's the
// extractable story: strong Need, open Economic Impact and Authority.
export const SECOND_NATURE_TRANSCRIPT = `Casey (Second Nature): Thanks for making time, Renee. Last we talked you were digging into the resident benefits package for the 400 doors. Where'd that land?

Renee (Rowan Hill): Honestly the team's excited. The air filter delivery alone would take a real bite out of our maintenance tickets, we're drowning in HVAC calls that are just clogged filters. And the retention angle is the big one for us. Turnover is brutal right now.

Casey: That's the pattern we see. I know you tried Beagle before, what happened there?

Renee: It was a bad experience, honestly. Residents complained, the rollout was messy, and we pulled it. So there's some scar tissue internally about doing another one of these.

Casey: That's fair, and I want to make sure whatever went wrong there is the first thing we get right. On retention, what's turnover running for you?

Renee: It's high, I don't have the exact number in front of me. Enough that we talk about it every ops meeting. Residents leave and the make-ready plus vacancy eats us alive.

Casey: Got it. So if we lifted retention even a few points and cut the filter tickets, that's the value. Have you and I put an actual dollar figure on that yet for the portfolio?

Renee: Not really. I know it's real, I just haven't modeled it out. That's a fair thing to pin down.

Casey: Let's do that. Different question, when it comes time to actually sign something across the 400 doors, who owns that call?

Renee: That'd be Greg, our principal. He's the owner. He hasn't been in any of these conversations yet, it's been me and my ops folks.

Casey: Okay. And how does Greg usually make a call like this?

Renee: He wants the numbers. If I bring him something with a clear return he moves fast, but if it's fuzzy he'll sit on it. Especially after Beagle, he'll want to know why this one's different. So we'd need that impact case tight before I take it to him.

Renee: Timing-wise, we're redoing our resident policy for the new leasing season, so we'd want this live before September renewals really kick off. That's the window.

Casey: That's helpful, that gives us a real date to work back from. Let me pull together next steps.

Renee: Sounds good. I'm bought in, I just need to get Greg there.`;

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
    answer: "Economic buyer identified: Greg Hollis, principal/owner. Not yet engaged.",
    evidence: "That'd be Greg, our principal. He's the owner. He hasn't been in any of these conversations yet.",
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

// Rows written back to Salesforce automatically after the call. Grouped so
// the demo shows the SPECIFIC opportunity sub-fields DealRipe keeps current,
// the exact fields a sales leader fills today by pasting a transcript into a
// Claude project. "Standard" = native Salesforce opportunity fields;
// "Qualification" = the custom NEAT fields on the opportunity record.
export type WritebackRow = {
  sfField: string; // Salesforce API field name
  label: string; // human label
  value: string;
  evidence: string; // verbatim quote, or a short rationale for standard fields
  group: "Standard" | "Qualification";
  state: "new" | "updated"; // newly filled vs refreshed
  gap?: boolean; // true if this field is written as an open gap (red)
};

export const SALESFORCE_WRITEBACK: WritebackRow[] = [
  // Standard Salesforce opportunity fields
  {
    sfField: "StageName",
    label: "Stage",
    value: "Evaluation (unchanged)",
    evidence: "No stage-advancing commitment was made on the call.",
    group: "Standard",
    state: "updated",
  },
  {
    sfField: "CloseDate",
    label: "Close date",
    value: "2026-10-09  (was 2026-07-27)",
    evidence: "Cannot close without the owner engaged; DealRipe moved the date to Q4.",
    group: "Standard",
    state: "updated",
  },
  {
    sfField: "NextStep",
    label: "Next step",
    value: "Quantify per-door impact; get principal (Greg) into the next session",
    evidence: "I'm bought in, I just need to get Greg there.",
    group: "Standard",
    state: "updated",
  },
  {
    sfField: "Amount",
    label: "Net new CARR",
    value: "$137,242 (400 doors)",
    evidence: "RBP across the 400 doors.",
    group: "Standard",
    state: "updated",
  },
  // Custom NEAT qualification fields on the opportunity
  {
    sfField: "Primary_Pain__c",
    label: "Need / pain",
    value: "Resident retention + filter-driven HVAC ticket load",
    evidence: "The retention angle is the big one for us. Turnover is brutal right now.",
    group: "Qualification",
    state: "new",
  },
  {
    sfField: "Metrics__c",
    label: "Metric ownership tracks",
    value: "Retention + make-ready / vacancy cost per door",
    evidence: "Residents leave and the make-ready plus vacancy eats us alive.",
    group: "Qualification",
    state: "new",
  },
  {
    sfField: "Economic_Impact__c",
    label: "Economic impact (per door)",
    value: "Not yet quantified — open gap",
    evidence: "Not really. I know it's real, I just haven't modeled it out.",
    group: "Qualification",
    state: "new",
    gap: true,
  },
  {
    sfField: "Economic_Buyer__c",
    label: "Economic buyer",
    value: "Greg Hollis (Principal / Owner) — not engaged",
    evidence: "That'd be Greg, our principal. He hasn't been in any of these conversations yet.",
    group: "Qualification",
    state: "new",
    gap: true,
  },
  {
    sfField: "Decision_Process__c",
    label: "Decision / authority path",
    value: "Champion only; no access to the owner yet",
    evidence: "It's been me and my ops folks.",
    group: "Qualification",
    state: "new",
    gap: true,
  },
  {
    sfField: "Competition__c",
    label: "Competition / incumbent",
    value: "Beagle — prior failed rollout; must differentiate on resident experience",
    evidence: "It was a bad experience, honestly. Residents complained, the rollout was messy, and we pulled it.",
    group: "Qualification",
    state: "new",
  },
  {
    sfField: "Why_Now__c",
    label: "Why now / compelling event",
    value: "Live before September renewals (leasing-season policy refresh)",
    evidence: "We'd want this live before September renewals really kick off.",
    group: "Qualification",
    state: "new",
  },
  {
    sfField: "Mutual_Action_Plan__c",
    label: "Mutual action plan",
    value: "Not set — no agreed steps back from go-live",
    evidence: "No close plan was confirmed on the call.",
    group: "Qualification",
    state: "new",
    gap: true,
  },
  {
    sfField: "Key_Stakeholders__c",
    label: "Key stakeholders",
    value: "Renee Alvarez (champion, Dir Ops); Greg Hollis (economic buyer, not engaged)",
    evidence: "It's been me and my ops folks.",
    group: "Qualification",
    state: "updated",
  },
];

// After the call, DealRipe re-reads the deal and updates its own forecast and
// predicted close date, the number that flows straight into the sales
// leader's Forecast Board. This is the link between the AE's call and the
// leader's pipeline: the AE does nothing, the forecast self-corrects.
export const FORECAST_UPDATE = {
  repProb: 0.7,
  ripeProb: 0.35,
  repClose: "Jul 27, 2026",
  ripeClose: "Oct 9, 2026",
  repQuarter: "Q3 2026",
  ripeQuarter: "Q4 2026",
  reason:
    "Two NEAT gaps decide this deal and both are open: the per-door impact is not quantified, and the owner who signs a portfolio-wide switch has never been on a call. Deals at this door count do not close without the owner engaged, so DealRipe holds the number down and moves the date to Q4 until that changes. The moment Greg joins a call and the impact case lands, the forecast moves back up on its own.",
};

// The account's meeting history, and where each call left the qualification.
// Gong shows you the calls; DealRipe shows you what each one did and did not
// close, and rolls it into the next briefing.
export type MeetingHistoryItem = {
  date: string;
  title: string;
  filled: string[];
  gaps: string[];
  note: string;
  current?: boolean;
};

export const MEETING_HISTORY: MeetingHistoryItem[] = [
  {
    date: "Jun 30, 2026",
    title: "Intro call",
    filled: ["Need — retention + filter tickets"],
    gaps: ["Economic impact", "Authority", "Timeline"],
    note: "Champion surfaced the pain. Nothing quantified, owner not discussed.",
  },
  {
    date: "Jul 21, 2026",
    title: "Evaluation call",
    filled: ["Need confirmed", "Timeline — September renewals", "Competition — Beagle context"],
    gaps: ["Economic impact (per-door $)", "Authority (owner not engaged)"],
    note: "Timeline set and the Beagle history surfaced, but the two gaps that decide the deal opened: no dollar figure, and the owner has never been on a call.",
    current: true,
  },
];

// The pre-call briefing DealRipe pushes to the rep for the NEXT call,
// delivered in Slack. No new tool to log into. The questions are not
// generic NEAT prompts, they are the moves your top reps actually make
// on a deal like this, phrased the way they ask them: quantify per-door,
// get the owner in the room (consent to sell), turn the failed incumbent
// into differentiation, and set a mutual close plan back from go-live.
export const SLACK_BRIEFING = {
  channel: "Slack · direct message to Casey Boyd",
  when: "Pushed 30 min before the next Rowan Hill call",
  deal: "Rowan Hill Residential · 400 doors · $137K CARR · switching off Beagle",
  objective:
    "Put a per-door number on the impact and get the principal, Greg Hollis, into the room. This portfolio-wide switch cannot close on Renee alone, and the failed Beagle rollout has to become the reason to choose you, not a reason to do nothing.",
  questions: [
    "Renee, if we lifted retention even two points and cut the filter tickets, what's that worth per door per year across the 400? Let's put a real number on it, because you said Greg won't move on a fuzzy case.",
    "You said Greg signs a call this size. What would make you comfortable getting him on the next 30 minutes with us, and would you rather introduce us or have us frame the numbers for you?",
    "When Beagle didn't work, what specifically broke for your residents? I want that to be the first thing we prove, not something Greg raises later.",
    "If the per-door case lands with Greg, what has to be true to be live before September renewals, and can we agree the steps back from that date today?",
  ],
  risk: "If this call doesn't produce a per-door number and a path to Greg, the September go-live slips to next leasing season. Renee can't move the owner on a fuzzy case, and the Beagle scar becomes a reason to stall. She told us both.",
};
