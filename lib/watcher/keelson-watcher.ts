/**
 * Keelson watcher dataset (freight and customs software / Rolldog / Salesforce).
 *
 * FICTIONAL, and deliberately so. Keelson is the neutral demo tenant: a
 * mid-market logistics software company selling to freight forwarders, customs
 * brokers and 3PLs. The vertical is chosen precisely because it is nobody's
 * vertical in the room, so a prospect can see the mechanism without us guessing
 * at their industry and getting it wrong.
 *
 * THE ONE RULE FOR THIS FILE: every hero number here must equal what
 * getForecastRoom computes from the database for the same deal. /review derives
 * probability from gate coverage against real seeded transcripts; this file is
 * the explanation layer on top of it, not a second opinion. When the two
 * disagree, a prospect clicks from Forecast to Forecast Room, sees one deal
 * carrying two probabilities, and correctly stops believing both. The contact
 * names below are the seeded contacts, not invented ones, for the same reason.
 *
 * Four of the eight move DOWN and four move UP or hold. A tool that only ever
 * says no is a tool a sales leader learns to ignore.
 */

import type { Alert, Commitment, DealForecast, MorningBrief, RepPersona, WatcherDataset, WaterfallWeek, WeeklyReceipt } from "./types";

// ---------------------------------------------------------------------------
// Reps. The calibration numbers are the point of this block: "of every $100
// this rep commits, what actually lands" is the per-rep memory a forecast call
// runs on today from the leader's gut, and nowhere in writing.
// ---------------------------------------------------------------------------
const REPS: RepPersona[] = [
  {
    name: "Dana Reyes",
    email: "dana@keelson.example",
    archetype: "star",
    landsPerHundred: 101,
    calibrationNote: "Calls it straight, with a shade of upside. $100 of Dana's commit lands at ~$101 over 9 quarters.",
    coachingItems: ["Sent Cascade's pricing while Elena Voss, the only person who can approve it, was still declining invites. Her one repeatable leak."],
    scaleThis: "Dana gets the signer into the room by the second call on 8 of 10 deals; the team does it on 3. Her exec-invite ask converts at twice the team rate.",
  },
  {
    name: "Tom Fielding",
    email: "tom@keelson.example",
    archetype: "over_committer",
    landsPerHundred: 74,
    calibrationNote: "Commits on enthusiasm rather than evidence. $100 of Tom's commit lands at ~$74 across 8 quarters.",
    coachingItems: [
      "Delmar is still filed at 50% for September with 3 of 27 gates confirmed and the economic buyer unreachable.",
      "When a call no-shows he emails once and waits. His median rebook time is 11 days; the team's is 2.",
    ],
    scaleThis: "His discovery on entry-filing pain is the sharpest on the team. The customer quotes he pulls do most of the selling later.",
  },
  {
    name: "Priya Nair",
    email: "priya@keelson.example",
    archetype: "sandbagger",
    landsPerHundred: 93,
    calibrationNote: "The dollars land, a quarter later than she says. $100 of her commit lands at ~$93 in-quarter, ~$106 by the following one.",
    coachingItems: ["Three of her deals carry close dates set before the last customer conversation about timing."],
    scaleThis: "She is the only rep who consistently gets the finance stakeholder onto a call before proposal. Harborview is this week's example.",
  },
  {
    name: "Alex Moreno",
    email: "alex@keelson.example",
    archetype: "new_hire",
    landsPerHundred: 96,
    calibrationNote: "Calibrated so far, on a small sample. Month 4 of ramp; $100 commits land at ~$96.",
    coachingItems: ["Summit changed hands to a new Director of Operations and the deal has not been re-qualified from the top. Day 62 in a 34-day stage."],
    scaleThis: null,
  },
  {
    name: "Ben Ackerly",
    email: "ben@keelson.example",
    archetype: "departed",
    landsPerHundred: 66,
    calibrationNote: "Left Jun 26. Book inherited and audited by DealRipe the same week.",
    coachingItems: [],
    scaleThis: null,
  },
];

// ---------------------------------------------------------------------------
// Hero forecasts: the eight real Keelson opportunities. baselinePct plus the
// adjustments sums to drProbPct, and drProbPct equals what /review computes.
// A leader can argue with any single line, which is the reason it is decomposed
// instead of being handed over as a score.
// ---------------------------------------------------------------------------
const HERO_FORECASTS: DealForecast[] = [
  {
    dealId: "keelson-cascade-freight",
    account: "Cascade Freight Systems",
    rep: "Dana Reyes",
    stageKey: "SQL3",
    amountUsd: 420_000,
    repProbPct: 85,
    repCloseDate: "2026-10-15",
    baselinePct: 60,
    baselineLabel: "Proposal Validation · new business baseline",
    adjustments: [
      { label: "Go-live date confirmed by the customer, unprompted", pts: 6, evidence: "“We need it live before the Q4 peak, that date works.”" },
      { label: "Elena Voss (VP Operations) signs anything over 250K and declined last week's working session", pts: -8, evidence: "Named as the approver on Jul 20: “Our VP signs off on anything over 250K.” Declined the invite; no calendar record on any of the seven calls." },
      { label: "Single-threaded on Ray Delgado, the operations manager", pts: -4, evidence: "Ray is the only Cascade name on every call and the only one carrying this internally." },
    ],
    drProbPct: 54,
    drCloseDate: "2026-12-29",
    resolvedProbPct: 72,
    recoverableUsd: 75_600,
    bucket: "needs_you",
  },
  {
    dealId: "keelson-pacific-cargo",
    account: "Pacific Cargo Group",
    rep: "Priya Nair",
    stageKey: "SQL3",
    amountUsd: 320_000,
    repProbPct: 50,
    repCloseDate: "2026-09-20",
    baselinePct: 60,
    baselineLabel: "Proposal Validation · new business baseline",
    adjustments: [
      { label: "Budget range stated and fit confirmed on the record", pts: 5, evidence: "“We have room for something in that band this year.”" },
      { label: "Sandra Ng named their incumbent WMS as a live alternative and it was never countered", pts: -28, evidence: "On the demo: “We're also looking at what our WMS vendor is putting out.” No displacement question was asked, and no competitive counter has been scheduled since." },
      { label: "No dated next step on the record", pts: -9 },
      { label: "Priya's close dates run a quarter early", pts: -6 },
    ],
    drProbPct: 22,
    drCloseDate: "2026-12-04",
    resolvedProbPct: 50,
    recoverableUsd: 89_600,
    bucket: "needs_you",
  },
  {
    dealId: "keelson-delmar-customs",
    account: "Delmar Customs Brokerage",
    rep: "Tom Fielding",
    stageKey: "SQL2",
    amountUsd: 180_000,
    repProbPct: 50,
    repCloseDate: "2026-09-30",
    baselinePct: 45,
    baselineLabel: "Solution Finalization · new business baseline",
    adjustments: [
      { label: "Marcus Hale, president and economic buyer, no-showed the scoping call", pts: -15, evidence: "Jul 27, 2:00pm. No cancellation, no reschedule on the calendar." },
      { label: "No answer to the follow-up email in nine days", pts: -12 },
      { label: "Budget was never put on a call", pts: -6, evidence: "3 of 27 gates confirmed. Budget is not one of them." },
      { label: "Tom's commit calibration", pts: -6, evidence: "$100 of his commit lands at ~$74." },
    ],
    drProbPct: 6,
    drCloseDate: "2026-12-14",
    resolvedProbPct: 33,
    recoverableUsd: 48_600,
    bucket: "being_handled",
  },
  {
    dealId: "keelson-summit-logistics",
    account: "Summit Logistics",
    rep: "Alex Moreno",
    stageKey: "SQL2",
    amountUsd: 250_000,
    repProbPct: 35,
    repCloseDate: "2026-11-30",
    baselinePct: 45,
    baselineLabel: "Solution Finalization · new business baseline",
    adjustments: [
      { label: "Dana Whitfield, their new Director of Operations, only just took the deal over", pts: -12, evidence: "The original champion moved to the network side. Nothing has been re-qualified with Dana." },
      { label: "62 days in a stage that closes in 34 when it closes", pts: -9 },
      { label: "Procurement still not engaged; every won deal this size had them by day 40", pts: -12 },
    ],
    drProbPct: 12,
    drCloseDate: "2027-02-13",
    resolvedProbPct: 40,
    recoverableUsd: 70_000,
    bucket: "needs_you",
  },
  {
    dealId: "keelson-vantage-supply",
    account: "Vantage Supply Chain",
    rep: "Priya Nair",
    stageKey: "SQL3",
    amountUsd: 210_000,
    repProbPct: 35,
    repCloseDate: "2026-08-12",
    baselinePct: 60,
    baselineLabel: "Proposal Validation · new business baseline",
    adjustments: [
      { label: "Every touch is with Maya Okonkwo, VP Supply Chain and sole contact", pts: -18, evidence: "One name on every call, every thread, for the life of the deal." },
      { label: "No second stakeholder has joined a call or replied to email", pts: -10 },
      { label: "Last activity of any kind was five days ago, with a close date of Aug 12", pts: -6 },
    ],
    drProbPct: 26,
    drCloseDate: "2026-08-12",
    resolvedProbPct: 60,
    recoverableUsd: 71_400,
    bucket: "needs_you",
  },
  {
    dealId: "keelson-anchor-freight",
    account: "Anchor Freight Forwarding",
    rep: "Dana Reyes",
    stageKey: "SQL4",
    amountUsd: 510_000,
    repProbPct: 92,
    repCloseDate: "2026-08-08",
    baselinePct: 80,
    baselineLabel: "Negotiations · new business baseline",
    adjustments: [
      { label: "Every gate confirmed with a customer quote behind it", pts: 8, evidence: "25 of 27 gates closed on evidence rather than on a rep's assertion." },
      { label: "Tom Bianchi, the COO, is engaged and legal is cleared", pts: 4, evidence: "In the room on the Jul 15 and Jul 22 calls; redlines returned with two comments on notice periods." },
      { label: "Signing date not yet locked, so the discount holds until it is", pts: -7 },
    ],
    drProbPct: 85,
    drCloseDate: "2026-08-08",
    resolvedProbPct: 92,
    recoverableUsd: 35_700,
    bucket: "watched",
  },
  {
    dealId: "keelson-harborview-freight",
    account: "Harborview Freight",
    rep: "Priya Nair",
    stageKey: "SQL3",
    amountUsd: 380_000,
    repProbPct: 55,
    repCloseDate: "2026-09-25",
    baselinePct: 60,
    baselineLabel: "Proposal Validation · new business baseline",
    adjustments: [
      { label: "Nadia Brandt, their CFO, joined last week's call and put the budget on the record", pts: 12, evidence: "“It's in the operations capital line for this year, so the money exists.”" },
      { label: "Every gate but legal confirmed on evidence", pts: 8, evidence: "20 of 27 gates closed; 1 open for Proposal Validation." },
      { label: "Close date confirmed by the customer, not inferred", pts: 4 },
      { label: "Legal review named but not yet on a calendar", pts: -4 },
    ],
    drProbPct: 80,
    drCloseDate: "2026-09-25",
    resolvedProbPct: 84,
    recoverableUsd: 15_200,
    bucket: "watched",
  },
  {
    dealId: "keelson-tidewater-distribution",
    account: "Tidewater Distribution",
    rep: "Priya Nair",
    stageKey: "SQL2",
    amountUsd: 290_000,
    repProbPct: 35,
    repCloseDate: "2026-10-05",
    baselinePct: 45,
    baselineLabel: "Solution Finalization · new business baseline",
    adjustments: [
      { label: "A second stakeholder joined Tuesday's call, unprompted by us", pts: 10, evidence: "Renata Cole, VP Finance, joined without being on the invite. Owen Marsh brought her." },
      { label: "Budget confirmed on the record", pts: 8, evidence: "“We've got somewhere between 300 and 500 thousand set aside.”" },
      { label: "Competition gate still open", pts: -3 },
    ],
    drProbPct: 60,
    drCloseDate: "2026-10-05",
    resolvedProbPct: 63,
    recoverableUsd: 8_700,
    bucket: "watched",
  },
];

// ---------------------------------------------------------------------------
// Alerts. Each one is a detector firing on a specific deal, with the quote that
// triggered it, the outcome history that makes it matter here, the move, and
// the artifact already drafted. The STATE is what makes the feed readable as an
// immune system rather than a list of complaints.
// ---------------------------------------------------------------------------
const ALERTS: Alert[] = [
  // ---- NEEDS YOU ----
  {
    id: "kl-cascade-eb",
    detector: "uninvited_stakeholder",
    severity: "critical",
    owner: "leader",
    state: "escalated",
    dealId: "keelson-cascade-freight",
    account: "Cascade Freight Systems",
    rep: "Dana Reyes",
    amountUsd: 420_000,
    firedAt: "2026-07-31T07:10:00Z",
    escalatedAt: "2026-08-04T07:10:00Z",
    title: "The person who signs this declined the working session, and pricing is already out",
    evidence:
      "Ray Delgado on Jul 20: “Our VP signs off on anything over 250K.” That is Elena Voss. She declined last week's working-session invite and has been on none of the seven calls. The proposal went out Jul 20.",
    why: "Deals at this size close 7 of 9 times when the approver has been on a call before pricing, and 2 of 11 when the first thing they see is a number. Dana runs this play better than anyone here, which is why the omission is worth a conversation rather than a nudge.",
    move: "Take it to today's 1-on-1 with Dana. Agree one thing: Elena on a 20-minute call this week, or the October date comes off the board.",
    action: {
      kind: "ping_rep",
      label: "Send the note, or add to today's 1-on-1",
      message:
        "Dana, on Cascade. Elena declined the working session and she's the one who signs anything over 250K. I'd rather her first real impression of us not be a price. What's the path to 20 minutes with her this week? Happy to take the first ten myself if that makes the ask easier for Ray.",
    },
    probImpactPts: -8,
  },
  {
    id: "kl-pacific-competitor",
    detector: "unrun_play",
    severity: "critical",
    owner: "leader",
    state: "new",
    dealId: "keelson-pacific-cargo",
    account: "Pacific Cargo Group",
    rep: "Priya Nair",
    amountUsd: 320_000,
    firedAt: "2026-08-03T21:40:00Z",
    title: "Their incumbent WMS was named as a live alternative and never countered",
    evidence: "Sandra Ng, their director of operations, on the demo: “We're also looking at what our WMS vendor is putting out.” The conversation moved to implementation timing eleven seconds later and it has not come back up.",
    why: "When the Competition gate closes by Proposal Validation this team wins at 1.6 times the rate. When it stays open past proposal, the deal is decided somewhere we are not in the room. No competitive counter has been scheduled in the two weeks since.",
    move: "Ten minutes with Priya before Thursday's call. Hand her the side-by-side on the two lanes she demoed, not a battlecard.",
    action: {
      kind: "brief",
      label: "Open the 10-minute debrief",
      detail:
        "What Sandra said and where it sits in the transcript, the three deals that ended the same way, the two questions that closed the Competition gate on the last four wins, and the side-by-side already drafted for Priya to send.",
    },
    probImpactPts: -28,
  },
  {
    id: "kl-vantage-single",
    detector: "single_threaded",
    severity: "critical",
    owner: "leader",
    state: "new",
    dealId: "keelson-vantage-supply",
    account: "Vantage Supply Chain",
    rep: "Priya Nair",
    amountUsd: 210_000,
    firedAt: "2026-08-04T12:00:00Z",
    title: "One name on every call, and it closes in seven days",
    evidence: "Maya Okonkwo, VP Supply Chain, is the only Vantage contact on every call and every thread. No second stakeholder has joined a call or replied to an email. Last activity of any kind was five days ago.",
    why: "Priya has this at 35% for Aug 12 and 20 of 27 gates are green, so it looks nearly done. Single-threaded deals at this size slip a quarter two times out of three here, and the tell is exactly this: quiet in the last week before a close date.",
    move: "Ten minutes with Priya. One ask on the next call: a second name, and the legal-review gate closed while Maya is still warm.",
    action: {
      kind: "brief",
      label: "Open the dossier",
      detail: "The single-thread history across all four calls, the three Vantage names DealRipe found on prior threads who were never called, and the widen-the-room email drafted for Priya.",
    },
    probImpactPts: -18,
  },
  {
    id: "kl-summit-champion",
    detector: "single_threaded",
    severity: "high",
    owner: "leader",
    state: "new",
    dealId: "keelson-summit-logistics",
    account: "Summit Logistics",
    rep: "Alex Moreno",
    amountUsd: 250_000,
    firedAt: "2026-08-04T06:00:00Z",
    title: "The deal changed hands and was never re-qualified from the top",
    evidence: "Dana Whitfield, Summit's new Director of Operations, took this over three weeks ago. Nothing has been re-established with her: no budget conversation, no timeline, no procurement contact. Day 62 in a stage that closes in 34.",
    why: "Procurement has not been engaged, and every deal this size that Keelson has won had them in by day 40. Alex is in month four; this is the second time a change of owner has been treated as a continuation rather than a restart.",
    move: "Fifteen minutes with Alex. Decide together whether this is a restart with Dana, or a deal that comes out of the quarter honestly.",
    action: {
      kind: "brief",
      label: "Open the dossier",
      detail: "The 62-day stage clock against the winning baseline, what was established with the previous owner and is now unowned, and the re-entry email drafted for Dana Whitfield with the procurement ask in it.",
    },
    probImpactPts: -12,
  },

  // ---- BEING HANDLED ----
  {
    id: "kl-delmar-noshow",
    detector: "no_show_unrebooked",
    severity: "critical",
    owner: "rep",
    state: "in_flight",
    dealId: "keelson-delmar-customs",
    account: "Delmar Customs Brokerage",
    rep: "Tom Fielding",
    amountUsd: 180_000,
    firedAt: "2026-07-28T13:00:00Z",
    actionedAt: "2026-08-04T15:20:00Z",
    title: "The economic buyer no-showed, nine days of silence, and the forecast never moved",
    evidence: "Marcus Hale, Delmar's president and the economic buyer, no-showed the Jul 27 scoping call with no cancellation and has not answered the follow-up. The deal is still filed at 50% for September with 3 of 27 gates confirmed.",
    why: "A no-show that goes 7 days without a rebook converts at 12% here. Rebooked inside 48 hours it converts at 41%. Tom's median rebook time is 11 days, which is the single largest recoverable pattern in his book.",
    move: "The rebook draft went out yesterday afternoon. Watching for a reply through Thursday, then this escalates.",
    action: {
      kind: "email",
      label: "View the sent draft",
      to: "mhale@delmarcustoms.example",
      subject: "Missed you Monday",
      body:
        "Hi Marcus,\n\nWe had the 27th on the calendar and I think it got away from both of us. No problem at all.\n\nThe piece I still owe you is the entry-filing walkthrough with your own volumes in it, which is about twenty minutes rather than an hour.\n\nWould Thursday at 10 or Friday at 2 work? If neither does, tell me the week and I will work around it.\n\nTom",
    },
    probImpactPts: -15,
  },

  // ---- RESOLVED. The tool is not only a critic. ----
  {
    id: "kl-harborview-cfo",
    detector: "new_exec_in_thread",
    severity: "info",
    owner: "rep",
    state: "resolved",
    dealId: "keelson-harborview-freight",
    account: "Harborview Freight",
    rep: "Priya Nair",
    amountUsd: 380_000,
    firedAt: "2026-07-20T18:30:00Z",
    actionedAt: "2026-07-21T09:15:00Z",
    title: "The CFO joined and confirmed the money exists. This deal is better than the rep is calling it",
    evidence: "Nadia Brandt, CFO, on the Jul 20 call: “It's in the operations capital line for this year, so the money exists.” First time she has been on a call.",
    why: "Twenty of 27 gates are now closed on evidence and only legal is open. Priya has this at 55% for September, which is her pattern rather than the deal's. Deals in this state close at 80% here.",
    move: "Nothing to fix. The number was raised, the reason is on the record, and the only open item is getting legal review onto a calendar.",
    action: { kind: "crm_fix", label: "Apply the confirmed budget line", field: "Budget Confirmed", from: "No", to: "Yes", quote: "It's in the operations capital line for this year, so the money exists." },
    probImpactPts: 12,
  },
  {
    id: "kl-tidewater-momentum",
    detector: "expansion_signal",
    severity: "info",
    owner: "rep",
    state: "resolved",
    dealId: "keelson-tidewater-distribution",
    account: "Tidewater Distribution",
    rep: "Priya Nair",
    amountUsd: 290_000,
    firedAt: "2026-07-22T16:10:00Z",
    actionedAt: "2026-07-22T16:40:00Z",
    title: "Their VP Finance joined Tuesday's call without being invited",
    evidence: "Renata Cole, VP Finance, joined the Jul 22 demo; she was not on the invite. Owen Marsh brought her. Budget landed on the record on the same call: “We've got somewhere between 300 and 500 thousand set aside.”",
    why: "A second stakeholder joining unprompted is the strongest early signal in this book. Deals where it happens before proposal close at 60%; Priya has this at 35%.",
    move: "Nothing needed. The forecast was raised and the budget quote is in the CRM with a link to the timestamp.",
    action: { kind: "crm_fix", label: "See the field that was written", field: "Budget Confirmed", from: "No", to: "Yes", quote: "We've got somewhere between 300 and 500 thousand set aside." },
    probImpactPts: 10,
  },
  {
    id: "kl-cascade-commitment",
    detector: "commitment_breach",
    severity: "high",
    owner: "rep",
    state: "resolved",
    dealId: "keelson-cascade-freight",
    account: "Cascade Freight Systems",
    rep: "Dana Reyes",
    amountUsd: 420_000,
    firedAt: "2026-07-29T09:00:00Z",
    actionedAt: "2026-07-30T11:04:00Z",
    title: "The customs-entry volume model Dana promised was two days late",
    evidence: "Dana on the Jul 20 call: “I'll get you the model with your own entry volumes in it by Monday.” Monday came and went.",
    why: "Ray is the only Cascade contact carrying this internally. A promise missed to a single-threaded champion costs credibility we cannot spend elsewhere.",
    move: "Flagged Wednesday morning, sent by Wednesday lunchtime. Ray replied in two hours and forwarded it internally.",
    action: { kind: "brief", label: "See what was sent", detail: "The draft DealRipe assembled from the Jul 20 transcript, the entry volumes Ray gave on that call, and Ray's reply." },
    probImpactPts: 0,
  },

  // ---- WATCHING, LEADER CONTEXT ----
  {
    id: "kl-anchor-radar",
    detector: "big_meeting_radar",
    severity: "info",
    owner: "leader",
    state: "new",
    dealId: "keelson-anchor-freight",
    account: "Anchor Freight Forwarding",
    rep: "Dana Reyes",
    amountUsd: 510_000,
    firedAt: "2026-08-05T06:00:00Z",
    title: "The largest deal in the book signs Friday, and there is nothing wrong with it",
    evidence: "25 of 27 gates closed on customer evidence. Redlines returned with two comments, both on notice periods. Tom Bianchi, the COO, has been in the room twice.",
    why: "This is what a clean deal looks like when you can see the whole thing at once. The only thing still open is the signing date itself, which is why DealRipe holds 85 rather than 92.",
    move: "Two minutes on the gate sheet, then get the signing date on the calendar. Use it in Monday's pipeline call as the standard.",
    action: { kind: "brief", label: "Open the gate sheet", detail: "All 27 gates with the customer quote behind each one, the two redline comments, and the signature path as it stands." },
    probImpactPts: -7,
  },
];

// ---------------------------------------------------------------------------
// Commitments: two-sided. What we said we would do, and what they said they
// would do. Nobody writes these down today, which is why they go missing.
// ---------------------------------------------------------------------------
const COMMITMENTS: Commitment[] = [
  { id: "kc1", dealId: "keelson-cascade-freight", side: "rep", who: "Dana Reyes", what: "Send the entry-volume model with Cascade's own numbers", madeOn: "2026-07-20", source: "Jul 20 call", quote: "I'll get you the model with your own entry volumes in it by Monday.", dueBy: "2026-07-27", status: "recovered", keptAt: "2026-07-30", alertId: "kl-cascade-commitment" },
  { id: "kc2", dealId: "keelson-cascade-freight", side: "customer", who: "Ray Delgado", what: "Get Elena Voss onto a call", madeOn: "2026-07-20", source: "Jul 20 call", quote: "I'll see if I can get Elena on the next one.", dueBy: "2026-07-31", status: "overdue", alertId: "kl-cascade-eb" },
  { id: "kc3", dealId: "keelson-delmar-customs", side: "customer", who: "Marcus Hale", what: "Attend the entry-filing scoping call", madeOn: "2026-07-10", source: "Jul 10 call", quote: "Put something on for the 27th and I'll make it work.", dueBy: "2026-07-27", status: "overdue", alertId: "kl-delmar-noshow" },
  { id: "kc4", dealId: "keelson-pacific-cargo", side: "rep", who: "Priya Nair", what: "Send the side-by-side against their incumbent WMS", madeOn: "2026-07-18", source: "Jul 18 demo", quote: "I'll write up how we sit alongside the WMS and send it over.", dueBy: "2026-07-25", status: "overdue", alertId: "kl-pacific-competitor" },
  { id: "kc5", dealId: "keelson-anchor-freight", side: "customer", who: "Tom Bianchi", what: "Return redlines from their counsel", madeOn: "2026-07-22", source: "Jul 22 call", quote: "Our counsel will have comments back to you inside a week.", dueBy: "2026-07-29", status: "kept", keptAt: "2026-07-28" },
  { id: "kc6", dealId: "keelson-harborview-freight", side: "rep", who: "Priya Nair", what: "Get legal review onto a calendar", madeOn: "2026-07-20", source: "Jul 20 call", quote: "I'll coordinate with your legal team on timing.", dueBy: "2026-08-07", status: "open" },
  { id: "kc7", dealId: "keelson-summit-logistics", side: "rep", who: "Alex Moreno", what: "Re-establish the deal with Dana Whitfield and get procurement engaged", madeOn: "2026-07-18", source: "Jul 18 call", quote: "Let me get time with Dana and find out who owns procurement on your side.", dueBy: "2026-07-25", status: "overdue", alertId: "kl-summit-champion" },
  { id: "kc8", dealId: "keelson-vantage-supply", side: "customer", who: "Maya Okonkwo", what: "Bring a second name from her side onto the review", madeOn: "2026-07-21", source: "Jul 21 call", quote: "Let me see who else should be on this.", dueBy: "2026-07-31", status: "overdue", alertId: "kl-vantage-single" },
];

// ---------------------------------------------------------------------------
// Waterfall. Not "the number moved", but which deals moved it and why, with the
// people and the quotes still attached three weeks later. Endpoints are derived
// from the assembled book at the bottom of this file so the bridge always
// reconciles with the dashboard headline.
// ---------------------------------------------------------------------------
const AUTHORED_WEEK: Omit<WaterfallWeek, "startWeightedUsd" | "endWeightedUsd"> = {
  weekOf: "2026-08-03",
  label: "Week of Aug 3",
  movements: [
    { kind: "moved_down", dealId: "keelson-pacific-cargo", account: "Pacific Cargo Group", rep: "Priya Nair", amountUsd: 320_000, deltaWeightedUsd: -35_200, reason: "Sandra Ng named their incumbent WMS on the demo and the conversation moved on eleven seconds later. Two weeks on, no competitive counter has been scheduled. Debrief queued for Priya before Thursday." },
    { kind: "moved_down", dealId: "keelson-cascade-freight", account: "Cascade Freight Systems", rep: "Dana Reyes", amountUsd: 420_000, deltaWeightedUsd: -29_400, reason: "Elena Voss, who signs anything over 250K, declined last week's working session. Pricing is already out. Escalated to you today after Dana's own nudge produced nothing." },
    { kind: "moved_down", dealId: "keelson-vantage-supply", account: "Vantage Supply Chain", rep: "Priya Nair", amountUsd: 210_000, deltaWeightedUsd: -18_900, reason: "Closes in seven days on a single thread. Maya Okonkwo is the only contact who has ever joined a call, and the last activity was five days ago." },
    { kind: "moved_down", dealId: "keelson-summit-logistics", account: "Summit Logistics", rep: "Alex Moreno", amountUsd: 250_000, deltaWeightedUsd: -17_500, reason: "Dana Whitfield took the deal over three weeks ago and nothing has been re-qualified with her. Day 62 in a stage that closes in 34." },
    { kind: "moved_up", dealId: "keelson-harborview-freight", account: "Harborview Freight", rep: "Priya Nair", amountUsd: 380_000, deltaWeightedUsd: 45_600, reason: "Nadia Brandt, their CFO, joined the Jul 20 call and put the budget on the record. Twenty of 27 gates closed on evidence; only legal is open." },
    { kind: "moved_up", dealId: "keelson-tidewater-distribution", account: "Tidewater Distribution", rep: "Priya Nair", amountUsd: 290_000, deltaWeightedUsd: 29_000, reason: "Renata Cole, their VP Finance, joined Tuesday's call without being on the invite, and budget landed on the record in the same hour." },
    { kind: "added", dealId: "keelson-vol-new1", account: "Northline Forwarding", rep: "Dana Reyes", amountUsd: 96_000, deltaWeightedUsd: 24_000, reason: "Inbound from the customs-compliance webinar. Discovery held Tuesday, need confirmed in their own words, everything else open." },
    { kind: "slipped_out", dealId: "keelson-vol-kingsway", account: "Kingsway Logistics", rep: "Tom Fielding", amountUsd: 145_000, deltaWeightedUsd: -34_800, reason: "Their IT director put the integration behind a warehouse system migration that starts in October, on the record. Close date corrected Sep 18 to Dec 4 off the quote. Tom accepted the fix." },
  ],
};

// ---------------------------------------------------------------------------
// Receipt, briefs, inherited audit
// ---------------------------------------------------------------------------
const RECEIPT: WeeklyReceipt = {
  weekLabel: "Week of Aug 3",
  commitmentsRecovered: 3,
  closeDatesCorrected: 4,
  slippageCaughtUsd: 286_000,
  playsCoached: 2,
  highlights: [
    "Cascade's entry-volume model recovered two days late instead of never; Ray replied in two hours and forwarded it internally.",
    "Kingsway's close date corrected off their IT director's own words about the October migration. The quarter deflated honestly rather than in the last week of it.",
    "Harborview raised from 55 to 80 because Nadia Brandt said the money exists, and that sentence is now in the CRM with a link to the timestamp.",
    "Vantage caught seven days before a close date it was never going to make, on a single-thread pattern that has slipped two of the last three.",
  ],
};

const LEADER_BRIEF: MorningBrief = {
  audience: "leader",
  recipientName: "Joanna",
  dateLabel: "Wednesday, Aug 5 · 7:28 AM",
  subject: "4 things need you · 4 handled overnight · forecast moved −$37K",
  didOvernight: [
    "Read yesterday's 4 calls and updated 31 Salesforce fields using the customers' own sentences.",
    "Sent 5 rep briefings for today's calls and queued 2 recovery drafts, one already approved and sent.",
    "Raised 2 deals and lowered 4, each with the quote that caused it. Corrected 1 close date off a customer's own words.",
  ],
  items: [
    { icon: "alert", text: "Cascade ($420K): Elena declined the working session and pricing is already out. Dana's nudge did nothing. This needs your voice.", alertId: "kl-cascade-eb" },
    { icon: "alert", text: "Pacific ($320K): Sandra named their incumbent WMS on the demo and nobody countered it. Ten minutes with Priya before Thursday.", alertId: "kl-pacific-competitor" },
    { icon: "alert", text: "Vantage ($210K): closes in seven days on one contact who has gone quiet. Looks nearly done, and is not.", alertId: "kl-vantage-single" },
    { icon: "alert", text: "Summit ($250K): Dana Whitfield took it over three weeks ago and it was never re-qualified. Day 62 in a 34-day stage.", alertId: "kl-summit-champion" },
    { icon: "done", text: "Everything else is handled. Harborview and Tidewater both moved up on their own evidence, Delmar's rebook is out and being watched." },
  ],
};

const REP_BRIEF: MorningBrief = {
  audience: "rep",
  recipientName: "Priya",
  dateLabel: "Wednesday, Aug 5 · 7:15 AM",
  subject: "2 calls today · 2 open commitments · Vantage closes in 7 days on one thread",
  didOvernight: [
    "Harborview's budget line is in the CRM with Nadia's exact sentence and a link to the timestamp. You do not need to log it.",
    "Tidewater: Renata Cole's budget quote written back from Tuesday's call, and the proposal-review invite is drafted.",
  ],
  items: [
    { icon: "call", text: "11:00 · Pacific Cargo. Sandra named your incumbent competitor on the demo and it never got addressed. The two questions that closed this gate on your last four wins are in the brief.", alertId: "kl-pacific-competitor" },
    { icon: "call", text: "3:00 · Vantage review. Maya is still the only name on this deal and it closes Aug 12. One ask: a second person in the room.", alertId: "kl-vantage-single" },
    { icon: "alert", text: "Owed since Jul 25: the WMS side-by-side you promised Sandra. Draft is ready in your Outlook.", alertId: undefined },
  ],
};

const INHERITED_AUDIT = {
  departedRep: "Ben Ackerly",
  dealsScanned: 29,
  openCommitments: 16,
  atRiskUsd: 540_000,
  examples: [
    { account: "Meridian Forwarding", amountUsd: 118_000, what: "Promised the customs-broker reference call", quote: "“I'll set you up with a broker our size who's been live for a year.”", daysOverdue: 33 },
    { account: "Brightwater 3PL", amountUsd: 96_500, what: "Promised revised pricing after the volume change", quote: "“Let me rerun the numbers at 40,000 entries and send it back.”", daysOverdue: 27 },
    { account: "Calder Freight Group", amountUsd: 142_000, what: "Promised the integration scope for their TMS", quote: "“I'll get you the scope on how we sit next to your TMS this week.”", daysOverdue: 21 },
  ],
};

// ---------------------------------------------------------------------------
// Assemble.
//
// NO GENERATED VOLUME on this tenant, deliberately. Other watcher datasets pad
// the book to ~100 opportunities so the pipeline reads Salesforce-real, but
// Keelson is also DB-backed: /review and /pipeline compute their headline off
// the eight seeded deals. Padding here would make the Forecast page show
// $7.65M and the Forecast Room $2.56M for the same company, and a prospect who
// notices that stops trusting both numbers. The eight deals reconcile exactly:
// rep-weighted $1.55M, DealRipe-weighted $1.30M, matching the Room to the
// dollar.
// ---------------------------------------------------------------------------
const FORECASTS: DealForecast[] = [...HERO_FORECASTS];

const DR_WEIGHTED = Math.round(FORECASTS.reduce((s, f) => s + (f.amountUsd * f.drProbPct) / 100, 0));
const THIS_WEEK_DELTA = AUTHORED_WEEK.movements.reduce((s, m) => s + m.deltaWeightedUsd, 0);

// Prior weeks carry their own movement stories, so "we dropped three weeks ago,
// what happened?" has an answer with names in it. Endpoints chain backward from
// the live book so every bridge reconciles.
const PRIOR_WEEKS: Array<{ weekOf: string; label: string; movements: WaterfallWeek["movements"]; fallbackDrift?: number }> = [
  {
    weekOf: "2026-07-27",
    label: "Week of Jul 27",
    movements: [
      { kind: "moved_up", dealId: "keelson-anchor-freight", account: "Anchor Freight Forwarding", rep: "Dana Reyes", amountUsd: 510_000, deltaWeightedUsd: 30_600, reason: "Tom Bianchi sat in for the second time and asked for the contract, not another demo. Counsel's redlines came back inside the week with two comments." },
      { kind: "moved_down", dealId: "keelson-delmar-customs", account: "Delmar Customs Brokerage", rep: "Tom Fielding", amountUsd: 180_000, deltaWeightedUsd: -25_200, reason: "Marcus Hale, their president and the economic buyer, no-showed Monday's scoping call with no cancellation and nothing was rebooked. Tom's median rebook is 11 days; the watcher opened the same afternoon." },
      { kind: "added", dealId: "keelson-vol-quayside", account: "Quayside Customs Brokerage", rep: "Alex Moreno", amountUsd: 78_000, deltaWeightedUsd: 19_500, reason: "Referral from Anchor. Discovery held Jul 29, entry volumes confirmed on the call." },
    ],
  },
  {
    weekOf: "2026-07-20",
    label: "Week of Jul 20",
    movements: [
      { kind: "closed_won", dealId: "keelson-vol-ironport", account: "Ironport Logistics", rep: "Dana Reyes", amountUsd: 165_000, deltaWeightedUsd: -135_300, reason: "Signed Jul 22 at 82%. Leaves open pipeline and lands in booked revenue, which is why a win shows here as an outflow." },
      { kind: "moved_up", dealId: "keelson-cascade-freight", account: "Cascade Freight Systems", rep: "Dana Reyes", amountUsd: 420_000, deltaWeightedUsd: 25_200, reason: "Ray confirmed the Q4 peak deadline in his own words and Dana got the proposal out the same week." },
      { kind: "moved_down", dealId: "keelson-summit-logistics", account: "Summit Logistics", rep: "Alex Moreno", amountUsd: 250_000, deltaWeightedUsd: -20_000, reason: "Summit's original champion moved to the network side on the Jul 18 call. Champion gate reopened; Dana Whitfield inherited it without a handover." },
    ],
  },
  {
    weekOf: "2026-07-13",
    label: "Week of Jul 13",
    movements: [
      { kind: "slipped_out", dealId: "keelson-vol-westmark", account: "Westmark Forwarding", rep: "Tom Fielding", amountUsd: 132_000, deltaWeightedUsd: -79_200, reason: "Their operations director gated the decision on a peak-season freeze that runs to November, on the record. Close date corrected off the quote rather than off a hunch." },
      { kind: "moved_down", dealId: "keelson-vol-calder", account: "Calder Freight Group", rep: "Ben Ackerly", amountUsd: 142_000, deltaWeightedUsd: -56_800, reason: "Inherited from Ben's book. The TMS integration scope he promised in June was never sent and the deal has had no customer activity in 34 days. Reassigned to Dana with the draft already written." },
      { kind: "moved_down", dealId: "keelson-vol-gulfstream", account: "Gulfstream Supply Chain", rep: "Ben Ackerly", amountUsd: 121_000, deltaWeightedUsd: -48_400, reason: "Also inherited. Their sponsor asked twice in June for the compliance addendum and never got it. First reply of any kind went out Jul 15, three weeks late." },
      { kind: "moved_down", dealId: "keelson-vol-redfern", account: "Redfern 3PL", rep: "Ben Ackerly", amountUsd: 88_000, deltaWeightedUsd: -14_100, reason: "Inherited. Two commitments open since June, no owner until the audit surfaced it." },
      { kind: "moved_up", dealId: "keelson-harborview-freight", account: "Harborview Freight", rep: "Priya Nair", amountUsd: 380_000, deltaWeightedUsd: 22_800, reason: "Their controller mapped the approval chain unprompted on the Jul 16 call, which is how we knew to go after Nadia the following week." },
    ],
  },
  { weekOf: "2026-07-06", label: "Week of Jul 6", movements: [], fallbackDrift: 96_000 },
  { weekOf: "2026-06-29", label: "Week of Jun 29", movements: [], fallbackDrift: 61_000 },
  { weekOf: "2026-06-22", label: "Week of Jun 22", movements: [], fallbackDrift: -48_000 },
  { weekOf: "2026-06-15", label: "Week of Jun 15", movements: [], fallbackDrift: 52_000 },
];

const WATERFALL: WaterfallWeek[] = (() => {
  const weeks: WaterfallWeek[] = [{ ...AUTHORED_WEEK, startWeightedUsd: DR_WEIGHTED - THIS_WEEK_DELTA, endWeightedUsd: DR_WEIGHTED }];
  let end = DR_WEIGHTED - THIS_WEEK_DELTA;
  for (const w of PRIOR_WEEKS) {
    const delta = w.movements.length > 0 ? w.movements.reduce((s, m) => s + m.deltaWeightedUsd, 0) : (w.fallbackDrift ?? 0);
    const start = end - delta;
    weeks.push({ weekOf: w.weekOf, label: w.label, startWeightedUsd: start, endWeightedUsd: end, movements: w.movements });
    end = start;
  }
  return weeks;
})();

export const KEELSON_WATCHER: WatcherDataset = {
  tenantSlug: "keelson",
  companyName: "Keelson",
  vertical: "Freight and customs software · mid-market logistics",
  frameworkName: "Rolldog",
  stageLabels: {
    SQL1: "Develop Opportunity",
    SQL2: "Solution Finalization",
    SQL3: "Proposal Validation",
    SQL4: "Negotiations",
    SQL5: "Agreement Formalization",
  },
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
