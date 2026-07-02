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
import { getBot, getTranscript, type BotStatus } from "./recall";
import { supabaseAdmin } from "./supabase";

export type TranscriptSyncCounts = {
  pollBots: number;
  inProgress: number;
  fatal: number;
  bodiesPersisted: number;
  extracted: number;
  mediaDeleted: number;
  ingestErrors: number;
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

  return counts;
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
    await writeIngestError(
      callId,
      `bot terminated fatal (status=${bot.rawStatusCode})`,
    );
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

    // Best-effort: email the rep their post-call summary. Fully isolated in
    // its own try/catch so a mail failure can never affect ingest status or
    // the media-delete step below.
    try {
      const notify = await sendPostCallSummary({
        tenantId,
        dealExternalId: ingestResult.dealExternalId,
        extraction: ingestResult.extraction as unknown as ExtractionMap,
        transcript,
      });
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
