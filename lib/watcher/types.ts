/**
 * DealRipe watcher layer: the data model for the proactive rebuild.
 *
 * This is the contract between the seed engine and the new views (Feed,
 * unified dashboard, Commitment Ledger, triage buckets). Everything here is
 * DEMO-LAYER data: the seed engine emits it as static per-tenant modules, so
 * no schema migration is needed and the live Magaya pilot is untouched. The
 * same shapes are designed to be DB-backed later without changing the views.
 *
 * Architecture: Events → Detectors → Deal state → Forecast → Dashboard.
 * Each Alert is a detector firing: trigger + severity + owner + why (grounded
 * in outcomes) + prescribed move + drafted artifact + one-click action, with
 * a STATE so the triage view can show "being handled", not just "flagged".
 */

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

export type DetectorKind =
  // Commission side: things said and not done (two-sided commitment ledger).
  | "commitment_breach" // rep-side commitment overdue
  | "customer_commitment_open" // customer-side commitment overdue (nudge, not blame)
  // Omission side: the standard of play says this should exist and doesn't.
  | "no_commitment_secured" // call ended with no what-and-when
  | "unrun_play" // situation triggered a known play; rep didn't run it
  | "no_next_meeting" // active stage, nothing on the calendar
  | "unsent_artifact" // proposal stage, no proposal out (etc.)
  | "uninvited_stakeholder" // big call scheduled, EB not on the invite (pre-call)
  // Interpretation vs fact.
  | "conditional_language" // customer hedged; rep logged Commit
  | "timing_statement" // "this is a 2027 conversation" → close-date repair
  // Stakeholder geometry.
  | "eb_never_engaged"
  | "single_threaded"
  | "new_exec_in_thread" // pre-veto: CFO appears in CC line
  | "exec_declined_invite"
  // Momentum & silence.
  | "unanswered_question" // customer question sitting in inbox >48h
  | "gone_quiet" // no customer activity > N days
  | "no_show_unrebooked"
  // Calls.
  | "losing_pattern" // call entered a known losing conversation
  | "big_meeting_radar" // the wide second call got scheduled → leader dossier
  // Post-sale.
  | "pilot_inactive"
  | "onboarding_blocked"
  | "expansion_signal";

export type AlertSeverity = "critical" | "high" | "info";
export type AlertOwner = "rep" | "leader";

/** Lifecycle of an alert, so the triage view shows response status. */
export type AlertState =
  | "new" // fired, not yet seen/actioned
  | "in_flight" // rep took the action (e.g. draft approved & sent); awaiting result
  | "resolved" // condition cleared (reply came, meeting booked, field fixed)
  | "escalated" // un-actioned past the escalation window → leader's Needs-you
  | "snoozed";

/** One-click artifact attached to an alert. Exactly one per alert. */
export type AlertAction =
  | { kind: "email"; label: string; to: string; subject: string; body: string }
  | { kind: "calendar_fix"; label: string; detail: string } // e.g. add EB to invite
  | { kind: "crm_fix"; label: string; field: string; from: string; to: string; quote: string } // one-click repair
  | { kind: "brief"; label: string; detail: string } // leader dossier / review
  | { kind: "ping_rep"; label: string; message: string };

export type Alert = {
  id: string;
  detector: DetectorKind;
  severity: AlertSeverity;
  owner: AlertOwner;
  state: AlertState;
  dealId: string; // external deal id (generator-scoped)
  account: string;
  rep: string;
  amountUsd: number;
  /** When the detector fired (ISO). Drives ordering + escalation math. */
  firedAt: string;
  /** State timestamps for the "being handled" narrative. */
  actionedAt?: string | null;
  escalatedAt?: string | null;
  /** Headline, one line, follow-through framing (never accusation). */
  title: string;
  /** The verbatim customer/rep quote or observed fact that grounds the alert. */
  evidence: string;
  /** Why it matters, tied to this team's outcomes ("6 of 8 deals like this..."). */
  why: string;
  /** The prescribed move, one sentence. */
  move: string;
  action: AlertAction;
  /** Probability impact this signal carries (for the ledger), in points. */
  probImpactPts: number;
};

// ---------------------------------------------------------------------------
// Commitment Ledger (two-sided)
// ---------------------------------------------------------------------------

export type CommitmentSide = "rep" | "customer";
export type CommitmentStatus = "open" | "kept" | "overdue" | "recovered";

export type Commitment = {
  id: string;
  dealId: string;
  side: CommitmentSide;
  who: string; // named person
  what: string; // "send the per-door ROI model"
  madeOn: string; // ISO date of the call/email where it was made
  source: string; // "Jul 22 call" | "email thread"
  quote: string; // verbatim
  dueBy: string | null; // ISO date if stated
  status: CommitmentStatus;
  keptAt?: string | null;
  /** For overdue rep-side: the recovery draft exists as an Alert action. */
  alertId?: string | null;
};

// ---------------------------------------------------------------------------
// Forecast: decomposable probability + recoverable dollars
// ---------------------------------------------------------------------------

export type ProbabilityAdjustment = {
  label: string; // "Economic buyer never on a call by this stage"
  pts: number; // signed points, e.g. -12
  evidence?: string; // quote or fact
};

export type DealForecast = {
  dealId: string;
  account: string;
  rep: string;
  stageKey: string;
  amountUsd: number;
  /**
   * Units under management on this deal. Property management sells on doors,
   * not just dollars: Alisha's own forecast sheet carries a Doors column next
   * to CARR and totals it per rep, so a forecast without it is not the sheet
   * she actually runs. Omit for tenants where it does not apply.
   */
  doors?: number;
  repProbPct: number;
  repCloseDate: string;
  /** The ledger: baseline first, then each adjustment, sum = drProbPct. */
  baselinePct: number;
  baselineLabel: string; // "Evaluation · new business baseline"
  adjustments: ProbabilityAdjustment[];
  drProbPct: number;
  drCloseDate: string;
  /** Forecast if all open flags were resolved (drives recoverable dollars). */
  resolvedProbPct: number;
  /** recoverable = (resolvedProbPct - drProbPct)/100 * amountUsd, precomputed. */
  recoverableUsd: number;
  /** Triage bucket, derived from this deal's alerts' states. */
  bucket: "needs_you" | "being_handled" | "watched";
};

// ---------------------------------------------------------------------------
// Waterfall (add / move / slip / close, with memory and reasons)
// ---------------------------------------------------------------------------

export type MovementKind = "added" | "moved_up" | "moved_down" | "slipped_out" | "closed_won" | "closed_lost";

export type WaterfallMovement = {
  kind: MovementKind;
  dealId: string;
  account: string;
  rep: string;
  amountUsd: number;
  deltaWeightedUsd: number; // signed contribution to the bridge
  reason: string; // the named why, with people and quotes
};

export type WaterfallWeek = {
  weekOf: string; // ISO Monday
  label: string; // "Week of Jul 27"
  startWeightedUsd: number;
  endWeightedUsd: number;
  movements: WaterfallMovement[];
};

// ---------------------------------------------------------------------------
// Weekly receipt ("what DealRipe prevented")
// ---------------------------------------------------------------------------

export type WeeklyReceipt = {
  weekLabel: string;
  commitmentsRecovered: number;
  closeDatesCorrected: number;
  slippageCaughtUsd: number;
  playsCoached: number;
  highlights: string[]; // 2-4 one-liners with names
};

// ---------------------------------------------------------------------------
// Rep personas + coaching
// ---------------------------------------------------------------------------

export type RepPersona = {
  name: string;
  email: string;
  archetype: "star" | "over_committer" | "sandbagger" | "new_hire" | "ghost" | "departed";
  /** Calibration: of every $100 committed, what lands (historical). */
  landsPerHundred: number;
  calibrationNote: string;
  /** Weekly coaching note: max 2 items + 1 positive to scale. */
  coachingItems: string[]; // e.g. "40% of deals die at Evaluation; team is 22%..."
  scaleThis: string | null; // the positive mirror
};

// ---------------------------------------------------------------------------
// Morning briefs (the inbox-rendered cold open)
// ---------------------------------------------------------------------------

export type MorningBriefItem = { icon: "alert" | "call" | "done"; text: string; alertId?: string };

export type MorningBrief = {
  audience: "leader" | "rep";
  recipientName: string;
  dateLabel: string; // "Monday, Aug 3 · 7:28 AM"
  subject: string;
  /** "While you were out" — what DealRipe already did, past tense. */
  didOvernight: string[];
  /** Today's needs-attention, budgeted (2-4 for leader). */
  items: MorningBriefItem[];
};

// ---------------------------------------------------------------------------
// The tenant-level watcher dataset (what a vertical config generates)
// ---------------------------------------------------------------------------

export type WatcherDataset = {
  tenantSlug: string;
  companyName: string;
  vertical: string;
  frameworkName: string;
  /** Display labels for the SQL1..SQL5 stage keys, per vertical. */
  stageLabels: Record<string, string>;
  reps: RepPersona[];
  forecasts: DealForecast[]; // one per opportunity (heroes + volume)
  alerts: Alert[];
  commitments: Commitment[];
  waterfall: WaterfallWeek[]; // most recent first
  receipt: WeeklyReceipt;
  leaderBrief: MorningBrief;
  repBrief: MorningBrief;
  /** The departed-rep audit set piece (null for tenants without the story). */
  inheritedAudit: {
    departedRep: string;
    dealsScanned: number;
    openCommitments: number;
    atRiskUsd: number;
    examples: Array<{ account: string; amountUsd: number; what: string; quote: string; daysOverdue: number }>;
  } | null;
};
