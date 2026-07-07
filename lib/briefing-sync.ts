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

import type { ExtractionMap } from "./briefing-magaya";
import { attendeesFrom, generateBriefingFromState } from "./generate-briefing";
import { loadFramework } from "./framework";
import { renderPreCallBriefingEmail } from "./emails/pre-call-briefing";
import { MailerConfigError, sendEmail } from "./mailer";
import { listUpcomingMeetings, type NormalizedMeeting } from "./microsoft-graph";
import { matchPilotDomain, matchPilotSubject, repEmailForDeal, rolldogOppIdForDeal } from "./pilot-config";
import { getDealRoom } from "./rolldog";
import { buildExtractionFromRolldog, mergeRolldogAndCalls, stageFromRolldog } from "./rolldog-briefing-context";
import { getDealForTenant } from "./supabase-queries";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

const TENANT_SLUG = "magaya";
const SCAN_WINDOW_DAYS = 1;
// Send a briefing when a pilot meeting is at most this many minutes away and
// still in the future. Every-5-minute cron + dedupe means each meeting fires
// once, roughly 30 to 35 minutes before it starts (or later if a run was
// missed, which is still better than never).
const LEAD_MAX_MINUTES = 35;

export type BriefingSyncCounts = {
  eventsSeen: number;
  matched: number;
  inWindow: number;
  sent: number;
  alreadySent: number;
  skippedNoDeal: number;
  skippedNoCall: number;
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
    errors: 0,
  };
  const emit = opts.onDecision ?? (() => {});

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

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
    for (const ev of events) {
      counts.eventsSeen += 1;
      try {
        await processEvent(ev, tenantId, now, counts, emit);
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
): Promise<void> {
  if (ev.isCancelled || !ev.joinUrl) {
    emit({ kind: "skip", eventId: ev.eventId, reason: "cancelled or no join url" });
    return;
  }
  const attendeeEmails = ev.attendees
    .map((a) => a.email)
    .filter((e): e is string => typeof e === "string" && e.length > 0);
  const match =
    matchPilotDomain(attendeeEmails) ?? matchPilotSubject(ev.subject);
  if (!match) {
    emit({ kind: "skip", eventId: ev.eventId, reason: "no pilot match (domain or subject)" });
    return;
  }
  counts.matched += 1;

  const startMs = startToMs(ev.start);
  if (startMs === null) {
    emit({ kind: "skip", eventId: ev.eventId, reason: "no start time" });
    return;
  }
  const minutesUntil = Math.round((startMs - now) / 60000);
  if (minutesUntil <= 0 || minutesUntil > LEAD_MAX_MINUTES) {
    emit({ kind: "skip", eventId: ev.eventId, reason: `outside window (${minutesUntil} min)` });
    return;
  }
  counts.inWindow += 1;

  const db = supabaseAdmin();

  // Resolve the deal by external_id slug.
  const dealRow = await db
    .from("deals")
    .select("id, framework_id")
    .eq("tenant_id", tenantId)
    .eq("external_id", match.dealExternalId)
    .maybeSingle();
  if (dealRow.error) throw new Error(`deals lookup failed: ${dealRow.error.message}`);
  if (!dealRow.data) {
    counts.skippedNoDeal += 1;
    emit({ kind: "no-deal", dealExternalId: match.dealExternalId, eventId: ev.eventId });
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
  if (!callRow.data) {
    // calendar-sync has not created the row yet; it will, and the next scan
    // (within a few minutes, still inside the window) will send.
    counts.skippedNoCall += 1;
    emit({ kind: "no-call-row", dealExternalId: match.dealExternalId, eventId: ev.eventId });
    return;
  }
  if (callRow.data.briefing_sent_at) {
    counts.alreadySent += 1;
    emit({ kind: "already-sent", account: match.dealExternalId, eventId: ev.eventId });
    return;
  }

  const to = repEmailForDeal(match.dealExternalId);
  if (!to) {
    emit({ kind: "skip", eventId: ev.eventId, reason: `no rep email for '${match.dealExternalId}'` });
    return;
  }

  // Load the full deal + framework and generate the briefing.
  const deal = await getDealForTenant(tenantId, dealId);
  if (!deal) throw new Error(`getDealForTenant returned null for ${dealId}`);
  if (!dealRow.data.framework_id) throw new Error(`deal ${dealId} has no framework`);
  const framework = await loadFramework(tenantId, dealRow.data.framework_id);
  if (!framework) throw new Error(`loadFramework returned null for ${dealRow.data.framework_id}`);

  // Base briefing state on captured-call extractions, then layer live Rolldog
  // context underneath so the brief is grounded even before any call and
  // sharpens as calls accumulate. Rolldog read is best-effort: if it fails or
  // the deal has no mapped opp, fall back to call data only.
  const callExtraction = deal.extraction as unknown as ExtractionMap;
  let extraction = callExtraction;
  let stageKey = deal.stageKey;
  const opp = rolldogOppIdForDeal(match.dealExternalId);
  if (opp) {
    try {
      const room = await getDealRoom(opp);
      extraction = mergeRolldogAndCalls(
        buildExtractionFromRolldog(framework, room),
        callExtraction,
      );
      stageKey = stageFromRolldog(room) ?? deal.stageKey;
    } catch (err) {
      console.warn(
        `[briefing-sync] rolldog context read failed for opp ${opp}: ${
          err instanceof Error ? err.message : String(err)
        }; using call data only`,
      );
    }
  }

  // Attendees with roles, matching the in-app briefing header. Falls back to
  // the meeting's raw attendee names if the deal has no contacts yet.
  const attendees =
    deal.contacts.length > 0
      ? attendeesFrom(deal)
      : ev.attendees
          .map((a) => a.name || a.email)
          .filter((n): n is string => typeof n === "string" && n.length > 0)
          .slice(0, 4)
          .join("; ") || undefined;

  const briefing = await generateBriefingFromState({
    account: deal.account,
    stageKey,
    closeDate: deal.repForecastCloseDate || undefined,
    attendees: attendees ?? `the ${deal.account} team`,
    framework,
    extraction,
  });
  if (!briefing) throw new Error("briefing generation returned null");

  const email = renderPreCallBriefingEmail(briefing, {
    account: deal.account,
    stageKey,
    attendees,
    minutesUntil,
  });

  try {
    await sendEmail({ to, subject: email.subject, html: email.html, text: email.text });
  } catch (err) {
    if (err instanceof MailerConfigError) {
      emit({ kind: "skip", eventId: ev.eventId, reason: `mailer not configured: ${err.message}` });
      return;
    }
    throw err;
  }

  // Mark sent so the next scan does not resend.
  const upd = await db
    .from("calls")
    .update({ briefing_sent_at: new Date().toISOString() })
    .eq("id", callRow.data.id);
  if (upd.error) {
    // The email already went out. Log loudly; a duplicate on the next scan is
    // the worst case, which is far better than a failed send.
    console.error(
      `[briefing-sync] sent briefing for call ${callRow.data.id} but failed to mark briefing_sent_at: ${upd.error.message}`,
    );
  }

  counts.sent += 1;
  emit({ kind: "sent", account: deal.account, eventId: ev.eventId, to, minutesUntil });
}
