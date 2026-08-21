/**
 * What the BUYER did, per deal, as evidence rather than as a rep's opinion.
 *
 * WHY THIS EXISTS
 *
 * DealRipe already publishes a forecast category next to the rep's. Today that
 * read is computed in lib/pipeline-changes.ts by taking the REP's band and
 * moving it at most one notch: down when a critical gap is open, up when the
 * rep is low and the gates are strong. That cannot be evidence about the rep's
 * number, because it is derived from it. It can never say Commit when the rep
 * says Pipeline, agreement is guaranteed by construction, and disagreement is
 * capped at one notch.
 *
 * A second read has to be computable WITHOUT the rep's band. Then agreement
 * means something and disagreement is informative. That is what this produces.
 *
 * A separate implementation in lib/snapshot.ts computes
 * dealripe_forecast.probability as repForecastProbability x framework
 * completion. rep_forecast_probability is set on 10 of 111 Magaya deals, so
 * that number is zero for about 90% of the pilot. Both are superseded here.
 *
 * THE SAME SIGNALS ANSWER THE OPPOSITE QUESTION
 *
 * Magaya's dominant recorded loss reason is "No Decision / Non-Responsive":
 * five of the six labelled losses. The expensive failure is not losing to
 * CargoWise, it is a deal that consumes a quarter and dies of silence. So this
 * module is built to support a disqualification verdict from the same signals,
 * rather than needing a second aggregator pointed the other way. Momentum
 * absent for long enough IS the dead signal.
 *
 * EVERY SIGNAL SAYS WHETHER IT COULD BE READ
 *
 * A deal with no email log is not a deal with no email. Signals that depend on
 * data DealRipe does not yet persist return `unavailable` with the reason,
 * never a zero. Half of this file's value is refusing to score what it cannot
 * see, because a confident band built on absent evidence is worse than no band.
 *
 * READ ONLY.
 */

import { getDealAttendanceHistory, type CallAttendance } from "./attendance";
import { readEmailEngagement } from "./email-log";
import type { SlipVerdict } from "./salesforce-stage-history";
import { supabaseAdmin } from "./supabase";

/** A reading that knows whether it is a reading. */
export type Signal<T> =
  | { status: "read"; value: T; evidence: string }
  | { status: "unavailable"; reason: string };

const unread = <T>(reason: string): Signal<T> => ({ status: "unavailable", reason });
const read = <T>(value: T, evidence: string): Signal<T> => ({ status: "read", value, evidence });

export type BuyerSignals = {
  dealId: string;
  account: string;

  // ---- Momentum: is this deal still moving -------------------------------
  /** A future meeting exists on this deal. The single strongest live signal. */
  nextMeetingBooked: Signal<boolean>;
  /** Days since the last call that actually had a conversation. */
  daysSinceLastCall: Signal<number>;
  /** Median gap between the deal's calls. Rising cadence is engagement. */
  callCadenceDays: Signal<number>;

  // ---- Buying group: who is actually in the room --------------------------
  /** Distinct people from the customer side who have SPOKEN on any call. */
  distinctCustomerSpeakers: Signal<number>;
  /** Someone new from the customer side appeared on the most recent call. */
  newStakeholderOnLastCall: Signal<boolean>;
  /** Invited from the customer side but did not speak on the last call. */
  silentInvitees: Signal<number>;

  // ---- Qualification: what the calls have proven --------------------------
  fieldsAnswered: Signal<number>;
  criticalGapsOpen: Signal<string[]>;
  economicBuyerEngaged: Signal<boolean>;

  // ---- Commitment: did anyone agree to anything --------------------------
  commitmentSecured: Signal<boolean>;

  // ---- Email, from the deal_messages log ---------------------------------
  /** Days since the CUSTOMER last wrote. Unavailable when the log is empty. */
  daysSinceCustomerReply: Signal<number>;
  /**
   * We wrote after their last message and they have not answered.
   *
   * Kiddom's ops lead named this as one of the most predictive flags they
   * cannot build, because "emailing without reply needs the mailbox" and
   * Salesforce does not hold the evidence. It is the clearest negative in the
   * set and it is invisible to any CRM-only tool.
   */
  awaitingReply: Signal<boolean>;
  /**
   * How long our last outbound message has gone unanswered.
   *
   * Separate from awaitingReply because they answer different questions.
   * awaitingReply is a STATE and is true the moment a rep sends a follow-up,
   * which is the normal condition of a healthy conversation: it was true on 67
   * of 112 open deals, so a flag built on it alone fired on 60% of the book and
   * was therefore worthless as a flag. This is the DURATION, which is what
   * turns the state into a judgement.
   */
  daysSinceOurMessage: Signal<number>;
  /** Needs Salesforce CloseDate history, wired separately. */
  closeDateSlips: Signal<number>;
};

/** Framework fields whose absence is a real risk, not merely an unticked box. */
const CRITICAL_FIELDS: Record<string, string> = {
  sql4_exec_involvement: "no executive or economic buyer engaged",
  budget_fit: "budget not established",
  close_date_validated: "close date not validated with the customer",
  competition_notes: "no competitor identified",
  decision_process_mapped: "decision process not mapped",
};

/** Outcomes that mean no conversation happened, so the call is not evidence
 *  of engagement. Mirrors the NO_CONTENT rule used elsewhere. */
const NO_CONTENT = new Set(["no_show", "no_conversation", "capture_failed", "duplicate"]);

function median(ns: number[]): number {
  if (ns.length === 0) return 0;
  const s = [...ns].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Compute buyer signals for one deal.
 *
 * `now` is injected rather than read from the clock so a caller can compute
 * signals as of a past moment, which is what makes them usable for learning
 * against outcomes rather than only for a live read.
 */
export async function computeBuyerSignals(args: {
  tenantId: string;
  dealId: string;
  now?: Date;
  /**
   * Close-date movement, prefetched by the caller.
   *
   * Passed in rather than read here because it costs a Salesforce round trip
   * and the caller is almost always looping over many deals: one SOQL per 120
   * accounts against one per deal. Same shape as readDraftSent taking a
   * prefetched mailbox read. Omitting it reports unavailable, which is honest,
   * rather than silently reporting zero slips.
   */
  closeDateSlips?: SlipVerdict;
}): Promise<BuyerSignals> {
  const db = supabaseAdmin();
  const nowMs = (args.now ?? new Date()).getTime();

  const dealRes = await db
    .from("deals")
    .select("id, account")
    .eq("tenant_id", args.tenantId)
    .eq("id", args.dealId)
    .maybeSingle();
  const account = (dealRes.data as { account?: string } | null)?.account ?? args.dealId;

  // The email log, when it holds anything for this deal. A null return means
  // we have no email record, which is NOT the customer being silent, and the
  // two must not collapse into one absence.
  const mail = await readEmailEngagement({ tenantId: args.tenantId, dealId: args.dealId, now: args.now });

  const base = {
    dealId: args.dealId,
    account,
    daysSinceCustomerReply:
      mail && mail.daysSinceCustomerMessage !== null
        ? read(mail.daysSinceCustomerMessage, mail.evidence)
        : unread<number>(
            mail
              ? `${mail.total} message(s) logged on this deal and the customer has never written`
              : "no email logged for this deal, so silence on this channel cannot be distinguished from an unread channel",
          ),
    awaitingReply: mail
      ? read(mail.awaitingReply, mail.evidence)
      : unread<boolean>("no email logged for this deal"),
    daysSinceOurMessage:
      mail && mail.daysSinceOurMessage !== null
        ? read(mail.daysSinceOurMessage, mail.evidence)
        : unread<number>(
            mail ? "nothing has been sent to this customer from a logged mailbox" : "no email logged for this deal",
          ),
    closeDateSlips:
      args.closeDateSlips === undefined
        ? unread<number>("the caller did not prefetch close-date history for this deal")
        : args.closeDateSlips.status === "read"
          ? read(args.closeDateSlips.slips, args.closeDateSlips.evidence)
          : unread<number>(args.closeDateSlips.reason),
  };

  // ---- calls -------------------------------------------------------------
  const callsRes = await db
    .from("calls")
    .select("id, scheduled_start, call_date, outcome")
    .eq("tenant_id", args.tenantId)
    .eq("deal_id", args.dealId)
    .order("scheduled_start", { ascending: true });

  if (callsRes.error) {
    const reason = `calls read failed: ${callsRes.error.message}`;
    return {
      ...base,
      nextMeetingBooked: unread(reason),
      daysSinceLastCall: unread(reason),
      callCadenceDays: unread(reason),
      distinctCustomerSpeakers: unread(reason),
      newStakeholderOnLastCall: unread(reason),
      silentInvitees: unread(reason),
      fieldsAnswered: unread(reason),
      criticalGapsOpen: unread(reason),
      economicBuyerEngaged: unread(reason),
      commitmentSecured: unread(reason),
    };
  }

  const calls = ((callsRes.data ?? []) as Array<{
    id: string;
    scheduled_start: string | null;
    call_date: string | null;
    outcome: string | null;
  }>).map((c) => ({ ...c, at: Date.parse(c.scheduled_start ?? c.call_date ?? "") }))
    .filter((c) => Number.isFinite(c.at));

  const future = calls.filter((c) => c.at > nowMs);
  const held = calls.filter((c) => c.at <= nowMs && !(c.outcome && NO_CONTENT.has(c.outcome)));

  const nextMeetingBooked: Signal<boolean> =
    calls.length === 0
      ? unread("no calls on this deal")
      : future.length > 0
        ? read(true, `a meeting is scheduled for ${new Date(future[0].at).toISOString().slice(0, 10)}`)
        : read(false, "no future meeting is on the calendar for this deal");

  const lastHeld = held[held.length - 1];
  const daysSinceLastCall: Signal<number> = lastHeld
    ? read(
        Math.floor((nowMs - lastHeld.at) / 86_400_000),
        `last conversation was ${new Date(lastHeld.at).toISOString().slice(0, 10)}`,
      )
    : unread("no call on this deal has produced a conversation yet");

  const gaps: number[] = [];
  for (let i = 1; i < held.length; i++) gaps.push(Math.round((held[i].at - held[i - 1].at) / 86_400_000));
  const callCadenceDays: Signal<number> =
    gaps.length === 0
      ? unread(`only ${held.length} conversation(s) on this deal, so there is no cadence to measure`)
      : read(median(gaps), `${held.length} conversations, median ${median(gaps)} days apart`);

  // ---- attendance --------------------------------------------------------
  // Imported rather than restated. computeCallAttendance already handles the
  // diarized-speaker matching and the invited-versus-joined distinction, and a
  // second implementation would drift from the badge shown in the UI.
  let attendance: CallAttendance[] = [];
  try {
    attendance = await getDealAttendanceHistory(args.tenantId, args.dealId, 12);
  } catch {
    attendance = [];
  }

  let distinctCustomerSpeakers: Signal<number>;
  let newStakeholderOnLastCall: Signal<boolean>;
  let silentInvitees: Signal<number>;

  if (attendance.length === 0) {
    const why =
      held.length === 0
        ? "no conversation on this deal yet"
        : "no call on this deal carries a participant list, so we cannot say who was in the room";
    distinctCustomerSpeakers = unread(why);
    newStakeholderOnLastCall = unread(why);
    silentInvitees = unread(why);
  } else {
    // getDealAttendanceHistory returns newest first.
    const ordered = [...attendance].reverse();
    const spokenBefore = new Set<string>();
    const everSpoke = new Set<string>();
    for (let i = 0; i < ordered.length; i++) {
      for (const inv of ordered[i].invitees) {
        const key = (inv.email ?? inv.name ?? "").toLowerCase().trim();
        if (!key || !inv.spoke) continue;
        if (i < ordered.length - 1) spokenBefore.add(key);
        everSpoke.add(key);
      }
    }
    distinctCustomerSpeakers = read(
      everSpoke.size,
      everSpoke.size === 1
        ? "single-threaded: one person from the customer has ever spoken"
        : `${everSpoke.size} people from the customer have spoken across ${ordered.length} call(s)`,
    );

    const last = ordered[ordered.length - 1];
    const newcomers = last.invitees
      .filter((i) => i.spoke)
      .map((i) => (i.email ?? i.name ?? "").toLowerCase().trim())
      .filter((k) => k && !spokenBefore.has(k));
    newStakeholderOnLastCall =
      ordered.length < 2
        ? unread("only one call, so nobody can be new")
        : read(
            newcomers.length > 0,
            newcomers.length > 0
              ? `${newcomers.length} new person(s) spoke for the first time on the most recent call`
              : "no new customer voice on the most recent call",
          );

    const silent = last.invitees.filter((i) => i.onInvite && !i.spoke).length;
    silentInvitees = read(
      silent,
      silent === 0 ? "everyone invited spoke" : `${silent} invited person(s) did not speak on the last call`,
    );
  }

  // ---- qualification -----------------------------------------------------
  const feRes = await db
    .from("field_extractions")
    .select("framework_field_key, status, framework_id")
    .eq("tenant_id", args.tenantId)
    .eq("deal_id", args.dealId);

  // The deal's own framework decides which gaps exist at all.
  //
  // Neither "every field in CRITICAL_FIELDS" nor "only fields this deal has an
  // extraction row for" is right. The first invents gaps for fields the
  // customer's framework does not contain, which happens here because some
  // deals sit on a six-field auto-created framework rather than the 27-field
  // SQL0-SQL5 one. The second treats a field nobody discussed as a gap that is
  // closed, which would let a deal reach Commit with no budget ever raised.
  let frameworkKeys: Set<string> | null = null;
  const frameworkId = ((feRes.data ?? []) as Array<{ framework_id: string | null }>).find(
    (r) => r.framework_id,
  )?.framework_id;
  if (frameworkId) {
    const ff = await db.from("framework_fields").select("field_key").eq("framework_id", frameworkId);
    if (!ff.error) {
      frameworkKeys = new Set(((ff.data ?? []) as Array<{ field_key: string }>).map((f) => f.field_key));
    }
  }

  let fieldsAnswered: Signal<number>;
  let criticalGapsOpen: Signal<string[]>;
  let economicBuyerEngaged: Signal<boolean>;

  if (feRes.error) {
    const reason = `extraction read failed: ${feRes.error.message}`;
    fieldsAnswered = unread(reason);
    criticalGapsOpen = unread(reason);
    economicBuyerEngaged = unread(reason);
  } else {
    const rows = (feRes.data ?? []) as Array<{ framework_field_key: string; status: string }>;
    if (rows.length === 0) {
      const why = "no extraction on this deal, so nothing has been proven either way";
      fieldsAnswered = unread(why);
      criticalGapsOpen = unread(why);
      economicBuyerEngaged = unread(why);
    } else {
      const yes = new Set(rows.filter((r) => r.status === "Yes").map((r) => r.framework_field_key));
      fieldsAnswered = read(yes.size, `${yes.size} of ${rows.length} framework fields answered by the calls`);

      // A field the extraction never produced is NOT a gap that is closed.
      //
      // The first version required the field to exist in field_extractions
      // before counting it as open, so a deal on which budget was never
      // discussed read as "budget gap not open" and could reach Commit without
      // anyone ever having established a budget. That is absence of evidence
      // standing in for evidence of absence, in the one place it would have
      // inflated a forecast.
      //
      // Never-discussed and discussed-but-unresolved are both open, and the
      // wording says which, because they need different moves from the rep.
      // In the framework and not answered Yes. A field the framework does not
      // contain is not a gap; a field it contains that no call ever raised is.
      const inFramework = (k: string) =>
        frameworkKeys ? frameworkKeys.has(k) : rows.some((r) => r.framework_field_key === k);
      const open = Object.entries(CRITICAL_FIELDS)
        .filter(([k]) => inFramework(k) && !yes.has(k))
        .map(([k, label]) =>
          rows.some((r) => r.framework_field_key === k) ? label : `${label} (never raised on any call)`,
        );
      criticalGapsOpen = read(
        open,
        open.length === 0 ? "no critical gap open" : `${open.length} critical gap(s): ${open.join("; ")}`,
      );

      economicBuyerEngaged = inFramework("sql4_exec_involvement")
        ? read(
            yes.has("sql4_exec_involvement"),
            yes.has("sql4_exec_involvement")
              ? "the calls confirm an executive or economic buyer is engaged"
              : "no executive or economic buyer confirmed by any call",
          )
        : unread("this framework has no executive-involvement field");
    }
  }

  // ---- commitment --------------------------------------------------------
  const prRes = await db
    .from("prescribed_actions")
    .select("kind, followed, outcome_next_meeting, issued_at")
    .eq("tenant_id", args.tenantId)
    .eq("deal_id", args.dealId)
    .eq("kind", "end_commitment")
    .order("issued_at", { ascending: false })
    .limit(5);

  let commitmentSecured: Signal<boolean>;
  if (prRes.error) {
    commitmentSecured = unread(`prescription read failed: ${prRes.error.message}`);
  } else {
    const rows = (prRes.data ?? []) as Array<{ followed: string; outcome_next_meeting: string }>;
    if (rows.length === 0) {
      commitmentSecured = unread("no end commitment has been prescribed on this deal");
    } else if (rows.every((r) => r.followed === "unknown")) {
      // The distinction that matters: unscored is not unsecured. An end
      // commitment is usually settled in writing after the call, so a
      // transcript-only read records reps who did the work as reps who did not.
      commitmentSecured = unread(
        `${rows.length} commitment(s) prescribed, none scored yet, and a commitment is often secured by email after the call`,
      );
    } else {
      const got = rows.some((r) => r.followed === "yes" || r.outcome_next_meeting === "yes");
      commitmentSecured = read(
        got,
        got
          ? "a dated next step was secured on this deal"
          : "the prescribed end commitment was not secured on the most recent calls",
      );
    }
  }

  return {
    ...base,
    nextMeetingBooked,
    daysSinceLastCall,
    callCadenceDays,
    distinctCustomerSpeakers,
    newStakeholderOnLastCall,
    silentInvitees,
    fieldsAnswered,
    criticalGapsOpen,
    economicBuyerEngaged,
    commitmentSecured,
  };
}

// =====================================================================
// The verdict
// =====================================================================

/**
 * What the signals say about the deal, independent of the rep's own band.
 *
 * POSTURE: one read, shown to both sides, with no loyalty to either.
 *
 * The rep sees it before the call and walks into the pipeline review already
 * holding it. The leader sees the same read across the portfolio and forecasts
 * from it. Those two people have different incentives, and a read that is
 * usable by both is only possible because it is computed from the buyer's
 * behaviour rather than from either of their opinions. It is not a rep
 * advocate and it is not an audit tool. Being unbiased is the product.
 *
 * What it never does is ask the rep to report. Every signal here is computed
 * from what already happened: calls held, people who spoke, fields the calls
 * proved, commitments scored. The rep feeds it nothing. That is the line
 * between this and a status tool, and it is a line about input, not about who
 * is allowed to look at the output.
 *
 * WHICH PARTS ARE TENANT-SPECIFIC, since "the company's own sales process" is
 * half the point:
 *
 *   Buyer engagement is universal. A customer going quiet, a buying group that
 *   never widens, an invited stakeholder who does not speak: these mean the
 *   same thing at Magaya and at Kiddom.
 *
 *   The qualification gates are already tenant-specific and already in the
 *   database. CRITICAL_FIELDS below names Magaya's SQL0-SQL5 field keys and
 *   must move into tenant configuration alongside the framework itself.
 *
 *   The thresholds are declared constants and are the third tenant-specific
 *   piece. They are the ones a customer will argue with, which is why they are
 *   named and visible rather than buried in a fitted model.
 */
export type DealAssessment = {
  /**
   * DealRipe's own band, on the SAME ladder the rep forecasts on. Null when too
   * little was readable to say anything.
   *
   * `Omitted` is a rung on purpose, and it was missing until 2026-08-20. The
   * ladder ran Commit / Expect / Pipeline, so a rep who had omitted a deal
   * could never be agreed with: seventeen open Magaya deals sat at Omitted and
   * every one of them rendered as a disagreement DealRipe had not actually
   * made. A second read that cannot reach the rep's own answer is not a second
   * read, it is a scale mismatch.
   *
   * It runs in both directions and both are useful. Agreeing with an omit says
   * the evidence backs the rep's own judgement. Disagreeing upward, DealRipe
   * carrying a deal the rep omitted, is sandbagging, and that is a catch a
   * leader will pay for.
   */
  band: "Commit" | "Expect" | "Pipeline" | "Omitted" | null;
  /** Is this deal moving, and is it moving relative to ITS OWN rhythm. */
  momentum: "advancing" | "steady" | "stalling" | "unknown";
  momentumReason: string;
  /** What is going for this deal. Named first on purpose. */
  strengths: string[];
  /** What is against it, each with the evidence attached. */
  risks: string[];
  /**
   * What could not be read at all.
   *
   * Printed alongside the band rather than hidden, because a band computed
   * from three readable signals is a different object from one computed from
   * nine, and a reader cannot tell them apart from the band alone.
   */
  notChecked: string[];
  /** How much of the signal set was actually readable. */
  confidence: "high" | "partial" | "low";
};

/**
 * How far past a deal's own cadence counts as silence.
 *
 * Deliberately a multiple of the deal's own rhythm rather than a fixed number
 * of days. A deal that met weekly and has been quiet for a month is in trouble;
 * a deal that has always met monthly is not. A fixed threshold flags the second
 * and misses the first, which is backwards.
 */
const SILENCE_MULTIPLE = 3;

/**
 * How long a deal with NO measurable rhythm may go quiet before it is stalling.
 *
 * A deal needs two conversations before it has a cadence of its own, and at
 * Magaya 54 of 114 open deals have had exactly one. Requiring a rhythm meant
 * none of them could ever stall, so eleven deals sitting more than three weeks
 * past their only call with nothing booked were reported as steady. That is the
 * exact shape of the loss reason this company records most: No Decision /
 * Non-Responsive.
 *
 * This is the one place a fixed threshold is right, because there is no rhythm
 * to compare against. It should be the TENANT'S median gap between calls rather
 * than a number invented here, which is what `orgCadenceDays` is for; 21 is the
 * fallback when the caller does not supply one.
 */
const NO_RHYTHM_SILENCE_DAYS = 21;

/** Below this many readable signals, a band is not offered at all. */
const MIN_READABLE_FOR_BAND = 4;

export function assessDeal(
  s: BuyerSignals,
  opts: {
    /**
     * The tenant's own median gap between calls, for deals that have not had
     * two conversations yet. Pass it so a deal with one call is judged against
     * how fast this company normally moves rather than against a constant.
     */
    orgCadenceDays?: number;
  } = {},
): DealAssessment {
  const strengths: string[] = [];
  const risks: string[] = [];
  const notChecked: string[] = [];

  const all: Array<[string, Signal<unknown>]> = [
    ["a next meeting", s.nextMeetingBooked],
    ["time since the last call", s.daysSinceLastCall],
    ["call cadence", s.callCadenceDays],
    ["who has spoken", s.distinctCustomerSpeakers],
    ["new stakeholders", s.newStakeholderOnLastCall],
    ["silent invitees", s.silentInvitees],
    ["fields answered", s.fieldsAnswered],
    ["critical gaps", s.criticalGapsOpen],
    ["economic buyer", s.economicBuyerEngaged],
    ["commitment", s.commitmentSecured],
    ["customer email replies", s.daysSinceCustomerReply],
    ["awaiting a reply", s.awaitingReply],
    ["time since we wrote", s.daysSinceOurMessage],
    ["close date slips", s.closeDateSlips],
  ];
  for (const [label, sig] of all) {
    if (sig.status === "unavailable") notChecked.push(`${label}: ${sig.reason}`);
  }
  const readable = all.length - notChecked.length;

  // ---- momentum, which is also the disqualification signal ---------------
  //
  // Magaya's dominant recorded loss reason is No Decision / Non-Responsive.
  // The expensive failure is not losing to a competitor, it is a deal that
  // consumes a quarter and dies of silence, so momentum is computed first and
  // a stalling verdict is as much of an output as a band.
  let momentum: DealAssessment["momentum"] = "unknown";
  let momentumReason = "not enough of the deal's history is readable to say whether it is moving";

  const nextMtg = s.nextMeetingBooked;
  const since = s.daysSinceLastCall;
  const cadence = s.callCadenceDays;

  if (nextMtg.status === "read" && nextMtg.value) {
    momentum = "advancing";
    momentumReason = nextMtg.evidence;
    strengths.push(nextMtg.evidence);
  } else if (nextMtg.status === "read" && since.status === "read") {
    const rhythm = cadence.status === "read" && cadence.value > 0 ? cadence.value : null;
    // Silence means no contact on ANY channel. A customer who wrote three days
    // ago has not gone quiet just because no meeting is booked, and calling
    // that stalling is the error the "counts calls only" caveat was warning
    // about. Contact is the more recent of the last call and the last customer
    // message.
    const mailDays = s.daysSinceCustomerReply.status === "read" ? s.daysSinceCustomerReply.value : null;
    const contactDays = mailDays !== null ? Math.min(since.value, mailDays) : since.value;
    // A deal with its own rhythm is judged against it. A deal with only one
    // conversation has no rhythm, and is judged against how fast deals move at
    // this company. Judging the second group against nothing is what reported
    // eleven stale deals as steady.
    const limit = rhythm !== null ? rhythm * SILENCE_MULTIPLE : (opts.orgCadenceDays ?? NO_RHYTHM_SILENCE_DAYS);
    const channel = mailDays !== null && mailDays < since.value ? "email" : "call";
    if (contactDays > limit) {
      momentum = "stalling";
      const spine =
        rhythm !== null
          ? `no next meeting, and ${contactDays} days since any contact on a deal that had been meeting ` +
            `every ${rhythm} days. That is ${(contactDays / rhythm).toFixed(1)}x its own rhythm`
          : `no next meeting, and ${contactDays} days since any contact on this deal, against a ` +
            `${limit}-day norm for this company`;
      // Unanswered outbound is a stronger statement than mutual silence: we
      // are the ones waiting, and the customer has chosen not to answer.
      const unanswered =
        s.awaitingReply.status === "read" && s.awaitingReply.value
          ? ". We wrote last and they have not answered"
          : "";
      momentumReason = spine + unanswered;
      risks.push(momentumReason);
    } else {
      momentum = "steady";
      momentumReason =
        channel === "email"
          ? `no next meeting booked, but the customer wrote ${contactDays} day(s) ago`
          : rhythm
            ? `no next meeting booked, but ${contactDays} days is within this deal's ${rhythm}-day rhythm`
            : `no next meeting booked; ${contactDays} days since contact, inside the ${limit}-day norm`;
      risks.push("no next meeting is on the calendar");
    }
  }

  // Silence here means "no CALL". Until the email log exists we cannot say the
  // customer has gone quiet, only that no meeting has happened, and those are
  // different facts about a deal.
  if (momentum === "stalling" && s.daysSinceCustomerReply.status === "unavailable" && s.awaitingReply.status === "unavailable") {
    momentumReason += ". This counts calls only: nothing is logged on the email channel for this deal, so the customer may have been in touch";
  }

  // Unanswered outbound is a risk in its own right even on a deal that is
  // otherwise moving, because it is the flag Kiddom named as most predictive
  // and least available: a CRM cannot see it.
  if (s.awaitingReply.status === "read" && s.awaitingReply.value && momentum !== "stalling") {
    risks.push(s.awaitingReply.evidence);
  }

  // ---- strengths and risks from the rest ---------------------------------
  if (s.economicBuyerEngaged.status === "read") {
    (s.economicBuyerEngaged.value ? strengths : risks).push(s.economicBuyerEngaged.evidence);
  }
  if (s.distinctCustomerSpeakers.status === "read") {
    (s.distinctCustomerSpeakers.value >= 2 ? strengths : risks).push(s.distinctCustomerSpeakers.evidence);
  }
  if (s.newStakeholderOnLastCall.status === "read" && s.newStakeholderOnLastCall.value) {
    // Eduardo's own read: the meeting where a new function first appears is
    // often the meeting where the deal becomes real.
    strengths.push(s.newStakeholderOnLastCall.evidence);
  }
  if (s.commitmentSecured.status === "read") {
    (s.commitmentSecured.value ? strengths : risks).push(s.commitmentSecured.evidence);
  }
  if (s.criticalGapsOpen.status === "read") {
    if (s.criticalGapsOpen.value.length > 0) risks.push(s.criticalGapsOpen.evidence);
    else strengths.push(s.criticalGapsOpen.evidence);
  }
  if (s.fieldsAnswered.status === "read" && s.fieldsAnswered.value > 0) {
    strengths.push(s.fieldsAnswered.evidence);
  }
  if (s.silentInvitees.status === "read" && s.silentInvitees.value > 0) {
    risks.push(s.silentInvitees.evidence);
  }
  if (s.closeDateSlips.status === "read") {
    (s.closeDateSlips.value > 0 ? risks : strengths).push(s.closeDateSlips.evidence);
  }

  // ---- band ---------------------------------------------------------------
  //
  // Weights are DECLARED, not fitted. Buyer-engagement signals cannot be
  // learned from Magaya's history because pre-pilot opportunities carry no
  // transcripts or mailbox record, so the only training set is the pilot's
  // seven closed deals. A model fitted to that and presented as science would
  // be worse than a rule anyone can argue with. Each threshold below is a
  // claim a rep can disagree with out loud, which is the point.
  let band: DealAssessment["band"] = null;
  if (readable >= MIN_READABLE_FOR_BAND) {
    // Commit asks for the gaps that DECIDE a deal, not for all five clear.
    //
    // The first version required an empty criticalGapsOpen. Across 114 open
    // Magaya deals that never once happened, so Commit was a band nothing could
    // reach, which is a calibration failure rather than a high standard. An
    // unidentified competitor is a risk; it is not a reason a funded, sponsored,
    // committed deal cannot close.
    const decisiveOpen =
      s.criticalGapsOpen.status === "read"
        ? s.criticalGapsOpen.value.filter(
            (g) => g.includes("economic buyer") || g.includes("budget") || g.includes("close date"),
          )
        : null;
    const decisiveClear = decisiveOpen !== null && decisiveOpen.length === 0;
    const buyerIn = s.economicBuyerEngaged.status === "read" && s.economicBuyerEngaged.value;
    const committed = s.commitmentSecured.status === "read" && s.commitmentSecured.value;
    const threaded = s.distinctCustomerSpeakers.status === "read" && s.distinctCustomerSpeakers.value >= 2;

    // Two or more pushes is a standing objection to any confident band. The
    // date has been wrong twice already; the third estimate is not evidence.
    const slipped = s.closeDateSlips.status === "read" && s.closeDateSlips.value >= 2;

    // A deal nobody is talking to does not belong in a forecast, at any rung.
    // Magaya's dominant recorded loss reason is No Decision / Non-Responsive,
    // so silence is the single most predictive thing this function reads.
    if (momentum === "stalling") {
      band = "Omitted";
    } else if (slipped) {
      band = "Expect";
      risks.push("the close date has moved at least twice, so a confident band is not supportable");
    } else if (buyerIn && decisiveClear && (committed || momentum === "advancing")) {
      band = "Commit";
    } else if (momentum === "advancing" && threaded && (buyerIn || committed)) {
      band = "Expect";
    } else if (momentum === "advancing" || threaded) {
      // Pipeline is now a CLAIM rather than a floor: something positive was
      // read, either a booked meeting or a buying group wider than one person.
      band = "Pipeline";
    } else {
      // Nothing positive was readable at all. Until 2026-08-20 this fell
      // through to Pipeline, which made Pipeline mean two incompatible things
      // at once, a real early-stage read and "no rung above the floor was
      // reached". The floor is exactly the codebase's signature failure:
      // absence of evidence printed as a positive claim.
      band = "Omitted";
      risks.push(
        "no meeting is booked and only one person from their side has spoken, so nothing " +
          "readable supports carrying this in the forecast",
      );
    }
  }

  const confidence: DealAssessment["confidence"] =
    readable >= 8 ? "high" : readable >= MIN_READABLE_FOR_BAND ? "partial" : "low";

  return { band, momentum, momentumReason, strengths, risks, notChecked, confidence };
}
