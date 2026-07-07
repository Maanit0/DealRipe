/**
 * Calendar -> Recall dispatch glue.
 *
 * For every microsoft_connection on the magaya tenant, list the next 7
 * days of events. For each event:
 *
 *   - Skip if no joinUrl, no attendees, or no attendee email matches
 *     PILOT_CUSTOMER_DOMAINS. Only counted; no log line.
 *   - Otherwise resolve the deal (tenant=magaya, external_id=dealExternalId).
 *     Skip with a warning if the deal does not exist; we never auto-create
 *     deals.
 *   - Upsert a calls row keyed (deal_id, event_id). Source = 'recall_ai'.
 *   - State machine on the (existing calls row x event state) cross product:
 *       new row, not cancelled        -> createBot, persist recall_bot_id
 *       existing row, no bot, !cancel -> createBot
 *       existing row, bot, date OK    -> participants refresh only
 *       existing row, bot, date moved -> deleteBot(old), createBot(new)
 *       cancelled, bot                -> deleteBot, null recall_bot_id
 *       cancelled, no bot             -> no-op
 *
 *   - createBot/deleteBot are best-effort: an exception against any one
 *     event emits an "error" decision and moves on; the rest of the sync
 *     proceeds.
 *
 * The function returns aggregate counts. Per-event observation is via an
 * optional onDecision hook so the cron path stays silent while the test
 * script can print every decision.
 */

import type { Json } from "./database.types";
import { matchPilotDomain, matchPilotSubject } from "./pilot-config";
import { listUpcomingMeetings, type NormalizedMeeting } from "./microsoft-graph";
import { createBot, deleteBot } from "./recall";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

const TENANT_SLUG = "magaya";
const SYNC_WINDOW_DAYS = 7;

export type CalendarSyncCounts = {
  eventsSeen: number;
  matched: number;
  botsCreated: number;
  rescheduled: number;
  cancelled: number;
  skippedNoDeal: number;
  connectionsSkipped: number;
};

export type CalendarSyncDecision =
  | { kind: "no-join-url"; eventId: string; subject: string | null }
  | { kind: "no-attendees"; eventId: string; subject: string | null }
  | {
      kind: "no-pilot-match";
      eventId: string;
      subject: string | null;
      attendeeEmails: string[];
    }
  | {
      kind: "no-deal";
      eventId: string;
      subject: string | null;
      dealExternalId: string;
    }
  | {
      kind: "created";
      eventId: string;
      subject: string | null;
      recallBotId: string;
    }
  | {
      kind: "rescheduled";
      eventId: string;
      subject: string | null;
      oldBotId: string | null;
      newBotId: string;
    }
  | {
      kind: "cancelled";
      eventId: string;
      subject: string | null;
      oldBotId: string;
    }
  | { kind: "no-change"; eventId: string; subject: string | null }
  | {
      kind: "error";
      eventId: string;
      subject: string | null;
      phase: string;
      message: string;
    };

export type CalendarSyncOptions = {
  onDecision?: (decision: CalendarSyncDecision) => void;
};

export async function runCalendarSync(
  opts: CalendarSyncOptions = {},
): Promise<CalendarSyncCounts> {
  const counts: CalendarSyncCounts = {
    eventsSeen: 0,
    matched: 0,
    botsCreated: 0,
    rescheduled: 0,
    cancelled: 0,
    skippedNoDeal: 0,
    connectionsSkipped: 0,
  };
  const emit = opts.onDecision ?? (() => {});

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const connections = await db
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  if (connections.error) {
    throw new Error(
      `[calendar-sync] failed to list microsoft_connections: ${connections.error.message}`,
    );
  }
  if (!connections.data || connections.data.length === 0) {
    return counts;
  }

  for (const conn of connections.data) {
    // One bad calendar (no mailbox, revoked token, on-prem Exchange) must not
    // abort the whole run. Skip it, log which account, and continue.
    let events;
    try {
      events = await listUpcomingMeetings(conn.id, SYNC_WINDOW_DAYS);
    } catch (err) {
      counts.connectionsSkipped += 1;
      console.error(
        `[calendar-sync] skipping connection ${conn.user_principal_name ?? conn.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
    for (const ev of events) {
      counts.eventsSeen += 1;
      try {
        await processEvent(ev, tenantId, counts, emit);
      } catch (err) {
        emit({
          kind: "error",
          eventId: ev.eventId,
          subject: ev.subject,
          phase: "process",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return counts;
}

// ====================================================================
// Per-event state machine
// ====================================================================

async function processEvent(
  ev: NormalizedMeeting,
  tenantId: string,
  counts: CalendarSyncCounts,
  emit: (d: CalendarSyncDecision) => void,
): Promise<void> {
  if (!ev.joinUrl) {
    emit({ kind: "no-join-url", eventId: ev.eventId, subject: ev.subject });
    return;
  }

  const attendeeEmails = ev.attendees
    .map((a) => a.email)
    .filter((e): e is string => typeof e === "string" && e.length > 0);

  // Match by customer domain first; fall back to the deal name in the subject
  // so we still catch pilot calls where the customer is not an invited guest.
  const match =
    matchPilotDomain(attendeeEmails) ?? matchPilotSubject(ev.subject);
  if (!match) {
    emit({
      kind: "no-pilot-match",
      eventId: ev.eventId,
      subject: ev.subject,
      attendeeEmails,
    });
    return;
  }

  counts.matched += 1;

  const db = supabaseAdmin();
  const dealRow = await db
    .from("deals")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("external_id", match.dealExternalId)
    .maybeSingle();
  if (dealRow.error) {
    throw new Error(`deals lookup failed: ${dealRow.error.message}`);
  }
  if (!dealRow.data) {
    counts.skippedNoDeal += 1;
    console.warn(
      `[calendar-sync] no deal with external_id='${match.dealExternalId}' in tenant '${TENANT_SLUG}'; not auto-creating. eventId=${ev.eventId}`,
    );
    emit({
      kind: "no-deal",
      eventId: ev.eventId,
      subject: ev.subject,
      dealExternalId: match.dealExternalId,
    });
    return;
  }

  const dealId = dealRow.data.id;
  const eventIso = eventStartToIso(ev.start);
  const eventDate = eventIso.slice(0, 10);

  const existing = await db
    .from("calls")
    .select("id, recall_bot_id, call_date")
    .eq("deal_id", dealId)
    .eq("external_id", ev.eventId)
    .maybeSingle();
  if (existing.error) {
    throw new Error(`calls lookup failed: ${existing.error.message}`);
  }

  // ----- Cancelled event branch. -----

  if (ev.isCancelled) {
    if (!existing.data) {
      // Nothing to cancel; never created. Don't insert a tombstone row.
      return;
    }
    if (!existing.data.recall_bot_id) {
      // Already cancelled or never dispatched. No-op.
      return;
    }
    const oldBotId = existing.data.recall_bot_id;
    try {
      await deleteBot(oldBotId);
    } catch (err) {
      emit({
        kind: "error",
        eventId: ev.eventId,
        subject: ev.subject,
        phase: "deleteBot(cancel)",
        message: err instanceof Error ? err.message : String(err),
      });
      // Continue: still clear the local pointer so we don't keep trying.
    }
    const upd = await db
      .from("calls")
      .update({
        recall_bot_id: null,
        call_date: eventDate,
        participants: ev.attendees as unknown as Json,
      })
      .eq("id", existing.data.id);
    if (upd.error) {
      throw new Error(`calls update failed (cancel): ${upd.error.message}`);
    }
    counts.cancelled += 1;
    emit({
      kind: "cancelled",
      eventId: ev.eventId,
      subject: ev.subject,
      oldBotId,
    });
    return;
  }

  // ----- Live event branches. -----

  if (!existing.data) {
    // New row. Insert WITHOUT bot id first so a createBot failure leaves a
    // clean retry path on the next sync; insert success without bot id
    // means the next branch (existing row + no bot) takes over.
    const ins = await db
      .from("calls")
      .insert({
        tenant_id: tenantId,
        deal_id: dealId,
        external_id: ev.eventId,
        call_date: eventDate,
        participants: ev.attendees as unknown as Json,
        source: "recall_ai",
      })
      .select("id")
      .single();
    if (ins.error) {
      throw new Error(`calls insert failed: ${ins.error.message}`);
    }
    const callId = ins.data.id;

    let bot;
    try {
      bot = await createBot({ meetingUrl: ev.joinUrl, joinAt: eventIso });
    } catch (err) {
      emit({
        kind: "error",
        eventId: ev.eventId,
        subject: ev.subject,
        phase: "createBot(new)",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const upd = await db
      .from("calls")
      .update({ recall_bot_id: bot.id })
      .eq("id", callId);
    if (upd.error) {
      console.error(
        `[calendar-sync] LEAK: created bot ${bot.id} but failed to persist on call ${callId}: ${upd.error.message}`,
      );
      emit({
        kind: "error",
        eventId: ev.eventId,
        subject: ev.subject,
        phase: "persist-new-bot-id",
        message: upd.error.message,
      });
      return;
    }
    counts.botsCreated += 1;
    emit({
      kind: "created",
      eventId: ev.eventId,
      subject: ev.subject,
      recallBotId: bot.id,
    });
    return;
  }

  // Existing row.
  const callRow = existing.data;
  const currentBotId = callRow.recall_bot_id;
  const dateChanged = callRow.call_date !== eventDate;

  if (currentBotId && dateChanged) {
    // Reschedule: kill the old bot, dispatch a new one.
    try {
      await deleteBot(currentBotId);
    } catch (err) {
      // Best-effort; the old bot may have already joined or self-cleaned.
      console.error(
        `[calendar-sync] deleteBot failed during reschedule for bot ${currentBotId}:`,
        err instanceof Error ? err.message : err,
      );
    }
    let newBot;
    try {
      newBot = await createBot({ meetingUrl: ev.joinUrl, joinAt: eventIso });
    } catch (err) {
      // Reset the bot pointer so the next sync can retry from scratch.
      const reset = await db
        .from("calls")
        .update({ recall_bot_id: null, call_date: eventDate })
        .eq("id", callRow.id);
      if (reset.error) {
        console.error(
          `[calendar-sync] could not reset bot pointer after failed reschedule on call ${callRow.id}: ${reset.error.message}`,
        );
      }
      emit({
        kind: "error",
        eventId: ev.eventId,
        subject: ev.subject,
        phase: "createBot(reschedule)",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const upd = await db
      .from("calls")
      .update({
        recall_bot_id: newBot.id,
        call_date: eventDate,
        participants: ev.attendees as unknown as Json,
      })
      .eq("id", callRow.id);
    if (upd.error) {
      console.error(
        `[calendar-sync] LEAK: created replacement bot ${newBot.id} but failed to persist on call ${callRow.id}: ${upd.error.message}`,
      );
      emit({
        kind: "error",
        eventId: ev.eventId,
        subject: ev.subject,
        phase: "persist-reschedule",
        message: upd.error.message,
      });
      return;
    }
    counts.rescheduled += 1;
    emit({
      kind: "rescheduled",
      eventId: ev.eventId,
      subject: ev.subject,
      oldBotId: currentBotId,
      newBotId: newBot.id,
    });
    return;
  }

  if (!currentBotId) {
    // Row exists but no bot (previous sync interrupted between insert
    // and createBot). Dispatch the bot.
    let bot;
    try {
      bot = await createBot({ meetingUrl: ev.joinUrl, joinAt: eventIso });
    } catch (err) {
      emit({
        kind: "error",
        eventId: ev.eventId,
        subject: ev.subject,
        phase: "createBot(retry)",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const upd = await db
      .from("calls")
      .update({
        recall_bot_id: bot.id,
        call_date: eventDate,
        participants: ev.attendees as unknown as Json,
      })
      .eq("id", callRow.id);
    if (upd.error) {
      console.error(
        `[calendar-sync] LEAK: created bot ${bot.id} but failed to persist on call ${callRow.id}: ${upd.error.message}`,
      );
      emit({
        kind: "error",
        eventId: ev.eventId,
        subject: ev.subject,
        phase: "persist-retry-bot-id",
        message: upd.error.message,
      });
      return;
    }
    counts.botsCreated += 1;
    emit({
      kind: "created",
      eventId: ev.eventId,
      subject: ev.subject,
      recallBotId: bot.id,
    });
    return;
  }

  // Same date, bot dispatched. Refresh participants in case attendees changed.
  const upd = await db
    .from("calls")
    .update({
      participants: ev.attendees as unknown as Json,
    })
    .eq("id", callRow.id);
  if (upd.error) {
    throw new Error(
      `calls participants refresh failed: ${upd.error.message}`,
    );
  }
  emit({ kind: "no-change", eventId: ev.eventId, subject: ev.subject });
}

// ====================================================================
// Helpers
// ====================================================================

function eventStartToIso(start: NormalizedMeeting["start"]): string {
  if (!start) {
    throw new Error("event has no start");
  }
  // microsoft-graph.ts sets Prefer: outlook.timezone="UTC", but Microsoft's
  // dateTime strings come back without the Z suffix. Append it for UTC.
  const raw =
    start.timeZone === "UTC" && !start.dateTime.endsWith("Z")
      ? start.dateTime + "Z"
      : start.dateTime;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`unparseable event start: ${start.dateTime} (${start.timeZone})`);
  }
  return parsed.toISOString();
}
