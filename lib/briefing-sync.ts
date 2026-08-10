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

import { generateBriefingFromState } from "./generate-briefing";
import { renderPreCallBriefingEmail } from "./emails/pre-call-briefing";
import { MailerConfigError, sendEmail } from "./mailer";
import { listUpcomingMeetings, type NormalizedMeeting } from "./microsoft-graph";
import type { Json } from "./database.types";
import { briefingStateFromContext, getDealContext } from "./deal-context";
import { isAutoJoinRep, repEmailForDeal, resolveMeetingDeal } from "./pilot-config";
import { prewarmRolldogToken } from "./rolldog";
import { recordSentMessage } from "./sent-messages";
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
  skippedNoCall: number;
  /** Rows briefing-sync created itself because calendar-sync had not yet. */
  createdCallRow: number;
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
    skippedNoCall: 0,
    createdCallRow: 0,
    errors: 0,
  };
  const emit = opts.onDecision ?? (() => {});

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  // Warm the Rolldog token before the run, as the pipeline page already does.
  // Every briefing now reads the rep's stage checklist, so a cold process makes
  // its first Rolldog call inside the first briefing, and a token fetch that is
  // throttled or slow there surfaces as a bare "fetch failed" that drops the
  // checklist for that deal only. One warm call up front removes the whole
  // class. Best-effort: a missing credential legitimately throws and must not
  // stop briefings from going out.
  await prewarmRolldogToken().catch(() => {});

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
      counts.errors += 1;
      console.error(
        `[briefing-sync] skipping connection ${conn.user_principal_name ?? conn.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    const autoJoin = isAutoJoinRep(conn.user_principal_name);
    for (const ev of events) {
      counts.eventsSeen += 1;
      try {
        await processEvent(ev, tenantId, now, counts, emit, autoJoin);
      } catch (err) {
        counts.errors += 1;
        emit({ kind: "error", eventId: ev.eventId, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return counts;
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

  const db = supabaseAdmin();

  // Resolve the deal by external_id slug.
  const dealRow = await db
    .from("deals")
    .select("id, framework_id, rep_email")
    .eq("tenant_id", tenantId)
    .eq("external_id", dealExternalId)
    .maybeSingle();
  if (dealRow.error) throw new Error(`deals lookup failed: ${dealRow.error.message}`);
  if (!dealRow.data) {
    counts.skippedNoDeal += 1;
    emit({ kind: "no-deal", dealExternalId, eventId: ev.eventId });
    return;
  }
  const dealId = dealRow.data.id;

  // Find the calls row (created by calendar-sync) and the dedupe marker.
  const callRow = await db
    .from("calls")
    .select("id, briefing_sent_at")
    .eq("deal_id", dealId)
    .eq("external_id", ev.eventId)
    .maybeSingle();
  if (callRow.error) throw new Error(`calls lookup failed: ${callRow.error.message}`);

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
      .select("id, briefing_sent_at")
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

  // Attendees with roles when we have contacts; otherwise fall back to the
  // meeting's raw attendee names.
  const attendees =
    ctx.contacts.length > 0
      ? ctx.attendees
      : ev.attendees
          .map((a) => a.name || a.email)
          .filter((n): n is string => typeof n === "string" && n.length > 0)
          .slice(0, 4)
          .join("; ") || undefined;

  const briefing = await generateBriefingFromState({
    ...briefingStateFromContext(ctx),
    attendees: attendees ?? `the ${ctx.account} team`,
    // The calendar title is the only signal we have about what kind of call
    // this is before it happens. Without it every briefing for an account with
    // no captured history reads as a first discovery call.
    meetingSubject: ev.subject,
  });
  if (!briefing) throw new Error("briefing generation returned null");

  const email = renderPreCallBriefingEmail(briefing, {
    account: ctx.account,
    stageKey: ctx.effectiveStageKey,
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
