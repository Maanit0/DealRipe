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
 *       existing row, bot, start OK   -> participants refresh only
 *       existing row, bot, start moved-> deleteBot(old), createBot(new)
 *         (compared on the start INSTANT: a meeting moved within the same
 *          day must move its bot, and once did not. See the comment there.)
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
import { shouldJoinAutoMeeting } from "./join-gate";
import {
  accountFromAddress,
  isAutoJoinRep,
  resolveMeetingDeal,
} from "./pilot-config";
import { listUpcomingMeetings, type NormalizedMeeting } from "./microsoft-graph";
import { createBot, deleteBot, getBot } from "./recall";
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
  // Future rows pruned because their meeting vanished from the calendar
  // (rescheduled-and-recreated, or hard-deleted; never formally cancelled).
  reconciledVanished: number;
  // New deals auto-created from an auto-join rep's external customer calls.
  autoCreated: number;
  // External meetings the join gate declined: no CRM record and the invite did
  // not read as a sales conversation. Interviews, benefits calls, vendors.
  skippedNotCommercial: number;
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
      kind: "auto-deal";
      eventId: string;
      subject: string | null;
      dealExternalId: string;
      domain: string;
    }
  | {
      kind: "not-commercial";
      eventId: string;
      subject: string | null;
      domain: string;
      reason: string;
      detail: string;
    }
  | {
      kind: "vanished";
      eventId: string;
      callId: string;
      oldBotId: string | null;
    }
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
    reconciledVanished: 0,
    autoCreated: 0,
    skippedNotCommercial: 0,
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

  // Every event id we observe across all calendars this run. Used after the
  // loop to detect rows whose meeting has vanished (see reconcile step).
  const seenEventIds = new Set<string>();

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
    const repEmail = conn.user_principal_name ?? null;
    const autoJoin = isAutoJoinRep(repEmail);
    for (const ev of events) {
      counts.eventsSeen += 1;
      // Record EVERY key shape a row on this meeting could carry, because the
      // vanished reconciler deletes any future row whose key it did not see.
      //
      //   eventId          rows from before the iCalUId change
      //   iCalUId          rows from before the occurrence date was added
      //   iCalUId:date     what processEvent writes now
      //
      // Missing the third would have pruned every upcoming call created under
      // the current scheme, on the first run after deploying it. The key is
      // built the same way here and in processEvent, and if that ever stops
      // being true this is where the damage lands.
      seenEventIds.add(ev.eventId);
      if (ev.iCalUId) {
        seenEventIds.add(ev.iCalUId);
        const day = eventStartToIso(ev.start).slice(0, 10);
        if (day) seenEventIds.add(`${ev.iCalUId}:${day}`);
      }
      try {
        await processEvent(ev, tenantId, counts, emit, { repEmail, autoJoin });
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

  // Reconcile vanished meetings. Only safe when EVERY calendar was read: a
  // skipped connection means a meeting could live on a calendar we didn't see,
  // so we must not prune on that basis.
  if (counts.connectionsSkipped === 0) {
    await reconcileVanishedMeetings(tenantId, seenEventIds, counts, emit);
  }

  return counts;
}

// ====================================================================
// Reconcile vanished meetings
// ====================================================================

// Only reconcile rows comfortably inside the window we actually read, so a
// meeting sitting right at the 7-day edge (which listUpcomingMeetings may or
// may not return) is never mistaken for vanished. One day of slack.
const RECONCILE_WINDOW_DAYS = SYNC_WINDOW_DAYS - 1;

/**
 * Prune future pilot calls rows whose event id was NOT observed on any calendar
 * this run. These are meetings that disappeared without a formal cancellation
 * (rescheduled-and-recreated with a new id, or hard-deleted), which otherwise
 * leave an orphan row that shows as a phantom upcoming call and masks the real
 * one. Scoped to rows inside the read window; the caller guarantees all
 * calendars were read.
 */
async function reconcileVanishedMeetings(
  tenantId: string,
  seenEventIds: Set<string>,
  counts: CalendarSyncCounts,
  emit: (d: CalendarSyncDecision) => void,
): Promise<void> {
  const db = supabaseAdmin();
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const windowEndStr = new Date(now.getTime() + RECONCILE_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  // Future rows the read window should have covered.
  const rows = await db
    .from("calls")
    .select("id, external_id, recall_bot_id, call_date, scheduled_start")
    .eq("tenant_id", tenantId)
    .gte("call_date", todayStr)
    .lte("call_date", windowEndStr);
  if (rows.error) {
    console.error(`[calendar-sync] reconcile read failed: ${rows.error.message}`);
    return;
  }

  const nowMs = now.getTime();

  for (const row of rows.data ?? []) {
    if (!row.external_id || seenEventIds.has(row.external_id)) continue;

    // Never treat a meeting that has already started as "vanished". The calendar
    // read only looks forward from now, so a call earlier today drops out of it
    // the moment it ends. Without this guard that completed call is misread as
    // vanished and its row (transcript, extraction, briefing) is deleted. Only
    // genuinely FUTURE meetings that disappeared before happening are prunable.
    const startMs = row.scheduled_start ? Date.parse(row.scheduled_start) : NaN;
    const startedAlready = Number.isFinite(startMs)
      ? startMs <= nowMs
      : row.call_date === todayStr; // no precise time: don't prune same-day rows
    if (startedAlready) continue;

    // The meeting for this row was not on any calendar this run: it vanished.
    if (row.recall_bot_id) {
      try {
        await deleteBot(row.recall_bot_id);
      } catch (err) {
        // Best-effort: prune the row anyway so the phantom clears; a stray bot
        // will simply join nothing.
        console.error(
          `[calendar-sync] reconcile: deleteBot ${row.recall_bot_id} failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    const del = await db.from("calls").delete().eq("id", row.id);
    if (del.error) {
      console.error(
        `[calendar-sync] reconcile: delete call ${row.id} failed: ${del.error.message}`,
      );
      continue;
    }
    counts.reconciledVanished += 1;
    emit({
      kind: "vanished",
      eventId: row.external_id,
      callId: row.id,
      oldBotId: row.recall_bot_id ?? null,
    });
  }
}

// ====================================================================
// Per-event state machine
// ====================================================================

async function processEvent(
  ev: NormalizedMeeting,
  tenantId: string,
  counts: CalendarSyncCounts,
  emit: (d: CalendarSyncDecision) => void,
  opts: { repEmail: string | null; autoJoin: boolean },
): Promise<void> {
  if (!ev.joinUrl) {
    emit({ kind: "no-join-url", eventId: ev.eventId, subject: ev.subject });
    return;
  }

  const attendeeEmails = ev.attendees
    .map((a) => a.email)
    .filter((e): e is string => typeof e === "string" && e.length > 0);

  // Resolve which deal this meeting belongs to: a hand-seeded pilot deal, or,
  // for an auto-join rep with an external customer on the invite, an auto deal
  // created on the fly. Write-back stays gated (an auto deal has no mapped opp),
  // so it records + briefs + recaps but never writes to Rolldog until mapped.
  const resolved = resolveMeetingDeal(attendeeEmails, ev.subject, opts.autoJoin);
  if (!resolved) {
    emit({
      kind: "no-pilot-match",
      eventId: ev.eventId,
      subject: ev.subject,
      attendeeEmails,
    });
    return;
  }
  const dealExternalId = resolved.dealExternalId;
  if (resolved.isAuto && resolved.domain && resolved.address) {
    // An external attendee is not on its own a reason to record someone. Require
    // positive evidence this is a commercial conversation before a bot joins.
    // Without this, auto-join walks into 1-on-1s, benefits calls and candidate
    // interviews on calendars nobody has inspected.
    const verdict = await shouldJoinAutoMeeting({
      tenantId,
      dealExternalId,
      domain: resolved.domain,
      address: resolved.address,
      isFreeMail: resolved.isFreeMail === true,
      subject: ev.subject,
      attendeeEmails,
      sellerName: "Magaya",
    });
    if (!verdict.join) {
      counts.skippedNotCommercial += 1;
      emit({
        kind: "not-commercial",
        eventId: ev.eventId,
        subject: ev.subject,
        domain: resolved.domain,
        reason: verdict.reason,
        detail: verdict.detail,
      });
      return;
    }

    // For consumer mail the domain is meaningless as a name ("Gmail"), so pass
    // the attendee's calendar display name through for a human account label.
    const displayName =
      ev.attendees.find((a) => (a.email ?? "").toLowerCase() === resolved.address)?.name ?? null;
    const r = await ensureAutoDeal(
      tenantId,
      dealExternalId,
      resolved.domain,
      opts.repEmail,
      { address: resolved.address, displayName, isFreeMail: resolved.isFreeMail, subject: ev.subject },
    );
    if (r.created) {
      counts.autoCreated += 1;
      emit({
        kind: "auto-deal",
        eventId: ev.eventId,
        subject: ev.subject,
        dealExternalId,
        domain: resolved.domain,
      });
    }
  }

  counts.matched += 1;

  const db = supabaseAdmin();
  const dealRow = await db
    .from("deals")
    .select("id, rep_email")
    .eq("tenant_id", tenantId)
    .eq("external_id", dealExternalId)
    .maybeSingle();
  if (dealRow.error) {
    throw new Error(`deals lookup failed: ${dealRow.error.message}`);
  }
  if (!dealRow.data) {
    counts.skippedNoDeal += 1;
    console.warn(
      `[calendar-sync] no deal with external_id='${dealExternalId}' in tenant '${TENANT_SLUG}'; not auto-creating. eventId=${ev.eventId}`,
    );
    emit({
      kind: "no-deal",
      eventId: ev.eventId,
      subject: ev.subject,
      dealExternalId: dealExternalId,
    });
    return;
  }

  const dealId = dealRow.data.id;

  // Auto-heal rep ownership: any deal we see on a rep's calendar gets its
  // rep_email filled when it was missing (seeded deals never set it). Only
  // fills a null, never reassigns a deal that already has an owner. Best
  // effort: a failure here must not abort the sync.
  if (!dealRow.data.rep_email && opts.repEmail) {
    const heal = await db.from("deals").update({ rep_email: opts.repEmail }).eq("id", dealId);
    if (heal.error) {
      console.warn(
        `[calendar-sync] rep_email backfill failed for ${dealExternalId}: ${heal.error.message}`,
      );
    }
  }

  const eventIso = eventStartToIso(ev.start);
  const eventDate = eventIso.slice(0, 10);

  // Key the call on iCalUId, which is the same value in every attendee's
  // mailbox. `id` is per-mailbox, so when two reps are on the same customer
  // meeting each copy looked like a separate call: two rows, two bots joining
  // the customer's session, two transcripts, two recaps and a doubled
  // write-back. Alexandra and Daniel are both on Thursday's ILS demo.
  //
  // The occurrence date is part of the key, because iCalUId is stable across
  // OCCURRENCES too, not just mailboxes. A recurring meeting therefore produced
  // one row for the whole series: the first occurrence was captured, then every
  // later occurrence matched that same row and pushed its date forward. The
  // Luke Rousselle row on 2026-08-11 held a no-show transcript from an earlier
  // week while showing a date three days in the future, so it appeared in both
  // Recorded and Upcoming at once.
  //
  // Adding the date keeps the co-sold dedup intact, since two reps on the same
  // occurrence share both the iCalUId and the day.
  const seriesKey = ev.iCalUId ?? null;
  const callKey = seriesKey ? `${seriesKey}:${eventDate}` : ev.eventId;

  // Match the new key, the per-mailbox id, and the bare iCalUId for rows
  // written before the date was part of the key.
  const candidates = seriesKey ? [callKey, ev.eventId, seriesKey] : [ev.eventId];
  const found = await db
    .from("calls")
    .select("id, recall_bot_id, call_date, scheduled_start, external_id")
    .eq("deal_id", dealId)
    .in("external_id", candidates)
    .limit(3);
  if (found.error) {
    throw new Error(`calls lookup failed: ${found.error.message}`);
  }

  // A legacy row keyed on the bare iCalUId belongs to whichever occurrence it
  // actually captured. Adopt it only if its date is this occurrence; otherwise
  // this is a different week and needs its own row, which is the entire point.
  const rows = found.data ?? [];
  const match =
    rows.find((r) => r.external_id === callKey || r.external_id === ev.eventId) ??
    rows.find(
      (r) =>
        r.external_id === seriesKey &&
        String(r.scheduled_start ?? r.call_date ?? "").slice(0, 10) === eventDate,
    ) ??
    null;
  const existing = { data: match, error: null as null };

  // Neither key matched. That does NOT mean this meeting is new.
  //
  // The lookup above handles one identifier changing FORM, from a Graph event
  // id to an iCalUId. It cannot handle the invite being re-issued, which mints a
  // genuinely new iCalUId. When that happens we insert a second row for a
  // meeting that already has one, and the work splits across the pair: on
  // August 11 Gezairi had its briefing on the new row and its capture, recap and
  // draft on the original, so the Activity card read "Briefing never sent" next
  // to a completed recap. FTZ had the bot on the Monday row and a second row
  // created 25 minutes before the call.
  //
  // A rep cannot be in two customer meetings on the same deal at the same
  // instant, so a row matching on deal plus start is the same meeting. Adopt it.
  // Adopting rather than inserting is the point: the older row usually holds the
  // already-dispatched bot, and a new row silently orphans that bot's work.
  let adopted: typeof existing.data = null;
  if (!existing.data) {
    const sameSlot = await db
      .from("calls")
      .select("id, recall_bot_id, call_date, external_id, scheduled_start")
      .eq("deal_id", dealId)
      .eq("scheduled_start", eventIso)
      .limit(2);
    if (sameSlot.error) {
      // Say what we could not check. Falling through to an insert here would
      // create exactly the duplicate this branch exists to prevent, and it would
      // do so silently.
      console.warn(
        `[calendar-sync] same-slot lookup failed for deal ${dealId} at ${eventIso}, ` +
          `so a duplicate row may be created: ${sameSlot.error.message}`,
      );
    } else if ((sameSlot.data ?? []).length === 1) {
      adopted = sameSlot.data![0];
      const mig = await db
        .from("calls")
        .update({ external_id: callKey })
        .eq("id", adopted.id);
      if (mig.error) {
        console.warn(
          `[calendar-sync] could not adopt call ${adopted.id} onto re-issued key ${callKey}: ${mig.error.message}`,
        );
        adopted = null;
      } else {
        console.log(
          `[calendar-sync] adopted existing call ${adopted.id} for deal ${dealId} at ${eventIso} ` +
            `onto re-issued invite key ${callKey}, rather than creating a duplicate row`,
        );
      }
    } else if ((sameSlot.data ?? []).length > 1) {
      // Already duplicated. Do not guess which one to adopt; that is what
      // scripts/merge-duplicate-calls.ts is for, and picking wrong here would
      // move the bot away from the row that captures.
      console.warn(
        `[calendar-sync] ${sameSlot.data!.length} existing calls for deal ${dealId} at ${eventIso}. ` +
          `Not adopting. Run scripts/merge-duplicate-calls.ts.`,
      );
    }
  }
  if (adopted) {
    existing.data = adopted;
  }

  // Migrate a legacy row onto the stable key so the other rep's copy finds it.
  if (existing.data && existing.data.external_id !== callKey) {
    const mig = await db.from("calls").update({ external_id: callKey }).eq("id", existing.data.id);
    if (mig.error) {
      console.warn(`[calendar-sync] could not migrate call ${existing.data.id} to iCalUId: ${mig.error.message}`);
    }
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
        external_id: callKey,
        call_date: eventDate,
        scheduled_start: eventIso,
        participants: ev.attendees as unknown as Json,
        source: "recall_ai",
        title: ev.subject,
        // Whose waiting room the bot will land in. See
        // supabase/add-call-organizer.sql for why this is the field that
        // decides what to do about a call nobody admitted the bot to.
        organizer_email: ev.organizerEmail,
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
      await recordDispatchFailure(callId, err, "createBot(new)");
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
      .update({ recall_bot_id: bot.id, capture_detail: null, capture_checked_at: null })
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

  // Compare the START INSTANT, not the calendar day.
  //
  // This used to read `callRow.call_date !== eventDate`, which only noticed a
  // meeting moving to a different DAY. A meeting moved within the same day left
  // its bot on the old time, and the branch below at "Same date, bot dispatched"
  // then wrote the NEW scheduled_start onto the row and emitted no-change. So
  // the row said one time, the bot held another, and nothing anywhere reported a
  // disagreement.
  //
  // That cost a real call. Green Java on 2026-08-13 moved to 17:30Z; its bot was
  // still booked for 15:00Z, arrived 150 minutes early, sat in a waiting room
  // for a meeting nobody had joined yet, and Recall closed it out with
  // timeout_exceeded_waiting_room. The transcript is unrecoverable.
  //
  // A null scheduled_start is a legacy row we cannot compare instants on, so it
  // falls back to the day check rather than pretending the times match.
  const startChanged =
    callRow.scheduled_start === null
      ? callRow.call_date !== eventDate
      : Date.parse(callRow.scheduled_start) !== Date.parse(eventIso);

  if (currentBotId && startChanged) {
    // Never destroy a bot that already has a recording. Rescheduling assumes
    // the old bot has nothing worth keeping, which is true for a future meeting
    // and false for one already captured, and deleting the bot would take its
    // media with it. If we cannot tell, do not delete: a duplicate bot costs
    // money, a deleted recording costs the call.
    let oldBotHasWork: boolean | null = null;
    try {
      const oldBot = await getBot(currentBotId);
      oldBotHasWork = oldBot.hasMedia || oldBot.recordingId !== null;
    } catch (err) {
      console.error(
        `[calendar-sync] could not inspect bot ${currentBotId} before reschedule, so leaving it in place: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      oldBotHasWork = null;
    }
    if (oldBotHasWork !== false) {
      console.warn(
        `[calendar-sync] call ${callRow.id} moved to ${eventIso} but its bot ${currentBotId} ` +
          `${oldBotHasWork === null ? "could not be inspected" : "already holds a recording"}; ` +
          `not replacing it. This needs a human.`,
      );
      emit({
        kind: "error",
        eventId: ev.eventId,
        subject: ev.subject,
        phase: "reschedule-guard",
        message:
          oldBotHasWork === null
            ? `bot ${currentBotId} could not be inspected before reschedule`
            : `bot ${currentBotId} already recorded; refusing to delete it`,
      });
      return;
    }

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
        scheduled_start: eventIso,
        participants: ev.attendees as unknown as Json,
        organizer_email: ev.organizerEmail,
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
      await recordDispatchFailure(callRow.id, err, "createBot(retry)");
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
        scheduled_start: eventIso,
        participants: ev.attendees as unknown as Json,
        organizer_email: ev.organizerEmail,
        capture_detail: null,
        capture_checked_at: null,
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

  // Same start instant, bot dispatched. Refresh participants in case attendees
  // changed. Reaching here with a moved start is the bug described above: this
  // update would write the new time onto the row while the bot kept the old one.
  const upd = await db
    .from("calls")
    .update({
      scheduled_start: eventIso,
      participants: ev.attendees as unknown as Json,
      // Refreshed on every pass so rows created before this column existed
      // fill in on their next sync, rather than only new meetings having it.
      organizer_email: ev.organizerEmail,
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

/**
 * Write down that a bot was never dispatched, on the call itself.
 *
 * Found on 2026-08-16 by scripts/capture-health.ts. A call for Sunny Wing
 * Logistics on 08-12 carried recall_bot_id null, outcome null, no
 * ingest_error, and had sat untouched for four days. createBot had failed and
 * the only trace was an emit that reached a log line and nothing durable.
 *
 * Nothing was ever going to find it. transcript-sync's main loop filters on
 * recall_bot_id not null, capture-failures.ts queries outcome='capture_failed',
 * and every rep and CRO view skips a call with no outcome. The retry branch
 * above does re-dispatch a row with no bot, but only while the meeting is
 * still ahead of us on the calendar: once it is in the past the event leaves
 * the lookahead window and the row is orphaned permanently.
 *
 * This does not recover the call, which is not recoverable. It makes the
 * failure legible so the next one is noticed in five minutes rather than in
 * four days, and only if someone happens to look.
 *
 * Best-effort by design. Recording why a bot was not dispatched must never be
 * the thing that stops the rest of the calendar syncing.
 */
async function recordDispatchFailure(
  callId: string,
  err: unknown,
  phase: string,
): Promise<void> {
  try {
    const message = err instanceof Error ? err.message : String(err);
    await supabaseAdmin()
      .from("calls")
      .update({
        // capture_evidence stays 'not_checked': there is no bot, so Recall has
        // nothing to tell us about this meeting and never will. Saying we
        // checked would be the exact lie this column exists to prevent.
        capture_detail: `no bot was dispatched: ${phase} failed with ${message}`,
        capture_checked_at: new Date().toISOString(),
      })
      .eq("id", callId);
  } catch {
    // Deliberately swallowed. See above.
  }
}

/**
 * Ensure an auto-created deal exists for a customer domain. Inserts a minimal
 * deal (placeholder account name, the tenant framework, stage SQL0, the rep's
 * email for recap routing) only if one isn't already there, so a hand-edited
 * account name is never overwritten on a later sync. Returns whether it created.
 */
async function ensureAutoDeal(
  tenantId: string,
  externalId: string,
  domain: string,
  repEmail: string | null,
  who: { address: string; displayName: string | null; isFreeMail: boolean; subject?: string | null },
): Promise<{ created: boolean }> {
  const db = supabaseAdmin();
  const existing = await db
    .from("deals")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("external_id", externalId)
    .maybeSingle();
  if (existing.error) {
    throw new Error(`auto-deal lookup failed for ${externalId}: ${existing.error.message}`);
  }
  if (existing.data) return { created: false };

  const frameworkId = await resolveTenantFrameworkId(db, tenantId);

  const ins = await db.from("deals").insert({
    tenant_id: tenantId,
    external_id: externalId,
    account: accountFromAddress(who.address, who.displayName, who.subject),
    stage_key: "SQL0",
    framework_id: frameworkId,
    rep_email: repEmail,
    rep_notes: who.isFreeMail
      ? `Auto-created from ${repEmail ?? "rep"}'s calendar. ${who.address} is consumer mail, so this deal is keyed to the person, not the domain. Set the real company name.`
      : `Auto-created from ${repEmail ?? "rep"}'s calendar (${domain}). Placeholder account name; edit if needed.`,
  });
  if (ins.error) {
    throw new Error(`auto-deal create failed for ${externalId}: ${ins.error.message}`);
  }
  return { created: true };
}

/**
 * Pick the framework a new auto-deal should use. An auto deal must qualify on
 * the tenant's REAL framework (Magaya's Rolldog Stage Gates), the same one the
 * seeded pilot deals use, never a leftover builtin (e.g. the SCOTSMAN seed).
 * So prefer the tenant's `rolldog` framework; only if the tenant has none do we
 * fall back to any framework. Returns null if the tenant has no framework.
 */
async function resolveTenantFrameworkId(
  db: ReturnType<typeof supabaseAdmin>,
  tenantId: string,
): Promise<string | null> {
  const rolldog = await db
    .from("qualification_frameworks")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("source", "rolldog")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (rolldog.data?.id) return rolldog.data.id;

  const any = await db
    .from("qualification_frameworks")
    .select("id")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return any.data?.id ?? null;
}

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
