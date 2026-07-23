/**
 * Bot lifecycle -> transcript ingest glue.
 *
 * Finds every calls row that:
 *   - source = 'recall_ai'
 *   - recall_bot_id is not null
 *   - has_been_extracted = false
 *
 * For each, polls Recall:
 *   - non-terminal status   -> count and skip
 *   - status = "fatal"      -> write ingest_error, count, skip
 *   - status = "done"       -> getTranscript, then:
 *
 *       1. PERSIST TRANSCRIPT BODY (persistTranscriptBody).
 *          This is the durability gate. If it fails, set ingest_error
 *          and SKIP deleteSourceRecording. The Recall copy stays
 *          available for the next sync run.
 *
 *       2. Mark has_been_extracted = true. After this point the call
 *          will not be re-polled, but the transcript body is already
 *          durable; --retry-ingest can re-run extraction from it.
 *
 *       3. Run extraction (ingestTranscript, source=recall_ai). Failure
 *          past this point sets ingest_error but does NOT abort the
 *          pipeline — the body is durable, so step 4 still runs.
 *
 *       4. deleteSourceRecording. Honors the DPA delete-after-pull
 *          commitment. Safe to run regardless of extraction outcome
 *          because the body is already in the transcripts table.
 *
 * Production rehearsal fix (2026-06-06): step 1 was previously embedded
 * inside step 3 (ingestTranscript wrote the transcripts row as part of
 * writeAuditTrail), which meant a FrameworkNotConfiguredError thrown
 * BEFORE writeAuditTrail ran left has_been_extracted=true with no
 * transcripts row. Body was lost when Recall expired the media. Now
 * persistence is an explicit first step.
 */

import {
  TranscriptPersistError,
  deleteSourceRecording,
  ingestTranscript,
  persistTranscriptBody,
} from "./transcript-ingest";
import type { ExtractionMap } from "./briefing-magaya";
import { sendPostCallSummary } from "./post-call-notify";
import { sendNoShowFollowup } from "./no-show-followup";
import { logNoShowToRolldog, writeBackDealToRolldog } from "./rolldog-writeback";
import { getBot, getTranscript, recordingDurationMinutes, type BotStatus } from "./recall";
import { extractContactsFromTranscript, upsertDealContacts } from "./contacts-extract";
import { classifyCallSubtype, classifyMeetingType } from "./meeting-classify";
import { rolldogOppIdForDeal } from "./pilot-config";
import { supabaseAdmin } from "./supabase";

export type TranscriptSyncCounts = {
  pollBots: number;
  inProgress: number;
  fatal: number;
  bodiesPersisted: number;
  extracted: number;
  mediaDeleted: number;
  ingestErrors: number;
  // Second-pass recovery of extractions that failed after the transcript was
  // already saved (e.g. an LLM timeout). Capped at 3 retries per call.
  retriesAttempted: number;
  retriesRecovered: number;
};

export type TranscriptSyncDecision =
  | {
      kind: "in-progress";
      callId: string;
      recallBotId: string;
      status: BotStatus;
      rawStatus: string;
    }
  | {
      kind: "fatal";
      callId: string;
      recallBotId: string;
      rawStatus: string;
    }
  | {
      kind: "extracted";
      callId: string;
      recallBotId: string;
    }
  | {
      kind: "media-deleted";
      callId: string;
      recallBotId: string;
    }
  | {
      kind: "ingest-error";
      callId: string;
      recallBotId: string;
      phase:
        | "getBot"
        | "getTranscript"
        | "persist"
        | "mark"
        | "ingest"
        | "delete";
      message: string;
    };

export type TranscriptSyncOptions = {
  onDecision?: (decision: TranscriptSyncDecision) => void;
};

export async function runTranscriptSync(
  opts: TranscriptSyncOptions = {},
): Promise<TranscriptSyncCounts> {
  const counts: TranscriptSyncCounts = {
    pollBots: 0,
    inProgress: 0,
    fatal: 0,
    bodiesPersisted: 0,
    extracted: 0,
    mediaDeleted: 0,
    ingestErrors: 0,
    retriesAttempted: 0,
    retriesRecovered: 0,
  };
  const emit = opts.onDecision ?? (() => {});

  const db = supabaseAdmin();
  const rows = await db
    .from("calls")
    .select("id, tenant_id, external_id, recall_bot_id")
    .eq("source", "recall_ai")
    .eq("has_been_extracted", false)
    .not("recall_bot_id", "is", null);
  if (rows.error) {
    throw new Error(
      `[transcript-sync] failed to list pending calls: ${rows.error.message}`,
    );
  }

  for (const row of rows.data ?? []) {
    if (!row.recall_bot_id || !row.external_id) continue;
    counts.pollBots += 1;
    await processRow(
      {
        callId: row.id,
        tenantId: row.tenant_id,
        externalCallId: row.external_id,
        recallBotId: row.recall_bot_id,
      },
      counts,
      emit,
    );
  }

  // Second pass: recover calls whose transcript was saved but whose extraction
  // failed (they carry has_been_extracted=true, so the loop above skips them).
  await retryFailedExtractions(counts, emit);

  return counts;
}

const MAX_INGEST_RETRIES = 3;

function parseRetryCount(err: string | null): number {
  const m = (err ?? "").match(/\[retry (\d+)\/\d+\]/);
  return m ? Number(m[1]) : 0;
}

function stripMarker(err: string | null): string {
  return (err ?? "").replace(/\[(?:retry \d+\/\d+|gave up[^\]]*)\]\s*/g, "");
}

/**
 * Re-run extraction from the stored transcript for calls whose first attempt
 * failed after the body was saved (typically an LLM timeout). Capped at
 * MAX_INGEST_RETRIES per call, tracked via a [retry N/3] marker in ingest_error
 * so no schema column is needed. After the cap it is marked "[gave up ...]" and
 * left for manual attention instead of looping forever (which would burn LLM
 * calls). One retry per 5-minute cron run gives natural backoff.
 */
async function retryFailedExtractions(
  counts: TranscriptSyncCounts,
  emit: (d: TranscriptSyncDecision) => void,
): Promise<void> {
  const db = supabaseAdmin();
  const rows = await db
    .from("calls")
    .select("id, tenant_id, external_id, ingest_error")
    .eq("source", "recall_ai")
    .eq("has_been_extracted", true)
    .not("ingest_error", "is", null)
    .like("ingest_error", "%extraction failed%")
    .not("ingest_error", "like", "%gave up%");
  if (rows.error) {
    console.error(`[transcript-sync] retry query failed: ${rows.error.message}`);
    return;
  }

  for (const row of rows.data ?? []) {
    if (!row.external_id) continue;
    const prev = parseRetryCount(row.ingest_error);
    if (prev >= MAX_INGEST_RETRIES) {
      await writeIngestError(
        row.id,
        `[gave up after ${MAX_INGEST_RETRIES} retries] ${stripMarker(row.ingest_error)}`,
      );
      continue;
    }
    const attempt = prev + 1;

    const t = await db.from("transcripts").select("body").eq("call_id", row.id).maybeSingle();
    const body = t.data?.body ?? "";
    if (body.trim().length < 50) continue; // nothing to re-extract from

    counts.retriesAttempted += 1;
    try {
      const ingestResult = await ingestTranscript({
        source: "recall_ai",
        externalCallId: row.external_id,
        transcript: body,
      });
      await db.from("calls").update({ ingest_error: null, outcome: "captured" }).eq("id", row.id);
      counts.retriesRecovered += 1;
      counts.extracted += 1;
      emit({ kind: "extracted", callId: row.id, recallBotId: "" });

      // Recap + contacts, mirroring the first-pass side effects. Both isolated.
      try {
        await sendPostCallSummary({
          tenantId: row.tenant_id,
          dealExternalId: ingestResult.dealExternalId,
          extraction: ingestResult.extraction as unknown as ExtractionMap,
          transcript: body,
        });
      } catch (e) {
        console.error(`[transcript-sync] retry recap threw for ${row.id}:`, e);
      }
      try {
        const dealRow = await db
          .from("deals")
          .select("id, account")
          .eq("tenant_id", row.tenant_id)
          .eq("external_id", ingestResult.dealExternalId)
          .maybeSingle();
        if (dealRow.data) {
          const callRow = await db
            .from("calls")
            .select("call_date, scheduled_start")
            .eq("id", row.id)
            .maybeSingle();
          const callDate =
            callRow.data?.call_date ?? callRow.data?.scheduled_start ?? new Date().toISOString();
          const people = await extractContactsFromTranscript({
            transcript: body,
            account: dealRow.data.account,
          });
          await upsertDealContacts({
            tenantId: row.tenant_id,
            dealId: dealRow.data.id,
            contacts: people,
            callDate,
          });
        }
      } catch (e) {
        console.error(`[transcript-sync] retry contacts threw for ${row.id}:`, e);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const marker =
        attempt >= MAX_INGEST_RETRIES
          ? `[gave up after ${MAX_INGEST_RETRIES} retries]`
          : `[retry ${attempt}/${MAX_INGEST_RETRIES}]`;
      await writeIngestError(row.id, `${marker} extraction failed (transcript saved): ${message}`);
      counts.ingestErrors += 1;
    }
  }
}

type ProcessRowArgs = {
  callId: string;
  tenantId: string;
  externalCallId: string;
  recallBotId: string;
};

async function processRow(
  args: ProcessRowArgs,
  counts: TranscriptSyncCounts,
  emit: (d: TranscriptSyncDecision) => void,
): Promise<void> {
  const { callId, tenantId, externalCallId, recallBotId } = args;
  const db = supabaseAdmin();

  // ----- 1. Poll the bot. -----

  let bot;
  try {
    bot = await getBot(recallBotId);
  } catch (err) {
    counts.ingestErrors += 1;
    const message = err instanceof Error ? err.message : String(err);
    await writeIngestError(callId, `getBot failed: ${message}`);
    emit({ kind: "ingest-error", callId, recallBotId, phase: "getBot", message });
    return;
  }

  if (bot.status === "fatal") {
    counts.fatal += 1;
    // A fatal bot (e.g. Recall insufficient credit, or a join failure) never
    // recorded, so this is OUR capture failure, not a customer no-show. Mark it
    // as such and resolve it: capture_failed is filtered out of every rep/CRO
    // view, and it must never trigger a no-show follow-up (the customer may well
    // have attended, we just failed to record). Operators still see it via logs.
    await db
      .from("calls")
      .update({ outcome: "capture_failed", has_been_extracted: true })
      .eq("id", callId);
    await writeIngestError(
      callId,
      `bot terminated fatal (status=${bot.rawStatusCode}); marked capture_failed`,
    );
    emit({ kind: "fatal", callId, recallBotId, rawStatus: bot.rawStatusCode });
    return;
  }

  // Bot finished but its media is gone (expired / never uploaded): same as a
  // fatal capture failure for our purposes, we have no recording to work from.
  if (bot.status === "done" && !bot.hasMedia) {
    await db
      .from("calls")
      .update({ outcome: "capture_failed", has_been_extracted: true })
      .eq("id", callId);
    await writeIngestError(callId, "bot done but media unavailable; marked capture_failed");
    emit({ kind: "fatal", callId, recallBotId, rawStatus: bot.rawStatusCode });
    return;
  }

  if (bot.status !== "done") {
    counts.inProgress += 1;
    emit({
      kind: "in-progress",
      callId,
      recallBotId,
      status: bot.status,
      rawStatus: bot.rawStatusCode,
    });
    return;
  }

  // Record the call's real duration (best-effort) from the bot's recording
  // timestamps, so the deal page shows actual minutes instead of 0.
  const durationMin = recordingDurationMinutes(bot);
  if (durationMin !== null) {
    const durUpd = await db.from("calls").update({ duration_minutes: durationMin }).eq("id", callId);
    if (durUpd.error) {
      console.error(`[transcript-sync] duration update failed for call ${callId}: ${durUpd.error.message}`);
    }
  }

  // ----- 2. Pull the transcript from Recall. -----

  let transcript: string;
  try {
    transcript = await getTranscript(recallBotId);
  } catch (err) {
    counts.ingestErrors += 1;
    const message = err instanceof Error ? err.message : String(err);
    await writeIngestError(callId, `getTranscript failed: ${message}`);
    emit({
      kind: "ingest-error",
      callId,
      recallBotId,
      phase: "getTranscript",
      message,
    });
    return;
  }

  // ----- 3. DURABILITY GATE. Persist the transcript body to Supabase
  //          BEFORE any extraction attempt. -----
  //
  // If this fails, set ingest_error and SKIP delete entirely so the
  // upstream Recall copy stays available for the next sync run. We do
  // NOT mark has_been_extracted in this branch: the next sync re-pulls
  // and retries persistence.

  try {
    await persistTranscriptBody({ tenantId, callId, body: transcript });
    counts.bodiesPersisted += 1;
  } catch (err) {
    counts.ingestErrors += 1;
    const message =
      err instanceof TranscriptPersistError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    await writeIngestError(
      callId,
      `transcript persist failed (Recall media preserved): ${message}`,
    );
    emit({
      kind: "ingest-error",
      callId,
      recallBotId,
      phase: "persist",
      message,
    });
    return;
  }

  // ----- 3b. No-conversation guard. A bot that joined but captured almost
  //           nothing (customer no-show, or a placeholder that never became a
  //           real meeting) is recorded as such instead of being run through
  //           extraction (which would just error) or left looking blank. -----

  const MIN_TRANSCRIPT_CHARS = 50;
  if (transcript.trim().length < MIN_TRANSCRIPT_CHARS) {
    const noConv = await db
      .from("calls")
      .update({ outcome: "no_conversation", has_been_extracted: true, ingest_error: null })
      .eq("id", callId);
    if (noConv.error) {
      console.error(
        `[transcript-sync] no-conversation mark failed for call ${callId}: ${noConv.error.message}`,
      );
    }
    console.log(
      `[transcript-sync] call ${callId} captured no conversation (${transcript.trim().length} chars); marked no_conversation.`,
    );
    // Draft a no-show follow-up for the rep (best-effort, never blocks). Only
    // fires for real external customer meetings; internal placeholders are
    // skipped inside sendNoShowFollowup.
    try {
      const ns = await sendNoShowFollowup({ tenantId, callId });
      console.log(
        `[transcript-sync] no-show follow-up for call ${callId}: ${ns.sent ? `sent to ${ns.to}` : `skipped (${ns.reason})`}`,
      );
    } catch (err) {
      console.warn(
        `[transcript-sync] no-show follow-up threw for call ${callId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // Log the no-show to Rolldog so the CRM records that the meeting did not
    // happen. Gated to Rolldog-linked deals, scope-enforced, idempotent. Never
    // blocks ingest.
    try {
      const wb = await logNoShowToRolldog("magaya", { callId });
      console.log(
        `[transcript-sync] no-show Rolldog log for call ${callId}: ${wb.written ? `wrote to opp ${wb.opportunityId}` : `skipped (${wb.reason})`}`,
      );
    } catch (err) {
      console.warn(
        `[transcript-sync] no-show Rolldog log threw for call ${callId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return;
  }

  // ----- 4. Mark has_been_extracted = true. The body is now durable; if
  //          anything after this point fails the operator runs
  //          --retry-ingest to re-extract from the stored body. -----

  const mark = await db
    .from("calls")
    .update({ has_been_extracted: true })
    .eq("id", callId);
  if (mark.error) {
    counts.ingestErrors += 1;
    await writeIngestError(
      callId,
      `could not set has_been_extracted: ${mark.error.message}`,
    );
    emit({
      kind: "ingest-error",
      callId,
      recallBotId,
      phase: "mark",
      message: mark.error.message,
    });
    // Body IS durable, so we still attempt the delete below.
  }

  // ----- 5. Run extraction. Failure here sets ingest_error but does
  //          NOT block the delete step — the body is durable. -----

  try {
    const ingestResult = await ingestTranscript({
      source: "recall_ai",
      externalCallId,
      transcript,
    });
    counts.extracted += 1;
    emit({ kind: "extracted", callId, recallBotId });

    // Record the positive outcome so the UI shows "Extracted" deterministically
    // rather than inferring it. Best-effort; never blocks the pipeline.
    const outc = await db.from("calls").update({ outcome: "captured" }).eq("id", callId);
    if (outc.error) {
      console.error(`[transcript-sync] outcome=captured mark failed for call ${callId}: ${outc.error.message}`);
    }

    // Classify the meeting once and persist it, so the pipeline and digest can
    // drop non-opportunity (customer/internal) meetings out of the sales view.
    // Reused by the recap below so it isn't classified twice.
    // Deal context: a deal with a Rolldog opportunity is a tracked, open sales
    // opportunity, so customer-facing calls are sales calls (never existing-customer).
    const dealLink = await db
      .from("deals")
      .select("rolldog_opportunity_id")
      .eq("tenant_id", tenantId)
      .eq("external_id", ingestResult.dealExternalId)
      .maybeSingle();
    const trackedOpportunity =
      !!rolldogOppIdForDeal(ingestResult.dealExternalId) || !!dealLink.data?.rolldog_opportunity_id;
    const meetingType = await classifyMeetingType(transcript, { trackedOpportunity });
    const callSubtype = await classifyCallSubtype({ transcript, meetingType }).catch(() => null);
    const mt = await db
      .from("calls")
      .update({ meeting_type: meetingType, call_subtype: callSubtype })
      .eq("id", callId);
    if (mt.error) {
      console.error(`[transcript-sync] meeting_type update failed for call ${callId}: ${mt.error.message}`);
    }

    // Best-effort: email the rep their post-call summary. Fully isolated in
    // its own try/catch so a mail failure can never affect ingest status or
    // the media-delete step below.
    let recapNextAction: string | undefined;
    try {
      const notify = await sendPostCallSummary({
        tenantId,
        dealExternalId: ingestResult.dealExternalId,
        extraction: ingestResult.extraction as unknown as ExtractionMap,
        transcript,
        meetingType,
        callId,
      });
      recapNextAction = notify.nextAction;
      if (!notify.sent) {
        console.warn(
          `[transcript-sync] post-call summary not sent for call ${callId}: ${notify.reason}`,
        );
      }
    } catch (notifyErr) {
      console.error(
        `[transcript-sync] post-call summary send threw for call ${callId}:`,
        notifyErr instanceof Error ? notifyErr.message : notifyErr,
      );
    }

    // Best-effort: push extracted fields to Rolldog. Gated + fail-closed;
    // no-ops until the deal's opportunity id is mapped (pilot-config) and
    // allowlisted (crm-scope). Never affects ingest.
    try {
      const wb = await writeBackDealToRolldog("magaya", ingestResult.dealExternalId, {
        nextAction: recapNextAction,
        callId,
      });
      if (!wb.written) {
        console.warn(
          `[transcript-sync] rolldog write-back skipped for call ${callId}: ${wb.reason}`,
        );
      }
    } catch (wbErr) {
      console.error(
        `[transcript-sync] rolldog write-back threw for call ${callId}:`,
        wbErr instanceof Error ? wbErr.message : wbErr,
      );
    }

    // Best-effort: add the customer-side people named on the call to the deal
    // so the Contacts card populates itself. Deduped by name; fully isolated so
    // it can never affect ingest status or the delete step.
    try {
      const dealRow = await db
        .from("deals")
        .select("id, account")
        .eq("tenant_id", tenantId)
        .eq("external_id", ingestResult.dealExternalId)
        .maybeSingle();
      if (dealRow.data) {
        const callRow = await db
          .from("calls")
          .select("call_date, scheduled_start")
          .eq("id", callId)
          .maybeSingle();
        const callDate =
          callRow.data?.call_date ??
          callRow.data?.scheduled_start ??
          new Date().toISOString();
        const people = await extractContactsFromTranscript({
          transcript,
          account: dealRow.data.account,
        });
        const res = await upsertDealContacts({
          tenantId,
          dealId: dealRow.data.id,
          contacts: people,
          callDate,
        });
        if (res.inserted > 0) {
          console.log(
            `[transcript-sync] added ${res.inserted} contact(s) to ${ingestResult.dealExternalId} (skipped ${res.skipped} existing)`,
          );
        }
      }
    } catch (cErr) {
      console.error(
        `[transcript-sync] contact extraction threw for call ${callId}:`,
        cErr instanceof Error ? cErr.message : cErr,
      );
    }
  } catch (err) {
    counts.ingestErrors += 1;
    const message = err instanceof Error ? err.message : String(err);
    await writeIngestError(
      callId,
      `extraction failed (transcript saved; use --retry-ingest): ${message}`,
    );
    emit({
      kind: "ingest-error",
      callId,
      recallBotId,
      phase: "ingest",
      message,
    });
    // Fall through. Body is durable; delete is still safe.
  }

  // ----- 6. Delete the source recording. Body is durable in
  //          public.transcripts, so this is always safe at this point. -----

  try {
    await deleteSourceRecording(externalCallId);
    counts.mediaDeleted += 1;
    emit({ kind: "media-deleted", callId, recallBotId });
  } catch (err) {
    counts.ingestErrors += 1;
    const message = err instanceof Error ? err.message : String(err);
    await writeIngestError(callId, `media delete failed: ${message}`);
    emit({
      kind: "ingest-error",
      callId,
      recallBotId,
      phase: "delete",
      message,
    });
  }
}

async function writeIngestError(callId: string, reason: string): Promise<void> {
  const db = supabaseAdmin();
  const upd = await db
    .from("calls")
    .update({ ingest_error: reason })
    .eq("id", callId);
  if (upd.error) {
    console.error(
      `[transcript-sync] could not write ingest_error on call ${callId}: ${upd.error.message}`,
    );
  }
}
