/**
 * Pre-call briefing scheduler.
 *
 * Runs on a cron every few minutes. For every connected rep calendar, it
 * finds upcoming PILOT meetings starting within the lead window (~30 min out)
 * and emails the rep a pre-call briefing, exactly once per meeting.
 *
 * Exact start times come straight from the calendar read, so nothing extra is
 * stored for timing. Dedupe is a single marker column, calls.briefing_sent_at,
 * set once the briefing is sent (calendar-sync already created the calls row).
 *
 * Best-effort per meeting: any failure is counted/emitted and the loop moves
 * on. Never throws mid-scan for a single bad meeting.
 */

import { computeDealFlags, renderFlagsForBriefing } from "./deal-flags";
import { assessDeal, computeBuyerSignals } from "./deal-signals-buyer";
import { generateBriefingFromState } from "./generate-briefing";
import { renderPreCallBriefingEmail } from "./emails/pre-call-briefing";
import { MailerConfigError, sendEmail } from "./mailer";
import { listUpcomingMeetings, type NormalizedMeeting } from "./microsoft-graph";
import type { Json } from "./database.types";
import { attendeeLineFromMeeting } from "./attendees";
import {
  describeContext,
  resolveMeetingContext,
  shouldBrief,
  standingLabel,
} from "./meeting-context";
import { graphIso } from "./graph-time";
import { briefingStateFromContext, getDealContext } from "./deal-context";
import { isAutoJoinRep, repEmailForDeal, resolveMeetingDeal } from "./pilot-config";
import { prescriptionsFromBriefing, recordPrescriptions } from "./prescription-ledger";
import { prewarmRolldogToken } from "./rolldog";
import { recordSentMessage } from "./sent-messages";
import { withModelContext } from "./model-run";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

const TENANT_SLUG = "magaya";
const SCAN_WINDOW_DAYS = 1;
// Send a briefing when a pilot meeting is at most this many minutes away and
// still in the future. Every-5-minute cron + dedupe means each meeting fires
// once, roughly 30 to 35 minutes before it starts (or later if a run was
// missed, which is still better than never).
const LEAD_MAX_MINUTES = 35;
// Grace period AFTER the start. Previously the window closed hard at T-0, so a
// meeting whose calls row landed late (invite accepted at the last minute, Teams
// link added after the fact) lost every tick it had and the briefing was never
// sent, silently and unrecoverably. A briefing that arrives a few minutes into a
// call is still worth having; one that never arrives is not.
const GRACE_AFTER_START_MINUTES = 10;

export type BriefingSyncCounts = {
  eventsSeen: number;
  matched: number;
  inWindow: number;
  sent: number;
  alreadySent: number;
  skippedNoDeal: number;
  /** Meeting on a deal that has already resolved (won/lost). Counted, not dropped. */
  skippedClosedDeal: number;
  skippedNoCall: number;
  /** Rows briefing-sync created itself because calendar-sync had not yet. */
  createdCallRow: number;
  /**
   * Connections whose mailbox does not exist (Graph MailboxNotEnabledForRESTAPI,
   * or a 404 on calendarView). Counted apart from `errors` on purpose.
   *
   * admin@maanitdealripe.onmicrosoft.com is a dead dev connection and produced
   * a permanent errors:1 on every run, five minutes apart, forever. A constant
   * error is worse than no error: it becomes the baseline, and the next real
   * failure arrives looking exactly like the one everyone has learned to
   * ignore. `errors` now means "something unexpected", which is the only way it
   * is worth alerting on.
   */
  deadConnections: number;
  errors: number;
};

export type BriefingSyncDecision =
  | { kind: "sent"; account: string; eventId: string; to: string; minutesUntil: number }
  | { kind: "already-sent"; account: string; eventId: string }
  | { kind: "no-deal"; dealExternalId: string; eventId: string }
  | { kind: "no-call-row"; dealExternalId: string; eventId: string }
  | { kind: "skip"; eventId: string; reason: string }
  | { kind: "error"; eventId: string; message: string };

export type BriefingSyncOptions = { onDecision?: (d: BriefingSyncDecision) => void };

function startToMs(start: NormalizedMeeting["start"]): number | null {
  if (!start) return null;
  const raw =
    start.timeZone === "UTC" && !start.dateTime.endsWith("Z")
      ? start.dateTime + "Z"
      : start.dateTime;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export async function runBriefingSync(
  opts: BriefingSyncOptions = {},
): Promise<BriefingSyncCounts> {
  const counts: BriefingSyncCounts = {
    eventsSeen: 0,
    matched: 0,
    inWindow: 0,
    sent: 0,
    alreadySent: 0,
    skippedNoDeal: 0,
    skippedClosedDeal: 0,
    skippedNoCall: 0,
    createdCallRow: 0,
    deadConnections: 0,
    errors: 0,
  };
  const emit = opts.onDecision ?? (() => {});

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  // NOTE: the Rolldog token is warmed lazily, in processEvent, once a meeting is
  // actually inside the briefing window. It used to be warmed here, at the top
  // of every run. This cron fires every five minutes, and the large majority of
  // those runs have no meeting to brief, so that was ~288 token requests a day
  // for work that never happened. Rolldog noticed on August 11 and asked us to
  // stop. The token cache is per process, so a cold container could not reuse
  // the previous run's token either.

  const connections = await db
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  if (connections.error) {
    throw new Error(`[briefing-sync] list connections failed: ${connections.error.message}`);
  }
  if (!connections.data?.length) return counts;

  const now = Date.now();

  for (const conn of connections.data) {
    // One bad calendar must not abort the whole run. Skip and continue.
    let events;
    try {
      events = await listUpcomingMeetings(conn.id, SCAN_WINDOW_DAYS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isDeadMailbox(msg)) {
        counts.deadConnections += 1;
        console.warn(
          `[briefing-sync] connection ${conn.user_principal_name ?? conn.id} has no live mailbox, skipping: ${msg}`,
        );
      } else {
        counts.errors += 1;
        console.error(
          `[briefing-sync] skipping connection ${conn.user_principal_name ?? conn.id}: ${msg}`,
        );
      }
      continue;
    }
    const autoJoin = isAutoJoinRep(conn.user_principal_name);
    for (const ev of events) {
      counts.eventsSeen += 1;
      try {
        await withModelContext({ tenantId }, () =>
          processEvent(ev, tenantId, now, counts, emit, autoJoin),
        );
      } catch (err) {
        counts.errors += 1;
        emit({ kind: "error", eventId: ev.eventId, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return counts;
}

/**
 * A mailbox that does not exist, as opposed to a call that failed.
 *
 * Graph reports a deleted or on-premise mailbox as a 404 with
 * MailboxNotEnabledForRESTAPI. That is a fact about the connection, not a
 * transient fault, and retrying it every five minutes will never fix it.
 */
function isDeadMailbox(message: string): boolean {
  return (
    /MailboxNotEnabledForRESTAPI/i.test(message) ||
    /ResourceNotFound/i.test(message) ||
    (/\b404\b/.test(message) && /calendarView|\/me\b/i.test(message))
  );
}

async function processEvent(
  ev: NormalizedMeeting,
  tenantId: string,
  now: number,
  counts: BriefingSyncCounts,
  emit: (d: BriefingSyncDecision) => void,
  autoJoin: boolean,
): Promise<void> {
  if (ev.isCancelled || !ev.joinUrl) {
    emit({ kind: "skip", eventId: ev.eventId, reason: "cancelled or no join url" });
    return;
  }
  const attendeeEmails = ev.attendees
    .map((a) => a.email)
    .filter((e): e is string => typeof e === "string" && e.length > 0);
  // Resolve to a pilot deal, or an auto deal for an external customer when the
  // rep is in auto-join mode. calendar-sync creates the deal + calls row; this
  // sends the pre-call briefing for it.
  const resolved = resolveMeetingDeal(attendeeEmails, ev.subject, autoJoin);
  if (!resolved) {
    emit({ kind: "skip", eventId: ev.eventId, reason: "no pilot/auto match" });
    return;
  }
  const dealExternalId = resolved.dealExternalId;
  counts.matched += 1;

  const startMs = startToMs(ev.start);
  if (startMs === null) {
    emit({ kind: "skip", eventId: ev.eventId, reason: "no start time" });
    return;
  }
  const minutesUntil = Math.round((startMs - now) / 60000);
  if (minutesUntil < -GRACE_AFTER_START_MINUTES || minutesUntil > LEAD_MAX_MINUTES) {
    emit({ kind: "skip", eventId: ev.eventId, reason: `outside window (${minutesUntil} min)` });
    return;
  }
  counts.inWindow += 1;

  // Now that this meeting is genuinely going to be briefed, warm the Rolldog
  // token. Every briefing reads the rep's stage checklist, so on a cold process
  // the first Rolldog call happens inside the first briefing, where a throttled
  // token fetch surfaces as a bare "fetch failed" and silently drops the
  // checklist for that deal. Warming first removes that class of failure.
  //
  // Safe to call once per in-window meeting: it returns the cached token when
  // the process already has one, so only the first call in a cold process costs
  // a request. Best-effort, because a missing credential legitimately throws and
  // must never stop a briefing going out.
  await prewarmRolldogToken().catch(() => {});

  const db = supabaseAdmin();

  // Resolve the deal by external_id slug.
  const dealRow = await db
    .from("deals")
    .select("id, framework_id, rep_email, outcome_label")
    .eq("tenant_id", tenantId)
    .eq("external_id", dealExternalId)
    .maybeSingle();
  if (dealRow.error) throw new Error(`deals lookup failed: ${dealRow.error.message}`);
  if (!dealRow.data) {
    counts.skippedNoDeal += 1;
    emit({ kind: "no-deal", dealExternalId, eventId: ev.eventId });
    return;
  }
  // Do not brief a deal that has RESOLVED.
  //
  // Dpworld was closed lost on 2026-08-07 and DealRipe briefed Juan for it on
  // 08-24, then drafted him a no-show follow-up for a customer who is no longer
  // one. getPipelineChanges already excludes resolved deals, so the digest was
  // right while this path was not.
  //
  // Counted rather than dropped: a meeting on a resolved deal may mean it
  // reopened, and a silent skip makes that indistinguishable from no meeting.
  if (dealRow.data.outcome_label) {
    counts.skippedClosedDeal += 1;
    console.warn(`[briefing-sync] skipping ${dealExternalId}: deal resolved (${dealRow.data.outcome_label})`);
    return;
  }
  const dealId = dealRow.data.id;

  // Find the calls row (created by calendar-sync) and the dedupe marker.
  //
  // Look up by BOTH keys. calendar-sync keys rows on iCalUId, which is stable
  // across mailboxes, while this only ever asked for ev.eventId, which is per
  // mailbox. So the lookup missed a row that existed, fell through to the
  // self-heal insert below, and the upsert's onConflict on
  // (deal_id, external_id) could not catch it either because the external_id
  // genuinely differed. That created a second row for the meeting at the exact
  // moment the briefing fired, which is why five duplicates on August 11 each
  // carry a created_at identical to their briefing_sent_at: Custom Goods and
  // All Square at 1:25, TW Customs at 1:55, GHY at 2:25, Speed International at
  // 12:25.
  const callKey = ev.iCalUId ?? ev.eventId;
  const keys = callKey === ev.eventId ? [ev.eventId] : [callKey, ev.eventId];
  const byKey = await db
    .from("calls")
    .select("id, briefing_sent_at, outcome, has_been_extracted")
    .eq("deal_id", dealId)
    .in("external_id", keys)
    .limit(1)
    .maybeSingle();
  if (byKey.error) throw new Error(`calls lookup failed: ${byKey.error.message}`);

  // Still nothing. Before creating one, check for a row on this deal at this
  // exact start. A rep cannot be in two customer meetings on one deal at the
  // same instant, so such a row is this meeting under a re-issued invite key.
  // Adopting it keeps the bot that is already dispatched against it; inserting
  // would orphan that bot's work on a row nobody reads.
  let callRow = byKey;
  if (!callRow.data) {
    const sameSlot = await db
      .from("calls")
      .select("id, briefing_sent_at, outcome, has_been_extracted")
      .eq("deal_id", dealId)
      .eq("scheduled_start", new Date(startMs).toISOString())
      .limit(2);
    if (sameSlot.error) {
      // Say what we could not check rather than silently creating the duplicate
      // this branch exists to prevent.
      console.warn(
        `[briefing-sync] same-slot lookup failed for deal ${dealId}; a duplicate call row may be created: ${sameSlot.error.message}`,
      );
    } else if ((sameSlot.data ?? []).length === 1) {
      callRow = { ...sameSlot, data: sameSlot.data![0] } as typeof byKey;
      console.log(
        `[briefing-sync] adopted existing call ${sameSlot.data![0].id} for deal ${dealId} rather than creating a duplicate for a re-issued invite`,
      );
    }
  }

  // Self-heal the race with calendar-sync. Both crons run every 5 minutes, so
  // when an event reaches the calendar late, calendar-sync may not have created
  // the row before the window closes, and briefing-sync used to give up: no
  // briefing, no retry, no alert. We only need the row to hold the
  // briefing_sent_at marker, so create it ourselves rather than lose the send.
  //
  // Safe against the race: calls is unique on (deal_id, external_id), so a
  // concurrent calendar-sync insert either loses to us or we lose to it, and
  // either way exactly one row exists. We deliberately insert WITHOUT a bot id,
  // which is the same shape calendar-sync's own insert uses before createBot;
  // its "existing row + no bot" branch then dispatches the bot as usual, so
  // recording is unaffected.
  let callId: string;
  let alreadySentAt: string | null;
  if (callRow.data) {
    callId = callRow.data.id;
    alreadySentAt = callRow.data.briefing_sent_at;
  } else {
    const created = await db
      .from("calls")
      .upsert(
        {
          tenant_id: tenantId,
          deal_id: dealId,
          external_id: ev.eventId,
          call_date: new Date(startMs).toISOString().slice(0, 10),
          scheduled_start: new Date(startMs).toISOString(),
          participants: ev.attendees as unknown as Json,
          source: "recall_ai",
          title: ev.subject,
        },
        { onConflict: "deal_id,external_id" },
      )
      .select("id, briefing_sent_at, outcome, has_been_extracted")
      .single();
    if (created.error || !created.data) {
      // Losing this is not fatal: count it and let the next tick retry.
      counts.skippedNoCall += 1;
      emit({ kind: "no-call-row", dealExternalId, eventId: ev.eventId });
      return;
    }
    counts.createdCallRow += 1;
    callId = created.data.id;
    alreadySentAt = created.data.briefing_sent_at;
  }
  if (alreadySentAt) {
    counts.alreadySent += 1;
    emit({ kind: "already-sent", account: dealExternalId, eventId: ev.eventId });
    return;
  }

  // A meeting that has already been captured is over.
  //
  // The window runs from 35 minutes before the start to GRACE_AFTER_START_MINUTES
  // after it, and that grace exists so a briefing still lands for a meeting that
  // began before we got to it. But if the call already has an outcome, or has
  // been through extraction, the conversation happened. Sending a "here is what
  // to cover" email after the fact is worse than sending nothing: it tells the
  // rep the system does not know what time it is.
  const captured = callRow.data ?? null;
  const outcome = (captured as { outcome?: string | null } | null)?.outcome ?? null;
  const extracted = (captured as { has_been_extracted?: boolean | null } | null)?.has_been_extracted === true;
  if (outcome !== null || extracted) {
    emit({
      kind: "skip",
      eventId: ev.eventId,
      reason: `call already ${outcome ?? "extracted"}; briefings are pre-call only`,
    });
    return;
  }

  // Route to the mapped pilot rep, or the deal's rep_email (auto-created deals).
  const to = repEmailForDeal(dealExternalId) ?? dealRow.data.rep_email ?? undefined;
  if (!to) {
    emit({ kind: "skip", eventId: ev.eventId, reason: `no rep email for '${dealExternalId}'` });
    return;
  }

  // Build the canonical deal context: calls-first stage, call-verified
  // extraction, contact-derived attendees. Rolldog informs the stage only as a
  // fallback; it never overrides what the calls show. Same source the in-app
  // preview reads, so the two briefings match.
  const ctx = await getDealContext(tenantId, dealId);
  if (!ctx) throw new Error(`getDealContext returned null for ${dealId}`);

  // Who is on the call. The invite is the authority: it is who actually
  // accepted, where our contacts table is empty on every auto-created deal and
  // Salesforce holds whoever the BDR happened to record months ago.
  //
  // The previous version pasted raw attendee strings, which mixed Magaya's own
  // people into the customer list and produced "gustavo@joearevalo.com" as a
  // name. attendeeLineFromMeeting separates colleagues from customers and
  // prefers the Salesforce spelling and title where the email matches, so the
  // prompt can actually do what its targeting rule asks of it.
  const attendees =
    attendeeLineFromMeeting(ev.attendees, ctx.crmContacts) ??
    (ctx.contacts.length > 0 ? ctx.attendees : undefined);

  // What kind of call this is, decided before it happens rather than left for
  // the prompt to infer from the title. See lib/call-type-precall.ts for what
  // this cost when nothing decided it.
  const context = await resolveMeetingContext({
    tenantId,
    dealId,
    callId,
    subject: ev.subject,
    participants: ev.attendees,
    beforeIso: new Date(startMs).toISOString(),
  });
  console.log(`[briefing-sync] ${describeContext(context)}`);
  const callType = context.meeting;

  // An internal meeting is not a customer call and has nothing to brief. The
  // join-gate already refuses these, but only on deals it has to classify from
  // the invite: once a deal exists, an internal meeting with its attendees
  // sails through and the rep gets customer questions for a conversation with
  // colleagues. call-quarantine catches it afterwards, which is too late for
  // the email that already went out.
  const brief = shouldBrief(context);
  if (!brief.act) {
    emit({ kind: "skip", eventId: ev.eventId, reason: brief.reason });
    return;
  }

  // DealRipe's MEASURED flags, so the briefing's signal is a fact rather than
  // something the model inferred from the qualification fields. Days of silence
  // against this deal's own cadence, close-date movement, an unanswered thread:
  // none of that is in the extraction, so the prompt could not have known it.
  //
  // Best effort and deliberately non-fatal. A briefing without its signal flag
  // is a smaller loss than a rep walking into a call with no briefing at all,
  // which is what a throw here would produce.
  let dealFlags: string | null = null;
  try {
    const signals = await computeBuyerSignals({ tenantId, dealId: ctx.dealId });
    dealFlags = renderFlagsForBriefing(
      computeDealFlags({ signals, assessment: assessDeal(signals) }),
    );
  } catch (err) {
    console.warn(
      `[briefing-sync] flags unavailable for ${ctx.account}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const briefing = await generateBriefingFromState({
    ...briefingStateFromContext(ctx),
    attendees: attendees ?? `the ${ctx.account} team`,
    callType,
    dealFlags,
    // The calendar title is the only signal we have about what kind of call
    // this is before it happens. Without it every briefing for an account with
    // no captured history reads as a first discovery call.
    meetingSubject: ev.subject,
    // So a commitment never lands on the day of the call being briefed.
    meetingDate: ev.start?.dateTime ? graphIso(ev.start.dateTime)?.slice(0, 10) ?? null : null,
  });
  if (!briefing) throw new Error("briefing generation returned null");

  const email = renderPreCallBriefingEmail(briefing, {
    account: ctx.account,
    stageKey: ctx.effectiveStageKey,
    standingLabel: standingLabel(context),
    attendees,
    minutesUntil,
  });

  let providerId: string | null = null;
  try {
    const res = await sendEmail({ to, subject: email.subject, html: email.html, text: email.text });
    providerId = res.id || null;
  } catch (err) {
    if (err instanceof MailerConfigError) {
      emit({ kind: "skip", eventId: ev.eventId, reason: `mailer not configured: ${err.message}` });
      return;
    }
    throw err;
  }

  // Record what the rep was just told to do.
  //
  // Written HERE and not at generation, because the ledger measures what was
  // issued to a rep, not what a preview or a diagnostic rendered. The briefing
  // has gone out by this line, so every row corresponds to an instruction a
  // human actually received.
  //
  // Best-effort in exactly the way the archive below is: the email is already
  // sent, and losing the ledger row is a gap in the learning loop rather than a
  // failure of the send. It is logged loudly because a silent gap here is
  // indistinguishable from a rep who was never told anything, which is the
  // reading this ledger exists to make impossible.
  const ledger = await recordPrescriptions({
    tenantId,
    dealId,
    callId,
    source: "briefing",
    issuedAt: new Date().toISOString(),
    prescriptions: prescriptionsFromBriefing(briefing),
  });
  if (ledger.status === "unavailable") {
    console.error(
      `[briefing-sync] briefing for call ${callId} was sent but its prescriptions were not recorded, so it will look like this rep was told nothing: ${ledger.error}`,
    );
  }

  // Archive the exact briefing that was sent (best-effort, never blocks).
  await recordSentMessage({
    tenantId,
    dealId,
    callId: callId,
    kind: "briefing",
    toEmail: to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    providerId,
  });

  // Mark sent so the next scan does not resend.
  const upd = await db
    .from("calls")
    .update({ briefing_sent_at: new Date().toISOString() })
    .eq("id", callId);
  if (upd.error) {
    // The email already went out. Log loudly; a duplicate on the next scan is
    // the worst case, which is far better than a failed send.
    console.error(
      `[briefing-sync] sent briefing for call ${callId} but failed to mark briefing_sent_at: ${upd.error.message}`,
    );
  }

  counts.sent += 1;
  emit({ kind: "sent", account: ctx.account, eventId: ev.eventId, to, minutesUntil });
}
