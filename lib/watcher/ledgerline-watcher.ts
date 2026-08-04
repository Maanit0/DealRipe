/**
 * Ledgerline watcher dataset (tax-workflow software sold to accounting firms).
 *
 * FICTIONAL, Abe-shaped world: early-stage team, huge pipeline per rep, buyers
 * are accountants, land-and-expand revenue, a departed rep whose book hid
 * broken promises, and the variable-pricing "Excel spiral" losing pattern.
 * Every hero fires a detector Abe asked for by name: the second-60-minute-call
 * radar, "this is a 2027 conversation" close-date repair, unanswered questions
 * on a six-figure deal, pilot-signed-no-usage, expansion signals.
 */

import { generateVolumeForecasts } from "./index";
import type { Alert, Commitment, DealForecast, MorningBrief, RepPersona, WatcherDataset, WaterfallWeek, WeeklyReceipt } from "./types";

const STAGE_LABELS = { SQL1: "Discovery", SQL2: "Firm-Wide Demo", SQL3: "Pilot Proposal", SQL4: "Pilot Agreement", SQL5: "Signed" };

// ---------------------------------------------------------------------------
// Reps: small team, mid-ramp, plus the departed rep whose book got inherited.
// ---------------------------------------------------------------------------
const REPS: RepPersona[] = [
  {
    name: "Dana Cole",
    email: "dana@ledgerline.example",
    archetype: "star",
    landsPerHundred: 98,
    calibrationNote: "The long-tenured rep. Calibrated: $100 of Dana's commit lands at ~$98.",
    coachingItems: [],
    scaleThis: "Dana asks the go-live-backwards question ('working back from tax season, when do we need signatures?') on every deal; her deals slip half as often. Scale the phrasing.",
  },
  {
    name: "Sam Reyes",
    email: "sam@ledgerline.example",
    archetype: "new_hire",
    landsPerHundred: 84,
    calibrationNote: "Week 3 of ramp, from the tax industry. Early commits run hot: $100 lands at ~$84 so far (small sample).",
    coachingItems: [
      "2 of his 3 firm-wide demos ran without a managing partner in the room; both stalled after.",
      "When pricing comes up, he quotes the number and stops; the flat-price frame is not landing yet.",
    ],
    scaleThis: "His accountant-to-accountant credibility is real; buyers open up to him fast in discovery.",
  },
  {
    name: "Priya Anand",
    email: "priya@ledgerline.example",
    archetype: "new_hire",
    landsPerHundred: 91,
    calibrationNote: "Week 3 of ramp. $100 lands at ~$91 so far; date optimism, not deal optimism.",
    coachingItems: ["3 deals carry close dates the customer never confirmed on a call."],
    scaleThis: null,
  },
  {
    name: "Miles Grady",
    email: "miles@ledgerline.example",
    archetype: "departed",
    landsPerHundred: 58,
    calibrationNote: "Departed. Book inherited and audited by DealRipe.",
    coachingItems: [],
    scaleThis: null,
  },
];

// ---------------------------------------------------------------------------
// Hero forecasts with probability ledgers
// ---------------------------------------------------------------------------
const HERO_FORECASTS: DealForecast[] = [
  {
    dealId: "ll-harmon-blake",
    account: "Harmon & Blake CPAs",
    rep: "Sam Reyes",
    stageKey: "SQL3",
    amountUsd: 262_000,
    repProbPct: 60,
    repCloseDate: "2026-08-28",
    baselinePct: 50,
    baselineLabel: "Pilot Proposal baseline",
    adjustments: [
      { label: "Call entered the per-return cost-modeling spiral", pts: -16, evidence: "“Let me build a spreadsheet of what this costs per return at our volume before we go further.” — R. Harmon" },
      { label: "Both name partners engaged, need confirmed", pts: 9 },
    ],
    drProbPct: 43,
    drCloseDate: "2026-09-25",
    resolvedProbPct: 62,
    recoverableUsd: 49_780,
    bucket: "needs_you",
  },
  {
    dealId: "ll-caldwell",
    account: "Caldwell Tax Group",
    rep: "Priya Anand",
    stageKey: "SQL2",
    amountUsd: 148_000,
    repProbPct: 55,
    repCloseDate: "2026-09-30",
    baselinePct: 40,
    baselineLabel: "Firm-Wide Demo baseline",
    adjustments: [
      { label: "Customer's own timing: after next tax season", pts: -22, evidence: "“Honestly we wouldn't switch systems until after next season. This is probably a Q2 2027 conversation.” — M. Caldwell" },
      { label: "Strong need confirmed (manual K-1 workflow pain)", pts: 8 },
    ],
    drProbPct: 26,
    drCloseDate: "2027-04-15",
    resolvedProbPct: 30,
    recoverableUsd: 5_920,
    bucket: "being_handled",
  },
  {
    dealId: "ll-whitfield",
    account: "Whitfield & Associates",
    rep: "Sam Reyes",
    stageKey: "SQL2",
    amountUsd: 318_000,
    repProbPct: 45,
    repCloseDate: "2026-09-12",
    baselinePct: 40,
    baselineLabel: "Firm-Wide Demo baseline",
    adjustments: [
      { label: "The wide demo is scheduled: 9 CPAs incl. both managing partners, Thursday", pts: 7, evidence: "60-min firm-wide demo, Thu 1pm, 9 customer attendees" },
      { label: "IT lead not on the invite; integration questions likely", pts: -5 },
    ],
    drProbPct: 42,
    drCloseDate: "2026-09-12",
    resolvedProbPct: 52,
    recoverableUsd: 31_800,
    bucket: "needs_you",
  },
  {
    dealId: "ll-sterling-rowe",
    account: "Sterling Rowe Accounting",
    rep: "Dana Cole",
    stageKey: "SQL4",
    amountUsd: 104_000,
    repProbPct: 85,
    repCloseDate: "2026-08-14",
    baselinePct: 70,
    baselineLabel: "Pilot Agreement baseline",
    adjustments: [
      { label: "Three customer questions unanswered in the inbox for 2 days", pts: -9, evidence: "Data migration, seat count, and SOC 2 questions from T. Sterling, Wed 8:41am. No reply." },
      { label: "Pilot terms agreed verbally", pts: 12 },
    ],
    drProbPct: 73,
    drCloseDate: "2026-08-21",
    resolvedProbPct: 84,
    recoverableUsd: 11_440,
    bucket: "being_handled",
  },
  {
    dealId: "ll-beacon-tax",
    account: "Beacon Tax Partners",
    rep: "Sam Reyes",
    stageKey: "SQL3",
    amountUsd: 176_000,
    repProbPct: 55,
    repCloseDate: "2026-09-05",
    baselinePct: 50,
    baselineLabel: "Pilot Proposal baseline",
    adjustments: [
      { label: "Open commitment: SOC 2 packet promised, 5 days out", pts: -8, evidence: "“I'll send the security documentation by Friday.” — Sam, Jul 24 call" },
      { label: "Champion presenting internally this week", pts: 6 },
    ],
    drProbPct: 53,
    drCloseDate: "2026-09-12",
    resolvedProbPct: 62,
    recoverableUsd: 15_840,
    bucket: "being_handled",
  },
  {
    dealId: "ll-marbury",
    account: "Marbury CPA Group (pilot)",
    rep: "Dana Cole",
    stageKey: "SQL5",
    amountUsd: 96_000,
    repProbPct: 100,
    repCloseDate: "2026-07-17",
    baselinePct: 100,
    baselineLabel: "Pilot signed · activation watched",
    adjustments: [{ label: "Pilot signed 10 days ago; zero logins this week", pts: 0, evidence: "Usage: 4 logins week one, 0 this week. No onboarding call on the calendar." }],
    drProbPct: 100,
    drCloseDate: "2026-07-17",
    resolvedProbPct: 100,
    recoverableUsd: 0,
    bucket: "needs_you",
  },
  {
    dealId: "ll-hale-foster",
    account: "Hale & Foster (customer)",
    rep: "Dana Cole",
    stageKey: "SQL5",
    amountUsd: 132_000,
    repProbPct: 100,
    repCloseDate: "2026-05-08",
    baselinePct: 100,
    baselineLabel: "Live customer · expansion watched",
    adjustments: [{ label: "Expansion signal: second office mentioned on the check-in", pts: 0, evidence: "“Our Scottsdale office is drowning in the same K-1 mess. Forty more preparers over there.” — J. Hale, Jul 28" }],
    drProbPct: 100,
    drCloseDate: "2026-05-08",
    resolvedProbPct: 100,
    recoverableUsd: 0,
    bucket: "watched",
  },
];

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
const ALERTS: Alert[] = [
  {
    id: "la-harmon-spiral",
    detector: "losing_pattern",
    severity: "critical",
    owner: "leader",
    state: "new",
    dealId: "ll-harmon-blake",
    account: "Harmon & Blake CPAs",
    rep: "Sam Reyes",
    amountUsd: 262_000,
    firedAt: "2026-07-30T20:10:00Z",
    title: "Harmon & Blake entered the per-return pricing spiral",
    evidence: "R. Harmon, on yesterday's call: “Let me build a spreadsheet of what this costs per return at our volume before we go further.”",
    why: "You're selling to accountants: the moment pricing reads as variable, they stop evaluating the product and start modeling the invoice. This exact conversation killed 5 of the 6 lost deals in the old book. The counter that works: the flat-per-preparer price card, before their spreadsheet exists.",
    move: "Ten minutes with Sam before his Friday follow-up: hand him the flat-price frame, and take modeling off the customer's plate.",
    action: {
      kind: "brief",
      label: "Open the 10-min debrief",
      detail: "What Harmon said, the 5 lost deals that match the pattern, the flat-per-preparer framing that ended the spiral on won deals, and the exact follow-up email for Sam (drafted): one page, fixed number, 'you'll never model our invoice.'",
    },
    probImpactPts: -16,
  },
  {
    id: "la-whitfield-radar",
    detector: "big_meeting_radar",
    severity: "high",
    owner: "leader",
    state: "new",
    dealId: "ll-whitfield",
    account: "Whitfield & Associates",
    rep: "Sam Reyes",
    amountUsd: 318_000,
    firedAt: "2026-07-31T06:00:00Z",
    title: "The firm-wide demo is Thursday: 9 CPAs, both managing partners",
    evidence: "60-minute demo, Thu 1pm. Attending: 9 from Whitfield incl. both managing partners. Missing: their IT lead, and integration questions came up twice in discovery.",
    why: "This is the make-or-break second call in your motion, and it's Sam's first big-room demo, week 3 of ramp. Deals that clear this call cleanly reach pilot 3x more often.",
    move: "Ten minutes today: review the dossier, decide if you take the first 10 minutes of the demo.",
    action: {
      kind: "brief",
      label: "Open the dossier",
      detail: "Who's coming and who's missing (IT lead), the open gaps, the two integration questions from discovery with the answers, the K-1 workflow moment that has landed in every won demo, and the ask that sets up the pilot.",
    },
    probImpactPts: 7,
  },
  {
    id: "la-marbury-pilot",
    detector: "pilot_inactive",
    severity: "critical",
    owner: "leader",
    state: "escalated",
    dealId: "ll-marbury",
    account: "Marbury CPA Group (pilot)",
    rep: "Dana Cole",
    amountUsd: 96_000,
    firedAt: "2026-07-28T15:00:00Z",
    escalatedAt: "2026-07-30T15:00:00Z",
    title: "Pilot signed 10 days ago, and nobody has logged in this week",
    evidence: "Usage: 4 logins week one, 0 this week. No onboarding call on the calendar. Dana nudged Tuesday; no reply from their side in 48h.",
    why: "A pilot that goes quiet in week two converts at a fraction of the rate, and in a land-and-expand motion this IS the revenue. The recovery that works: a 20-minute working session on their own returns, not a check-in email.",
    move: "Call their pilot champion today and book the working session; Dana's thread has gone as far as email can.",
    action: {
      kind: "ping_rep",
      label: "Coordinate with Dana",
      message: "Dana — Marbury's gone quiet in week two and email's not landing. Want to split it? I'll call Ellen today and offer the 20-minute working session on their own returns; you take the setup once it's booked. This one's the expansion wedge for their other two offices.",
    },
    probImpactPts: 0,
  },
  {
    id: "la-caldwell-timing",
    detector: "timing_statement",
    severity: "high",
    owner: "rep",
    state: "in_flight",
    dealId: "ll-caldwell",
    account: "Caldwell Tax Group",
    rep: "Priya Anand",
    amountUsd: 148_000,
    firedAt: "2026-07-29T18:20:00Z",
    actionedAt: "2026-07-30T09:05:00Z",
    title: "The customer said Q2 2027; the deal says September",
    evidence: "“Honestly we wouldn't switch systems until after next season. This is probably a Q2 2027 conversation.” — M. Caldwell, Jul 29 call. The deal is dated Sep 30 at 55%.",
    why: "Left alone, this inflates the quarter by $81K of weighted fiction and resurfaces every forecast call until someone chases it. Corrected now, the pipeline deflates itself and the deal moves to a nurture cadence.",
    move: "One click: move the close to Apr 15, 2027, set the pre-season re-engage reminder for January.",
    action: {
      kind: "crm_fix",
      label: "Accept the correction",
      field: "CloseDate",
      from: "2026-09-30",
      to: "2027-04-15",
      quote: "“This is probably a Q2 2027 conversation.”",
    },
    probImpactPts: -22,
  },
  {
    id: "la-sterling-questions",
    detector: "unanswered_question",
    severity: "high",
    owner: "rep",
    state: "in_flight",
    dealId: "ll-sterling-rowe",
    account: "Sterling Rowe Accounting",
    rep: "Dana Cole",
    amountUsd: 104_000,
    firedAt: "2026-07-30T08:41:00Z",
    actionedAt: "2026-07-31T07:00:00Z",
    title: "A $104K deal has three questions sitting unanswered for 2 days",
    evidence: "T. Sterling, Wednesday 8:41am: data migration timeline, seat count for seasonal staff, and the SOC 2 report. No reply sent.",
    why: "A buyer at pilot-agreement stage asking implementation questions is trying to buy. Every day of silence here reads as a preview of what support will feel like.",
    move: "Answer all three now; the draft covers each and proposes the signing call.",
    action: {
      kind: "email",
      label: "Approve & send",
      to: "Tom Sterling, Managing Partner, Sterling Rowe Accounting",
      subject: "Your three questions, answered",
      body: "Hi Tom,\n\nSorry for the slow turn, answers below, no fluff:\n\n1. Migration: your last two seasons of returns import in under a week; we run it, not your staff.\n2. Seasonal seats: preparers you add for the season are billed only for the months they're active.\n3. SOC 2: current Type II report attached.\n\nThat was everything open on our side. Want to grab 20 minutes this week to sign the pilot so setup lands before extension season?\n\nBest,\nDana",
    },
    probImpactPts: -9,
  },
  {
    id: "la-beacon-commit",
    detector: "commitment_breach",
    severity: "high",
    owner: "rep",
    state: "in_flight",
    dealId: "ll-beacon-tax",
    account: "Beacon Tax Partners",
    rep: "Sam Reyes",
    amountUsd: 176_000,
    firedAt: "2026-07-29T12:00:00Z",
    actionedAt: "2026-07-30T10:15:00Z",
    title: "Open commitment: the SOC 2 packet, now 5 days out",
    evidence: "“I'll send the security documentation by Friday.” — Sam to A. Osei, Jul 24 call. Nothing sent, and their champion presents internally this week.",
    why: "Their champion is selling for you internally right now, without the packet she promised her partners. Slipped commitments at this exact moment are how internal pitches die quietly.",
    move: "Send the packet with a two-line note. Draft attached.",
    action: {
      kind: "email",
      label: "Approve & send",
      to: "Ama Osei, Director of Operations, Beacon Tax Partners",
      subject: "The security packet I owe you",
      body: "Hi Ama,\n\nThe SOC 2 packet I promised, a few days late, that's on me. Type II report, data-handling summary, and the subprocessor list, all attached.\n\nIf it helps your conversation with the partners this week, I'm happy to be on standby for any security questions, live or over email, same day.\n\nBest,\nSam",
    },
    probImpactPts: -8,
  },
  {
    id: "la-hale-expansion",
    detector: "expansion_signal",
    severity: "info",
    owner: "rep",
    state: "resolved",
    dealId: "ll-hale-foster",
    account: "Hale & Foster (customer)",
    rep: "Dana Cole",
    amountUsd: 132_000,
    firedAt: "2026-07-28T16:30:00Z",
    actionedAt: "2026-07-28T17:45:00Z",
    title: "Expansion signal on the check-in: the Scottsdale office",
    evidence: "“Our Scottsdale office is drowning in the same K-1 mess. Forty more preparers over there.” — J. Hale, Jul 28 check-in.",
    why: "In a land-and-expand motion, this sentence IS the revenue. Expansion mentions followed up within a week convert at 60%; left for the QBR, under 15%.",
    move: "Dana opened the Scottsdale expansion opportunity and sent the intro the same afternoon.",
    action: { kind: "ping_rep", label: "View the thread", message: "Expansion opp created: Hale & Foster Scottsdale, ~40 preparers. Intro sent Jul 28; working session proposed." },
    probImpactPts: 0,
  },
];

// ---------------------------------------------------------------------------
// Commitments
// ---------------------------------------------------------------------------
const COMMITMENTS: Commitment[] = [
  { id: "lc1", dealId: "ll-beacon-tax", side: "rep", who: "Sam Reyes", what: "Send the SOC 2 security packet", madeOn: "2026-07-24", source: "Jul 24 call", quote: "I'll send the security documentation by Friday.", dueBy: "2026-07-26", status: "overdue", alertId: "la-beacon-commit" },
  { id: "lc2", dealId: "ll-sterling-rowe", side: "customer", who: "Tom Sterling", what: "Confirm seasonal seat count for the pilot", madeOn: "2026-07-23", source: "Jul 23 call", quote: "I'll get you our seasonal headcount by early next week.", dueBy: "2026-07-28", status: "overdue" },
  { id: "lc3", dealId: "ll-whitfield", side: "rep", who: "Sam Reyes", what: "Send the integration one-pager before Thursday's demo", madeOn: "2026-07-28", source: "email thread", quote: "I'll get the integration overview to your IT team before the demo.", dueBy: "2026-08-05", status: "open" },
  { id: "lc4", dealId: "ll-harmon-blake", side: "customer", who: "R. Harmon", what: "Share current per-return volumes", madeOn: "2026-07-30", source: "Jul 30 call", quote: "I'll pull our return counts by entity type this week.", dueBy: "2026-08-04", status: "open" },
  { id: "lc5", dealId: "ll-hale-foster", side: "rep", who: "Dana Cole", what: "Intro the Scottsdale office lead", madeOn: "2026-07-28", source: "Jul 28 check-in", quote: "I'll reach out to your Scottsdale lead this week.", dueBy: "2026-07-31", status: "kept", keptAt: "2026-07-28" },
];

// ---------------------------------------------------------------------------
// Waterfall
// ---------------------------------------------------------------------------
const AUTHORED_WEEK: Omit<WaterfallWeek, "startWeightedUsd" | "endWeightedUsd"> = {
  weekOf: "2026-07-27",
  label: "Week of Jul 27",
  movements: [
    { kind: "moved_down", dealId: "ll-harmon-blake", account: "Harmon & Blake CPAs", rep: "Sam Reyes", amountUsd: 262_000, deltaWeightedUsd: -41_900, reason: "The call entered the per-return pricing spiral (Harmon: “let me build a spreadsheet of what this costs per return”). 5 of 6 lost deals died in this exact conversation; intervention queued for you." },
    { kind: "slipped_out", dealId: "ll-caldwell", account: "Caldwell Tax Group", rep: "Priya Anand", amountUsd: 148_000, deltaWeightedUsd: -42_900, reason: "Caldwell's own words: “probably a Q2 2027 conversation.” Close date corrected Sep 30 → Apr 15 off the quote; Priya accepted the fix; January re-engage set. Honest deflation, not slippage discovered in October." },
    { kind: "moved_down", dealId: "ll-marbury", account: "Marbury CPA Group (pilot)", rep: "Dana Cole", amountUsd: 96_000, deltaWeightedUsd: -9_600, reason: "Pilot usage went to zero in week two with no onboarding call booked. Escalated after 48h of customer silence; working-session recovery in motion." },
    { kind: "moved_up", dealId: "ll-sterling-rowe", account: "Sterling Rowe Accounting", rep: "Dana Cole", amountUsd: 104_000, deltaWeightedUsd: 9_400, reason: "Pilot terms agreed verbally on Tuesday's call; the three open questions got answered same-week and the signing call is proposed." },
    { kind: "moved_up", dealId: "ll-whitfield", account: "Whitfield & Associates", rep: "Sam Reyes", amountUsd: 318_000, deltaWeightedUsd: 15_900, reason: "Both managing partners accepted Thursday's firm-wide demo. The make-or-break second call is on the calendar with the right people on it." },
    { kind: "added", dealId: "ll-new-1", account: "Pinnacle Tax Advisors", rep: "Priya Anand", amountUsd: 88_000, deltaWeightedUsd: 17_600, reason: "New inbound from the state society webinar; discovery held Wednesday, K-1 pain confirmed in their words." },
  ],
};

const PRIOR_WEEKS: Array<{ weekOf: string; label: string; movements: WaterfallWeek["movements"]; fallbackDrift?: number }> = [
  {
    weekOf: "2026-07-20",
    label: "Week of Jul 20",
    movements: [
      { kind: "moved_up", dealId: "ll-beacon-tax", account: "Beacon Tax Partners", rep: "Sam Reyes", amountUsd: 176_000, deltaWeightedUsd: 14_100, reason: "Ama Osei committed to presenting internally to the partners; champion motion confirmed on the Jul 24 call." },
      { kind: "closed_won", dealId: "ll-marbury", account: "Marbury CPA Group", rep: "Dana Cole", amountUsd: 96_000, deltaWeightedUsd: -24_000, reason: "Pilot signed Jul 17. Out of open pipeline, into activation, where DealRipe keeps watching (and caught the week-two stall)." },
      { kind: "moved_down", dealId: "ll-vol-fairmont", account: "Fairmont & Craig CPAs", rep: "Priya Anand", amountUsd: 122_000, deltaWeightedUsd: -11_000, reason: "Champion stopped replying after the partner meeting; two nudges out, silence watcher opened." },
    ],
  },
  {
    weekOf: "2026-07-13",
    label: "Week of Jul 13",
    movements: [
      { kind: "added", dealId: "ll-sterling-rowe", account: "Sterling Rowe Accounting", rep: "Dana Cole", amountUsd: 104_000, deltaWeightedUsd: 20_800, reason: "Referral from Hale & Foster; discovery held Jul 15 with the managing partner in the room from call one." },
      { kind: "moved_down", dealId: "ll-vol-grover", account: "Grover Tax & Advisory", rep: "Sam Reyes", amountUsd: 94_000, deltaWeightedUsd: -8_500, reason: "Their IT consultant raised a data-residency question on Jul 16 that went unanswered for four days before the watcher caught it." },
    ],
  },
  { weekOf: "2026-07-06", label: "Week of Jul 6", movements: [], fallbackDrift: 52_000 },
  { weekOf: "2026-06-29", label: "Week of Jun 29", movements: [], fallbackDrift: 61_000 },
  { weekOf: "2026-06-22", label: "Week of Jun 22", movements: [], fallbackDrift: 47_000 },
  { weekOf: "2026-06-15", label: "Week of Jun 15", movements: [], fallbackDrift: 55_000 },
];

// ---------------------------------------------------------------------------
// Receipt + briefs + audit
// ---------------------------------------------------------------------------
const RECEIPT: WeeklyReceipt = {
  weekLabel: "Week of Jul 27",
  commitmentsRecovered: 3,
  closeDatesCorrected: 2,
  slippageCaughtUsd: 188_000,
  playsCoached: 2,
  highlights: [
    "Caldwell's close date corrected off the customer's own 'Q2 2027' words; $43K of weighted fiction deflated before the forecast call, not after.",
    "Sterling Rowe's three stuck questions answered same-week; signing call proposed.",
    "The Marbury pilot's week-two stall caught from usage data and escalated inside 48 hours.",
    "The Harmon & Blake pricing spiral flagged the evening it happened, with the flat-price counter queued for Sam.",
  ],
};

const LEADER_BRIEF: MorningBrief = {
  audience: "leader",
  recipientName: "Abe",
  dateLabel: "Monday, Aug 3 · 7:15 AM",
  subject: "3 things need you · 4 handled overnight · pipeline honest again",
  didOvernight: [
    "Read Friday's 3 calls, updated 24 Salesforce fields with the customers' own words.",
    "Corrected Caldwell's close date off the 'Q2 2027' quote; deflated $43K of weighted fiction, set the January re-engage.",
    "Queued 3 recovery drafts; 2 already approved and sent by the reps.",
  ],
  items: [
    { icon: "alert", text: "Harmon & Blake ($262K): entered the per-return pricing spiral that killed 5 of 6 lost deals. Ten minutes with Sam before Friday.", alertId: "la-harmon-spiral" },
    { icon: "alert", text: "Whitfield ($318K): firm-wide demo Thursday, 9 CPAs, Sam's first big room. Dossier ready; decide if you take the first 10 minutes.", alertId: "la-whitfield-radar" },
    { icon: "alert", text: "Marbury pilot ($96K): zero logins in week two, customer quiet 48h. Needs a call, not another email.", alertId: "la-marbury-pilot" },
    { icon: "done", text: "Everything else is handled: reps actioned their flags, drafts sent, replies watched.", alertId: undefined },
  ],
};

const REP_BRIEF: MorningBrief = {
  audience: "rep",
  recipientName: "Sam",
  dateLabel: "Monday, Aug 3 · 7:00 AM",
  subject: "2 calls today · 1 open commitment · Whitfield demo Thursday",
  didOvernight: [
    "Beacon Tax: your SOC 2 packet email got a reply, Ama wants the data-handling summary walked live; two times proposed.",
    "Whitfield demo brief ready: attendees, the two integration questions with answers, the K-1 moment that wins this room.",
  ],
  items: [
    { icon: "call", text: "11:00 · Harmon & Blake follow-up. Lead with the flat per-preparer price card; do not let the spreadsheet get built.", alertId: "la-harmon-spiral" },
    { icon: "call", text: "3:30 · Beacon Tax working session with Ama, security walkthrough, standby answers loaded.", alertId: "la-beacon-commit" },
  ],
};

const INHERITED_AUDIT = {
  departedRep: "Miles Grady",
  dealsScanned: 52,
  openCommitments: 27,
  atRiskUsd: 1_840_000,
  examples: [
    { account: "Renner & Bosque CPAs", amountUsd: 210_000, what: "Promised the migration plan and reference call “this week”", quote: "“I'll line up the migration plan and a reference firm your size this week.”", daysOverdue: 38 },
    { account: "Coastal Tax Partners", amountUsd: 145_000, what: "Promised revised pricing after the seat-count change", quote: "“Let me rework the numbers for 60 preparers and get that over tomorrow.”", daysOverdue: 29 },
    { account: "Alder & Finch Accounting", amountUsd: 178_000, what: "Promised the SOC 2 report to their IT consultant", quote: "“I'll send the SOC 2 straight to your IT guy today.”", daysOverdue: 44 },
  ],
};

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------
const VOLUME = generateVolumeForecasts({
  seed: 20260801,
  count: 90,
  reps: ["Dana Cole", "Sam Reyes", "Priya Anand", "Miles Grady"],
  accountPrefixes: ["Harding", "Meridian", "Fairmont", "Grover", "Ashworth", "Bellamy", "Crestview", "Donnelly", "Eastlake", "Foster", "Granite", "Hollis", "Ivywood", "Kessler", "Lakeside", "Monarch", "Northfield", "Oakhurst", "Pemberton", "Quincy", "Redwood", "Summit", "Thornton", "Vantage"],
  accountSuffixes: ["CPAs", "& Associates", "Tax Group", "Accounting", "CPA Group", "Tax Advisors", "Tax & Advisory", "& Co CPAs"],
  stages: [
    { key: "SQL1", sharePct: 36, baselinePct: 25, label: "Discovery" },
    { key: "SQL2", sharePct: 28, baselinePct: 40, label: "Firm-Wide Demo" },
    { key: "SQL3", sharePct: 20, baselinePct: 50, label: "Pilot Proposal" },
    { key: "SQL4", sharePct: 12, baselinePct: 70, label: "Pilot Agreement" },
    { key: "SQL5", sharePct: 4, baselinePct: 95, label: "Signed" },
  ],
  amountRange: [60_000, 420_000],
  idPrefix: "ll",
});

const FORECASTS: DealForecast[] = [...HERO_FORECASTS, ...VOLUME];
const DR_WEIGHTED = Math.round(FORECASTS.reduce((s, f) => s + (f.amountUsd * f.drProbPct) / 100, 0));
const THIS_WEEK_DELTA = AUTHORED_WEEK.movements.reduce((s, m) => s + m.deltaWeightedUsd, 0);

const WATERFALL: WaterfallWeek[] = (() => {
  const weeks: WaterfallWeek[] = [
    { ...AUTHORED_WEEK, startWeightedUsd: DR_WEIGHTED - THIS_WEEK_DELTA, endWeightedUsd: DR_WEIGHTED },
  ];
  let end = DR_WEIGHTED - THIS_WEEK_DELTA;
  for (const w of PRIOR_WEEKS) {
    const delta = w.movements.length > 0 ? w.movements.reduce((s, m) => s + m.deltaWeightedUsd, 0) : (w.fallbackDrift ?? 0);
    const start = end - delta;
    weeks.push({ weekOf: w.weekOf, label: w.label, startWeightedUsd: start, endWeightedUsd: end, movements: w.movements });
    end = start;
  }
  return weeks;
})();

export const LEDGERLINE_WATCHER: WatcherDataset = {
  tenantSlug: "ledgerline",
  companyName: "Ledgerline",
  vertical: "Tax workflow software · accounting firms · land-and-expand",
  frameworkName: "Gap-based qualification",
  stageLabels: STAGE_LABELS,
  reps: REPS,
  forecasts: FORECASTS,
  alerts: ALERTS,
  commitments: COMMITMENTS,
  waterfall: WATERFALL,
  receipt: RECEIPT,
  leaderBrief: LEADER_BRIEF,
  repBrief: REP_BRIEF,
  inheritedAudit: INHERITED_AUDIT,
};
