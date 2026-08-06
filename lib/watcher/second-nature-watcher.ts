/**
 * Second Nature watcher dataset (property management / NEAT / Salesforce).
 *
 * FICTIONAL pipeline in Second Nature's exact shape: RBP sold to property
 * managers, doors + CARR, Beagle/Buildium switching dynamics, Zoom calls.
 * ~100 opportunities: 12 authored hero deals (each firing one detector story)
 * plus generated volume. Every alert: quote + why (grounded in outcomes) +
 * move + drafted artifact + one-click action, with a state so the triage
 * view shows the immune system working.
 */

import { generateVolumeForecasts } from "./index";
import type { Alert, Commitment, DealForecast, MorningBrief, RepPersona, WatcherDataset, WaterfallWeek, WeeklyReceipt } from "./types";

// ---------------------------------------------------------------------------
// Reps
// ---------------------------------------------------------------------------
const REPS: RepPersona[] = [
  {
    name: "Erin Walsh",
    email: "erin@secondnature.example",
    archetype: "star",
    landsPerHundred: 103,
    calibrationNote: "Slight sandbagger. $100 of Erin's commit lands at ~$103; her number is trustworthy with upside.",
    coachingItems: [],
    scaleThis: "Erin gets the owner on call two in 80% of her deals; team average is 35%. Her exec-invite ask converts 2x. Scale the phrasing.",
  },
  {
    name: "Casey Boyd",
    email: "casey@secondnature.example",
    archetype: "over_committer",
    landsPerHundred: 76,
    calibrationNote: "Commits before the owner is engaged. $100 of Casey's commit lands at ~$76 over 8 quarters.",
    coachingItems: [
      "Access to Authority is open on 4 of her 6 active deals; the owner has never joined a call on any of them.",
      "2 of her last 3 calls ended without a dated next step; both deals went quiet within a week.",
    ],
    scaleThis: "Her discovery on resident pain is the best on the team; the retention quotes she pulls are gold.",
  },
  {
    name: "Marcus Vale",
    email: "marcus@secondnature.example",
    archetype: "sandbagger",
    landsPerHundred: 88,
    calibrationNote: "Dollars land, a quarter late. $100 of Marcus's commit lands at ~$88 in-quarter; close dates run optimistic.",
    coachingItems: ["3 of his deals carry close dates that predate the last customer conversation about timing."],
    scaleThis: "His Buildium-coexistence walkthrough has closed the competition gate on every mixed-portfolio deal this quarter.",
  },
  {
    name: "Hollis Carter",
    email: "hollis@secondnature.example",
    archetype: "new_hire",
    landsPerHundred: 97,
    calibrationNote: "Calibrated so far (small sample, month 3 of ramp). $100 commits land at ~$97.",
    coachingItems: ["When the customer names a competitor, he moves on instead of asking the displacement question, 3 calls running."],
    scaleThis: null,
  },
  {
    name: "Jade Okafor",
    email: "jade@secondnature.example",
    archetype: "ghost",
    landsPerHundred: 81,
    calibrationNote: "Deals go quiet in her book. $100 commits land at ~$81, mostly lost to silence, not losses.",
    coachingItems: [
      "5 of her active deals have no next meeting on the calendar; the team baseline is 1.",
      "Her median reply time to inbound customer questions is 2.4 days; deals with same-day replies close 1.7x more often.",
    ],
    scaleThis: null,
  },
  {
    name: "Trent Calloway",
    email: "trent@secondnature.example",
    archetype: "departed",
    landsPerHundred: 62,
    calibrationNote: "Departed Jul 11. Book inherited and audited by DealRipe.",
    coachingItems: [],
    scaleThis: null,
  },
];

// ---------------------------------------------------------------------------
// Hero forecasts (the authored 12) with probability ledgers
// ---------------------------------------------------------------------------
const HERO_FORECASTS: DealForecast[] = [
  {
    dealId: "sn-rowan-hill",
    account: "Rowan Hill Residential",
    rep: "Casey Boyd",
    stageKey: "SQL2",
    amountUsd: 137_242,
    doors: 405,
    repProbPct: 70,
    repCloseDate: "2026-08-28",
    baselinePct: 45,
    baselineLabel: "Evaluation · new business baseline",
    adjustments: [
      { label: "Timeline confirmed by the customer", pts: 8, evidence: "“We'd want this live before September renewals really kick off.”" },
      { label: "Owner (signs portfolio-wide) never on a call by this stage", pts: -12, evidence: "That'd be Greg, our principal. He hasn't been in any of these conversations yet." },
      { label: "Thursday's working session: Greg not on the invite", pts: -6, evidence: "Calendar invite lists Renee + 2 ops staff only." },
      { label: "Casey over-commit calibration", pts: -5 },
    ],
    drProbPct: 30,
    drCloseDate: "2026-10-09",
    resolvedProbPct: 55,
    recoverableUsd: 34_311,
    bucket: "needs_you",
  },
  {
    dealId: "sn-kestrel",
    account: "Kestrel Property Group",
    rep: "Casey Boyd",
    stageKey: "SQL2",
    amountUsd: 122_990,
    doors: 360,
    repProbPct: 35,
    repCloseDate: "2026-08-15",
    baselinePct: 45,
    baselineLabel: "Evaluation · new business baseline",
    adjustments: [
      { label: "Open commitment: ROI model promised, 6 days overdue", pts: -8, evidence: "“I'll get you the per-door ROI model by Thursday.” — Casey, Jul 22 call" },
      { label: "Customer viewed pricing page twice since; no reply owed to us", pts: 4, evidence: "Priya opened pricing Tue + Thu" },
      { label: "No meeting on the calendar", pts: -10 },
      { label: "Casey over-commit calibration", pts: -5 },
    ],
    drProbPct: 26,
    drCloseDate: "2026-09-30",
    resolvedProbPct: 44,
    recoverableUsd: 22_138,
    bucket: "being_handled",
  },
  {
    dealId: "sn-meridian",
    account: "Meridian Property Management",
    rep: "Marcus Vale",
    stageKey: "SQL3",
    amountUsd: 162_262,
    doors: 475,
    repProbPct: 55,
    repCloseDate: "2026-08-05",
    baselinePct: 55,
    baselineLabel: "Vendor of Choice · upsell baseline",
    adjustments: [
      { label: "Last call entered the per-door cost-modeling spiral", pts: -10, evidence: "“Let me build out what this costs per door per month across every property type.” — Owen" },
      { label: "Economic impact confirmed and owner engaged", pts: 8 },
      { label: "Close date predates the actual vendor-of-choice call", pts: -6 },
    ],
    drProbPct: 47,
    drCloseDate: "2026-08-26",
    resolvedProbPct: 63,
    recoverableUsd: 25_962,
    bucket: "needs_you",
  },
  {
    dealId: "sn-fairway",
    account: "Fairway Rental Management",
    rep: "Marcus Vale",
    stageKey: "SQL2",
    amountUsd: 57_395,
    doors: 170,
    repProbPct: 60,
    repCloseDate: "2026-09-12",
    baselinePct: 45,
    baselineLabel: "Evaluation · new business baseline",
    adjustments: [
      { label: "Customer's language is conditional; rep logged September", pts: -14, evidence: "“If the board approves at the October meeting, we could start after that.” — Grant, Jul 24 call" },
      { label: "Buildium coexistence question resolved", pts: 6 },
    ],
    drProbPct: 37,
    drCloseDate: "2026-11-06",
    resolvedProbPct: 45,
    recoverableUsd: 4_592,
    bucket: "being_handled",
  },
  {
    dealId: "sn-stonebrook",
    account: "Stonebrook Residential",
    rep: "Erin Walsh",
    stageKey: "SQL3",
    amountUsd: 145_800,
    doors: 430,
    repProbPct: 65,
    repCloseDate: "2026-08-21",
    baselinePct: 55,
    baselineLabel: "Vendor of Choice · new business baseline",
    adjustments: [
      { label: "New exec entered the email thread: CFO, never engaged", pts: -9, evidence: "D. Whitmore, CFO, added to CC on the customer's last two replies" },
      { label: "Champion active, per-door case delivered", pts: 10 },
    ],
    drProbPct: 56,
    drCloseDate: "2026-08-28",
    resolvedProbPct: 68,
    recoverableUsd: 17_496,
    bucket: "being_handled",
  },
  {
    dealId: "sn-palmetto",
    account: "Palmetto Property Co",
    rep: "Hollis Carter",
    stageKey: "SQL2",
    amountUsd: 132_400,
    doors: 390,
    repProbPct: 45,
    repCloseDate: "2026-09-04",
    baselinePct: 45,
    baselineLabel: "Evaluation · new business baseline",
    adjustments: [
      { label: "The wide demo is scheduled: 6 property managers Thursday", pts: 6, evidence: "60-min portfolio demo, Thu 10am, 6 customer attendees" },
      { label: "Competitor (Beagle) named on last call, no displacement question asked", pts: -7, evidence: "“We also looked at Beagle last year.” — no follow-up asked" },
    ],
    drProbPct: 44,
    drCloseDate: "2026-09-04",
    resolvedProbPct: 55,
    recoverableUsd: 14_564,
    bucket: "needs_you",
  },
  {
    dealId: "sn-juniper",
    account: "Juniper Property Group",
    rep: "Jade Okafor",
    stageKey: "SQL1",
    amountUsd: 68_900,
    doors: 205,
    repProbPct: 25,
    repCloseDate: "2026-09-18",
    baselinePct: 25,
    baselineLabel: "Discovery · new business baseline",
    adjustments: [
      { label: "Call ended with no what-and-when", pts: -6, evidence: "Call ends: “Sounds good, we'll be in touch.” No date, no owner." },
      { label: "Strong need confirmed (turnover pain quantified by customer)", pts: 7 },
    ],
    drProbPct: 26,
    drCloseDate: "2026-10-02",
    resolvedProbPct: 34,
    recoverableUsd: 5_512,
    bucket: "being_handled",
  },
  {
    dealId: "sn-beacon-ridge",
    account: "Beacon Ridge Properties",
    rep: "Jade Okafor",
    stageKey: "SQL3",
    amountUsd: 118_600,
    doors: 350,
    repProbPct: 60,
    repCloseDate: "2026-08-14",
    baselinePct: 55,
    baselineLabel: "Vendor of Choice · new business baseline",
    adjustments: [
      { label: "Customer question unanswered in inbox for 3 days", pts: -8, evidence: "“Can you confirm the filter program covers our duplex units?” — R. Chen, Tue 9:14am" },
      { label: "Decision process mapped, budget confirmed", pts: 9 },
    ],
    drProbPct: 56,
    drCloseDate: "2026-08-21",
    resolvedProbPct: 66,
    recoverableUsd: 11_860,
    bucket: "being_handled",
  },
  {
    dealId: "sn-coastline",
    account: "Coastline Property Group",
    rep: "Erin Walsh",
    stageKey: "SQL4",
    amountUsd: 94_515,
    doors: 280,
    repProbPct: 90,
    repCloseDate: "2026-08-05",
    baselinePct: 75,
    baselineLabel: "Contract Out baseline",
    adjustments: [
      { label: "Owner pulling the close in (unprompted date-lock email)", pts: 12, evidence: "“Let's get the September date locked.” — Sam Ortiz, Sat email" },
      { label: "Contract forwarded to their bookkeeper without being asked", pts: 8 },
    ],
    drProbPct: 95,
    drCloseDate: "2026-08-05",
    resolvedProbPct: 95,
    recoverableUsd: 0,
    bucket: "watched",
  },
  {
    dealId: "sn-anchorline",
    account: "Anchorline Property Management",
    rep: "Erin Walsh",
    stageKey: "SQL4",
    amountUsd: 77_394,
    doors: 230,
    repProbPct: 92,
    repCloseDate: "2026-08-08",
    baselinePct: 75,
    baselineLabel: "Contract Out baseline",
    adjustments: [{ label: "Customer asked to move the signing UP a week", pts: 12, evidence: "“Can we sign before August turns so filters start sooner?” — Jordan Diaz" }],
    drProbPct: 97,
    drCloseDate: "2026-08-01",
    resolvedProbPct: 97,
    recoverableUsd: 0,
    bucket: "watched",
  },
  {
    dealId: "sn-brightline",
    account: "Brightline Property Management",
    rep: "Erin Walsh",
    stageKey: "SQL5",
    amountUsd: 86_192,
    doors: 255,
    repProbPct: 100,
    repCloseDate: "2026-07-06",
    baselinePct: 100,
    baselineLabel: "Closed won · onboarding",
    adjustments: [{ label: "Onboarding blocked: no customer-side data-migration owner", pts: 0, evidence: "“Nobody has picked that up yet.” — Monica Reyes, kickoff" }],
    drProbPct: 100,
    drCloseDate: "2026-07-06",
    resolvedProbPct: 100,
    recoverableUsd: 0,
    bucket: "being_handled",
  },
  {
    dealId: "sn-riverbend",
    account: "Riverbend Management (customer)",
    rep: "Erin Walsh",
    stageKey: "SQL5",
    amountUsd: 74_000,
    doors: 220,
    repProbPct: 100,
    repCloseDate: "2026-05-20",
    baselinePct: 100,
    baselineLabel: "Closed won · live customer",
    adjustments: [{ label: "Expansion signal on CS call: second portfolio mentioned", pts: 0, evidence: "“We also have the Charlotte portfolio, about 300 doors.” — CS call, Jul 29" }],
    drProbPct: 100,
    drCloseDate: "2026-05-20",
    resolvedProbPct: 100,
    recoverableUsd: 0,
    bucket: "watched",
  },
];

// ---------------------------------------------------------------------------
// Alerts (with states: the triage narrative)
// ---------------------------------------------------------------------------
const ALERTS: Alert[] = [
  // ---- NEEDS YOU (escalated or leader-only) ----
  {
    id: "al-rowan-eb",
    detector: "uninvited_stakeholder",
    severity: "critical",
    owner: "leader",
    state: "escalated",
    dealId: "sn-rowan-hill",
    account: "Rowan Hill Residential",
    rep: "Casey Boyd",
    amountUsd: 137_242,
    firedAt: "2026-07-29T07:10:00Z",
    escalatedAt: "2026-07-31T07:10:00Z",
    title: "Thursday's working session is missing the one person who can say yes",
    evidence: "Renee told Casey on Jul 22: “That'd be Greg, our principal. He hasn't been in any of these conversations yet.” Thursday's invite lists Renee and two ops staff. Greg is not on it. Casey was nudged Tuesday; no change in 48 hours.",
    why: "Portfolio-wide switches here close 7 of 8 times when the owner joins before pricing, and 1 of 6 when he doesn't. After the failed Beagle rollout, Greg will not move on a case he hasn't heard.",
    move: "Bring it to today's 1-on-1 with Casey, or send the supportive nudge. Either way, decide together: get Greg in, or push the session.",
    action: {
      kind: "ping_rep",
      label: "Nudge Casey (or add to today's 1-on-1)",
      message: "Casey — quick one before Thursday: what's our path to getting Greg in the room? If Renee can't broker it, I'm happy to jump on for the first 10 minutes, or we push the session a few days. This one's worth getting right. The per-door + Beagle draft is queued if useful.",
    },
    probImpactPts: -6,
  },
  {
    id: "al-meridian-spiral",
    detector: "losing_pattern",
    severity: "critical",
    owner: "leader",
    state: "new",
    dealId: "sn-meridian",
    account: "Meridian Property Management",
    rep: "Marcus Vale",
    amountUsd: 162_262,
    firedAt: "2026-07-30T21:40:00Z",
    title: "Meridian entered the per-door cost-modeling spiral",
    evidence: "Owen, on yesterday's call: “Let me build out what this costs per door per month across every property type before we commit.”",
    why: "6 of the last 7 deals that entered this conversation died in it. The counter that has worked every time: the flat per-door price card and the 3-property pilot frame, before their spreadsheet exists.",
    move: "Ten minutes with Marcus before his Friday follow-up: hand him the flat-price frame.",
    action: {
      kind: "brief",
      label: "Open the 10-min debrief",
      detail: "What Owen said, the 6 lost deals that match, the flat-price framing that broke the spiral on Meridian-sized upsells, and the exact next email Marcus should send (drafted).",
    },
    probImpactPts: -10,
  },
  {
    id: "al-palmetto-radar",
    detector: "big_meeting_radar",
    severity: "high",
    owner: "leader",
    state: "new",
    dealId: "sn-palmetto",
    account: "Palmetto Property Co",
    rep: "Hollis Carter",
    amountUsd: 132_400,
    firedAt: "2026-07-31T06:00:00Z",
    title: "Big-room demo Thursday: 6 property managers, worth your once-over",
    evidence: "60-minute portfolio demo scheduled Thu 10am. Attending: 6 Palmetto PMs incl. the regional director. Not attending: anyone from finance.",
    why: "This is the make-or-break second call for this segment. Hollis is in month 3 of ramp and hasn't run one solo. Beagle was named on the last call and never countered.",
    move: "Ten minutes today: review the dossier, decide if you join the first 15 minutes.",
    action: {
      kind: "brief",
      label: "Open the dossier",
      detail: "Who's coming and who's missing, the open NEAT gaps, the Beagle counter Hollis hasn't run, and the two questions that won the last three demos at this door count.",
    },
    probImpactPts: 6,
  },

  // ---- BEING HANDLED (rep has it; action in flight) ----
  {
    id: "al-kestrel-commit",
    detector: "commitment_breach",
    severity: "high",
    owner: "rep",
    state: "in_flight",
    dealId: "sn-kestrel",
    account: "Kestrel Property Group",
    rep: "Casey Boyd",
    amountUsd: 122_990,
    firedAt: "2026-07-29T13:05:00Z",
    actionedAt: "2026-07-30T16:20:00Z",
    title: "Open commitment: the ROI model, now 6 days out",
    evidence: "“I'll get you the per-door ROI model by Thursday.” — Casey to Priya, Jul 22 call. Nothing sent. Priya has opened the pricing page twice since.",
    why: "Buyers read follow-through as a preview of the vendor relationship. Deals here that recover a slipped commitment within a week re-engage at 2x.",
    move: "Send the model with a two-line note. Draft attached.",
    action: {
      kind: "email",
      label: "Approve & send",
      to: "Priya Raman, Operations Director, Kestrel Property Group",
      subject: "The per-door model I owe you",
      body: "Hi Priya,\n\nThe per-door ROI model I promised, a few days later than I said, that's on me.\n\nIt's built on your 352 doors: retention lift, filter-ticket drop, and make-ready savings, one page. If the numbers read differently than you expected, I'd love 15 minutes to walk where they come from.\n\nBest,\nCasey",
    },
    probImpactPts: -8,
  },
  {
    id: "al-fairway-conditional",
    detector: "conditional_language",
    severity: "high",
    owner: "rep",
    state: "in_flight",
    dealId: "sn-fairway",
    account: "Fairway Rental Management",
    rep: "Marcus Vale",
    amountUsd: 57_395,
    firedAt: "2026-07-30T09:15:00Z",
    actionedAt: "2026-07-30T18:00:00Z",
    title: "Close date says September; the customer said October board",
    evidence: "“If the board approves at the October meeting, we could start after that.” — Grant Sutter, Jul 24 call. The deal is dated Sep 12 at 60%.",
    why: "This is the 45-deals-dated-for-month-end problem, one deal at a time. Repair now and the forecast stays real without anyone chasing it.",
    move: "One-click: move close to Nov 6, add the board meeting as the gating step.",
    action: {
      kind: "crm_fix",
      label: "Accept the correction",
      field: "CloseDate",
      from: "2026-09-12",
      to: "2026-11-06",
      quote: "“If the board approves at the October meeting, we could start after that.”",
    },
    probImpactPts: -14,
  },
  {
    id: "al-stonebrook-cfo",
    detector: "new_exec_in_thread",
    severity: "high",
    owner: "rep",
    state: "in_flight",
    dealId: "sn-stonebrook",
    account: "Stonebrook Residential",
    rep: "Erin Walsh",
    amountUsd: 145_800,
    firedAt: "2026-07-30T08:30:00Z",
    actionedAt: "2026-07-31T06:45:00Z",
    title: "A CFO just entered the thread, and has never been engaged",
    evidence: "D. Whitmore (CFO) was added to CC on the customer's last two replies. He has never been on a call and no one has addressed him.",
    why: "The C-level veto never comes from nowhere; it comes from the CC line three weeks earlier. Deals where the late-arriving exec is engaged within a week close at nearly twice the rate.",
    move: "Address him directly in the next reply and offer the finance-view one-pager.",
    action: {
      kind: "email",
      label: "Approve & send",
      to: "Alexis Grant, VP Operations, Stonebrook Residential (CC: D. Whitmore, CFO)",
      subject: "The finance view, since I noticed David joined the thread",
      body: "Hi Alexis,\n\nNoticed David's now on the thread, welcome, David.\n\nSince the finance lens is usually different from the ops one, I've attached the one-page finance view: per-door economics, payback inside the first leasing cycle, and the exact line items. David, if it's useful I'm happy to walk it in 15 minutes, no slides.\n\nBest,\nErin",
    },
    probImpactPts: -9,
  },
  {
    id: "al-juniper-nocommit",
    detector: "no_commitment_secured",
    severity: "info",
    owner: "rep",
    state: "in_flight",
    dealId: "sn-juniper",
    account: "Juniper Property Group",
    rep: "Jade Okafor",
    amountUsd: 68_900,
    firedAt: "2026-07-30T20:05:00Z",
    actionedAt: "2026-07-31T06:50:00Z",
    title: "Yesterday's call ended without a what-and-when",
    evidence: "Call ends: “Sounds good, we'll be in touch.” No date, no owner, nothing on the calendar.",
    why: "Deals that leave a call without a dated next step go quiet within a week 4 times out of 5 here. The follow-up email can recover it.",
    move: "The drafted follow-up proposes the specific next step with two times, so the ask Jade didn't make on the call gets made in writing.",
    action: {
      kind: "email",
      label: "Approve & send",
      to: "Dana Whitlock, Owner, Juniper Property Group",
      subject: "The turnover math, and a next step",
      body: "Hi Dana,\n\nYou put a number on it yesterday that stuck with me: eleven make-readies last quarter. That's exactly where the benefits package bites first.\n\nThe right next step is 25 minutes with the per-door math on your 180 doors. Tuesday 10am or Wednesday 2pm work on my end, which is better for you?\n\nBest,\nJade",
    },
    probImpactPts: -6,
  },
  {
    id: "al-beacon-question",
    detector: "unanswered_question",
    severity: "high",
    owner: "rep",
    state: "in_flight",
    dealId: "sn-beacon-ridge",
    account: "Beacon Ridge Properties",
    rep: "Jade Okafor",
    amountUsd: 118_600,
    firedAt: "2026-07-30T09:14:00Z",
    actionedAt: "2026-07-31T06:55:00Z",
    title: "A $119K deal has a question sitting unanswered for 3 days",
    evidence: "“Can you confirm the filter program covers our duplex units?” — R. Chen, Tuesday 9:14am. No reply sent.",
    why: "A decision-stage buyer asking implementation questions is buying. Silence at this moment is how won deals get unwon.",
    move: "Answer now; the draft confirms duplex coverage and proposes the contract review call.",
    action: {
      kind: "email",
      label: "Approve & send",
      to: "Rachel Chen, Director of Operations, Beacon Ridge Properties",
      subject: "Yes on duplexes, and the last step",
      body: "Hi Rachel,\n\nSorry for the slow reply, and the good news is it's a clean yes: duplex units are covered under the same per-door terms, filters sized per unit, no rider needed.\n\nSince that was the last open question, want to put 20 minutes on the calendar to walk the contract so your team can start before renewals?\n\nBest,\nJade",
    },
    probImpactPts: -8,
  },
  {
    id: "al-brightline-onboarding",
    detector: "onboarding_blocked",
    severity: "high",
    owner: "rep",
    state: "in_flight",
    dealId: "sn-brightline",
    account: "Brightline Property Management",
    rep: "Erin Walsh",
    amountUsd: 86_192,
    firedAt: "2026-07-28T17:30:00Z",
    actionedAt: "2026-07-29T08:10:00Z",
    title: "Closed-won, and go-live is blocked: nobody owns the data export",
    evidence: "“Honestly, that's the open question. Our ops coordinator left two weeks ago and nobody has picked that up yet.” — Monica Reyes, kickoff call",
    why: "Go-live gates when this revenue actualizes. Onboarding stalls that pass two weeks historically slip go-live a full quarter.",
    move: "The two-option ask: name an owner, or we run the export for them.",
    action: {
      kind: "email",
      label: "Approve & send",
      to: "Monica Reyes, Director of Property Operations, Brightline",
      subject: "One thing gating your September go-live",
      body: "Hi Monica,\n\nEverything from kickoff is on track: notices ready, filter schedule set for the 228 doors.\n\nThe one open item is the resident and unit export. Easiest paths: name whoever should own it and I'll walk them through it in 20 minutes, or send me a read-only export and we'll handle the mapping on our side. Whichever is less work for you, I just don't want this to be the reason residents wait.\n\nBest,\nErin",
    },
    probImpactPts: 0,
  },
  // ---- Resolved this week (fuel for the receipt + green rows) ----
  {
    id: "al-riverbend-expansion",
    detector: "expansion_signal",
    severity: "info",
    owner: "rep",
    state: "resolved",
    dealId: "sn-riverbend",
    account: "Riverbend Management (customer)",
    rep: "Erin Walsh",
    amountUsd: 74_000,
    firedAt: "2026-07-29T15:20:00Z",
    actionedAt: "2026-07-29T16:40:00Z",
    title: "Expansion signal on a CS call: the Charlotte portfolio",
    evidence: "“We also have the Charlotte portfolio, about 300 doors.” — CS check-in, Jul 29. CS wasn't going to route it; DealRipe did.",
    why: "Expansion mentions on CS calls convert at 60% when sales follows up inside a week, and under 15% when it waits for the QBR.",
    move: "Erin opened the expansion opportunity and sent the intro note same day.",
    action: { kind: "ping_rep", label: "View the thread", message: "Expansion opp created: Riverbend Charlotte, ~300 doors. Intro sent Jul 29." },
    probImpactPts: 0,
  },
];

// ---------------------------------------------------------------------------
// Commitments (the two-sided ledger; heroes only)
// ---------------------------------------------------------------------------
const COMMITMENTS: Commitment[] = [
  { id: "c1", dealId: "sn-kestrel", side: "rep", who: "Casey Boyd", what: "Send the per-door ROI model", madeOn: "2026-07-22", source: "Jul 22 call", quote: "I'll get you the per-door ROI model by Thursday.", dueBy: "2026-07-24", status: "overdue", alertId: "al-kestrel-commit" },
  { id: "c2", dealId: "sn-rowan-hill", side: "customer", who: "Renee Alvarez", what: "Broker 30 minutes with Greg (owner)", madeOn: "2026-07-22", source: "Jul 22 call", quote: "I'm bought in, I just need to get Greg there.", dueBy: "2026-07-31", status: "open" },
  { id: "c3", dealId: "sn-coastline", side: "rep", who: "Erin Walsh", what: "Deliver the per-door value one-pager", madeOn: "2026-07-26", source: "Jul 26 call", quote: "I'll have the one-pager to you before the weekend.", dueBy: "2026-07-28", status: "kept", keptAt: "2026-07-27" },
  { id: "c4", dealId: "sn-coastline", side: "customer", who: "Sam Ortiz", what: "Forward contract to bookkeeper", madeOn: "2026-07-26", source: "Jul 26 call", quote: "I'll get this in front of our bookkeeper this week.", dueBy: "2026-08-01", status: "kept", keptAt: "2026-07-27" },
  { id: "c5", dealId: "sn-stonebrook", side: "rep", who: "Erin Walsh", what: "Send the finance-view one-pager", madeOn: "2026-07-30", source: "email thread", quote: "I'll put together the finance view for David.", dueBy: "2026-08-01", status: "open" },
  { id: "c6", dealId: "sn-meridian", side: "customer", who: "Owen Marsh", what: "Confirm rollout steps acceptance", madeOn: "2026-07-22", source: "Jul 22 call", quote: "Send me the steps and I'll confirm by Friday.", dueBy: "2026-07-25", status: "overdue" },
  { id: "c7", dealId: "sn-brightline", side: "customer", who: "Monica Reyes", what: "Name the data-export owner", madeOn: "2026-07-20", source: "kickoff call", quote: "Let me raise it internally and come back to you.", dueBy: "2026-07-27", status: "overdue" },
];

// ---------------------------------------------------------------------------
// Waterfall (this week authored; prior weeks summarized). Endpoints are
// derived from the assembled book AFTER volume generation (see bottom of
// file), so the bridge always reconciles with the dashboard headline.
// ---------------------------------------------------------------------------
const AUTHORED_WEEK: Omit<WaterfallWeek, "startWeightedUsd" | "endWeightedUsd"> = {
  weekOf: "2026-07-27",
  label: "Week of Jul 27",
  movements: [
      { kind: "added", dealId: "sn-vol-new1", account: "Timberline Property Management", rep: "Hollis Carter", amountUsd: 44_300, deltaWeightedUsd: 11_075, reason: "New inbound, discovery held Tuesday. Need confirmed in the customer's words; everything else open." },
      { kind: "moved_up", dealId: "sn-anchorline", account: "Anchorline Property Management", rep: "Erin Walsh", amountUsd: 77_394, deltaWeightedUsd: 9_287, reason: "Jordan Diaz asked to move the signing up a week so filters start before August turns. Customer is pulling the close in." },
      { kind: "moved_up", dealId: "sn-coastline", account: "Coastline Property Group", rep: "Erin Walsh", amountUsd: 94_515, deltaWeightedUsd: 8_506, reason: "Sam Ortiz forwarded the contract to his bookkeeper unprompted and asked to lock the September date." },
      { kind: "moved_down", dealId: "sn-meridian", account: "Meridian Property Management", rep: "Marcus Vale", amountUsd: 162_262, deltaWeightedUsd: -16_226, reason: "The call entered the per-door cost-modeling spiral (Owen: “let me build out what this costs per door”). 6 of 7 deals that enter it die there. Intervention queued." },
      { kind: "moved_down", dealId: "sn-rowan-hill", account: "Rowan Hill Residential", rep: "Casey Boyd", amountUsd: 137_242, deltaWeightedUsd: -8_234, reason: "Thursday's session still missing Greg, the only signer. Casey nudged Tuesday, no change; escalated to you today." },
      { kind: "slipped_out", dealId: "sn-fairway", account: "Fairway Rental Management", rep: "Marcus Vale", amountUsd: 57_395, deltaWeightedUsd: -13_200, reason: "Grant's own words gate this on the October board meeting. Close date corrected Sep 12 → Nov 6 off the quote; Marcus accepted the fix." },
      { kind: "moved_down", dealId: "sn-kestrel", account: "Kestrel Property Group", rep: "Casey Boyd", amountUsd: 122_990, deltaWeightedUsd: -11_070, reason: "The promised ROI model went 6 days unsent while Priya viewed pricing twice. Recovery draft approved and sent Thursday; watching for the reply." },
      { kind: "closed_won", dealId: "sn-harborpt", account: "Harbor Point Property Management", rep: "Hollis Carter", amountUsd: 27_709, deltaWeightedUsd: -26_300, reason: "Counter-signature returned Wednesday. Mandatory across the portfolio; onboarding queued." },
    ],
};

// ---------------------------------------------------------------------------
// Receipt + briefs + audit
// ---------------------------------------------------------------------------
const RECEIPT: WeeklyReceipt = {
  weekLabel: "Week of Jul 27",
  commitmentsRecovered: 4,
  closeDatesCorrected: 3,
  slippageCaughtUsd: 214_000,
  playsCoached: 2,
  highlights: [
    "Kestrel's overdue ROI model recovered before Priya went cold; she replied within 4 hours.",
    "Fairway's close date corrected off Grant's own board-meeting quote; pipeline deflated honestly.",
    "The Riverbend Charlotte expansion (~300 doors) routed to sales same-day off a CS call mention.",
    "Meridian's cost-modeling spiral caught on the call; the intervention that saved 1 of the last 7 is queued for Marcus.",
  ],
};

const LEADER_BRIEF: MorningBrief = {
  audience: "leader",
  recipientName: "Alisha",
  dateLabel: "Monday, Aug 3 · 7:28 AM",
  subject: "3 things need you · 6 handled overnight · forecast $1.19M",
  didOvernight: [
    "Read Friday's 4 calls, updated 31 Salesforce fields with the customers' own words.",
    "Sent 5 rep briefings for today's calls; queued 3 recovery drafts (2 already approved).",
    "Corrected 1 close date off a customer quote; deflated $13K of fiction from the quarter.",
  ],
  items: [
    { icon: "alert", text: "Rowan Hill ($137K): Thursday's session still has no Greg. Casey nudged twice; this now needs your voice.", alertId: "al-rowan-eb" },
    { icon: "alert", text: "Meridian ($162K): entered the cost-modeling spiral that killed 6 of 7. Ten minutes with Marcus before Friday.", alertId: "al-meridian-spiral" },
    { icon: "alert", text: "Palmetto ($132K): 6 PMs in Thursday's big demo, Hollis's first solo. Dossier ready, worth your once-over.", alertId: "al-palmetto-radar" },
    { icon: "done", text: "Everything else is handled: 5 flags actioned by reps, drafts sent, replies being watched.", alertId: undefined },
  ],
};

const REP_BRIEF: MorningBrief = {
  audience: "rep",
  recipientName: "Casey",
  dateLabel: "Monday, Aug 3 · 7:15 AM",
  subject: "2 calls today · 1 open commitment · Rowan Hill needs Greg",
  didOvernight: [
    "Your Kestrel recovery email got a reply: Priya wants 15 minutes Thursday, two times proposed.",
    "Rowan Hill briefing ready: objective, the per-door numbers, the Beagle contrast.",
  ],
  items: [
    { icon: "call", text: "10:00 · Rowan Hill working session. Greg still isn't on the invite; the add-Greg draft is one click.", alertId: "al-rowan-eb" },
    { icon: "call", text: "2:30 · Kestrel reconnect. Lead with the model she now has; ask for the dated next step on the call.", alertId: "al-kestrel-commit" },
  ],
};

const INHERITED_AUDIT = {
  departedRep: "Trent Calloway",
  dealsScanned: 34,
  openCommitments: 19,
  atRiskUsd: 612_000,
  examples: [
    { account: "Cypress Grove Rentals", amountUsd: 88_400, what: "Promised the insurance-coverage comparison “by Friday”", quote: "“I'll send the coverage comparison by Friday so you can take it to your broker.”", daysOverdue: 24 },
    { account: "Larkspur Property Partners", amountUsd: 64_200, what: "Promised intro to a reference customer", quote: "“I'll connect you with a portfolio our size using the program.”", daysOverdue: 31 },
    { account: "Northgate Residential", amountUsd: 112_000, what: "Promised revised pricing after the door-count change", quote: "“Let me rework the numbers for 510 doors and get that over.”", daysOverdue: 19 },
  ],
};

// ---------------------------------------------------------------------------
// Assemble: heroes + generated volume (~100 total)
// ---------------------------------------------------------------------------
const VOLUME = generateVolumeForecasts({
  seed: 20260731,
  count: 88,
  reps: ["Erin Walsh", "Casey Boyd", "Marcus Vale", "Hollis Carter", "Jade Okafor", "Trent Calloway"],
  accountPrefixes: ["Oakwood", "Summit", "Blue Spruce", "Copperleaf", "Maplecrest", "Ridgeview", "Silver Birch", "Lakeshore", "Foxglove", "Hearthstone", "Willowbrook", "Stonegate", "Cedarline", "Ironwood", "Bayview", "Clearwater", "Redstone", "Aspen Hollow", "Magnolia", "Pinehurst", "Dunmore", "Kingsley", "Halcyon", "Brookfield"],
  accountSuffixes: ["Property Management", "Residential", "Property Group", "Rentals", "Realty Management", "Property Partners", "Management Co", "Homes"],
  stages: [
    { key: "SQL1", sharePct: 34, baselinePct: 25, label: "Discovery" },
    { key: "SQL2", sharePct: 30, baselinePct: 45, label: "Evaluation" },
    { key: "SQL3", sharePct: 20, baselinePct: 55, label: "Vendor of Choice" },
    { key: "SQL4", sharePct: 12, baselinePct: 75, label: "Contract Out" },
    { key: "SQL5", sharePct: 4, baselinePct: 95, label: "Signed" },
  ],
  amountRange: [12_000, 95_000],
  idPrefix: "sn",
  // Derived from Alisha's own sheet: $629,990 CARR across 1,858 doors on
  // Winter's tab is roughly $340 per door, so generated doors reconcile against
  // CARR at the rate her team actually sells at.
  carrPerDoor: 340,
});

const FORECASTS: DealForecast[] = [...HERO_FORECASTS, ...VOLUME];

// Derive waterfall endpoints from the assembled book so the bridge always
// reconciles with the dashboard headline (end of this week = current DR
// weighted forecast; prior weeks chain backward with plausible drift).
const DR_WEIGHTED = Math.round(FORECASTS.reduce((s, f) => s + (f.amountUsd * f.drProbPct) / 100, 0));
const THIS_WEEK_DELTA = AUTHORED_WEEK.movements.reduce((s, m) => s + m.deltaWeightedUsd, 0);

// Prior weeks carry their own movement stories (Ashlee's "you dropped 300K,
// what happened?" with memory). Endpoints chain backward from the live book so
// every bridge reconciles with the dashboard headline.
const PRIOR_WEEKS: Array<{ weekOf: string; label: string; movements: WaterfallWeek["movements"]; fallbackDrift?: number }> = [
  {
    weekOf: "2026-07-20",
    label: "Week of Jul 20",
    movements: [
      { kind: "added", dealId: "sn-aspen", account: "Aspen Hollow Realty Management", rep: "Jade Okafor", amountUsd: 62_000, deltaWeightedUsd: 18_600, reason: "New evaluation from the NARPM referral; discovery held Jul 15, need confirmed in the customer's words." },
      { kind: "moved_up", dealId: "sn-stonebrook", account: "Stonebrook Residential", rep: "Erin Walsh", amountUsd: 145_800, deltaWeightedUsd: 12_600, reason: "Alexis Grant confirmed budget on the Jul 16 call and brought their ops lead in; asked for the per-door case." },
      { kind: "moved_down", dealId: "sn-vol-cedarline", account: "Cedarline Homes", rep: "Marcus Vale", amountUsd: 85_000, deltaWeightedUsd: -9_800, reason: "The champion went quiet after the Jul 9 demo; two follow-ups unanswered, next-meeting watcher opened." },
    ],
  },
  {
    weekOf: "2026-07-13",
    label: "Week of Jul 13",
    movements: [
      { kind: "slipped_out", dealId: "sn-vol-foxglove", account: "Foxglove Management Co", rep: "Hollis Carter", amountUsd: 63_000, deltaWeightedUsd: -14_200, reason: "Their outside counsel pushed legal review to September, on the record. Close date corrected off the quote; deflated honestly." },
      { kind: "moved_down", dealId: "sn-palmetto", account: "Palmetto Property Co", rep: "Hollis Carter", amountUsd: 132_400, deltaWeightedUsd: -11_900, reason: "Beagle was named on the Jul 8 call and no displacement question was asked; competition gate opened, coach note queued." },
      { kind: "moved_up", dealId: "sn-beacon-ridge", account: "Beacon Ridge Properties", rep: "Jade Okafor", amountUsd: 118_600, deltaWeightedUsd: 9_500, reason: "Rachel Chen mapped their decision process unprompted and confirmed the budget range on the Jul 10 call." },
    ],
  },
  {
    weekOf: "2026-07-06",
    label: "Week of Jul 6",
    movements: [
      { kind: "closed_won", dealId: "sn-brightline", account: "Brightline Property Management", rep: "Erin Walsh", amountUsd: 86_192, deltaWeightedUsd: -21_500, reason: "Signed Jul 6 at the regional conference. Out of open pipeline, into onboarding, where DealRipe keeps watching." },
      { kind: "moved_up", dealId: "sn-anchorline", account: "Anchorline Property Management", rep: "Erin Walsh", amountUsd: 77_394, deltaWeightedUsd: 8_900, reason: "Jordan Diaz confirmed the insurance line resolved on the Jul 2 call; last open objection cleared." },
      { kind: "added", dealId: "sn-juniper", account: "Juniper Property Group", rep: "Jade Okafor", amountUsd: 68_900, deltaWeightedUsd: 6_900, reason: "Inbound from the property-manager webinar; first call booked for the following week." },
    ],
  },
  { weekOf: "2026-06-29", label: "Week of Jun 29", movements: [], fallbackDrift: 41_000 },
  { weekOf: "2026-06-22", label: "Week of Jun 22", movements: [], fallbackDrift: 44_000 },
  { weekOf: "2026-06-15", label: "Week of Jun 15", movements: [], fallbackDrift: 39_000 },
  { weekOf: "2026-06-08", label: "Week of Jun 8", movements: [], fallbackDrift: 36_000 },
];

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

export const SECOND_NATURE_WATCHER: WatcherDataset = {
  tenantSlug: "second-nature",
  companyName: "Second Nature",
  vertical: "Resident Benefits Package · residential property management",
  frameworkName: "NEAT",
  stageLabels: { SQL1: "Discovery", SQL2: "Evaluation", SQL3: "Vendor of Choice", SQL4: "Contract Out", SQL5: "Signed" },
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
