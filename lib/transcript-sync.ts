/**
 * Bot lifecycle -> transcript ingest glue.
 *
 * Finds every calls row that:
 *   - source = 'recall_ai'
 *   - recall_bot_id is not null
 *   - has_been_extracted = false
 *
 * For each, polls Recall:
 *   - non-terminal status                  -> count and skip
 *   - status = "fatal"                     -> write ingest_error, count, skip
 *   - status = "done"                      -> getTranscript, then:
 *
 *       1. SET has_been_extracted=true BEFORE running any
 *          extraction/persistence step. This is an at-most-once gate.
 *          Anything after this point may fail, but the row will not be
 *          re-extracted on a subsequent sync.
 *       2. ingestTranscript({ source:'recall_ai', externalCallId, transcript })
 *          Writes the audit row + per-field rows via the existing
 *          chokepoint.
 *       3. deleteSourceRecording(externalCallId)
 *          Honors the DPA delete-after-pull commitment.
 *
 *     Any failure after step 1 sets ingest_error but never resets
 *     has_been_extracted to false.
 */

import {
  TranscriptPersistError,
  deleteSourceRecording,
  ingestTranscript,
} from "./transcript-ingest";
import { getBot, getTranscript, type BotStatus } from "./recall";
import { supabaseAdmin } from "./supabase";

export type TranscriptSyncCounts = {
  pollBots: number;
  inProgress: number;
  fatal: number;
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
      phase: "getBot" | "getTranscript" | "mark" | "ingest" | "delete";
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
    extracted: 0,
    mediaDeleted: 0,
    ingestErrors: 0,
  };
  const emit = opts.onDecision ?? (() => {});

  const db = supabaseAdmin();
  const rows = await db
    .from("calls")
    .select("id, external_id, recall_bot_id")
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
    await processRow(row.id, row.external_id, row.recall_bot_id, counts, emit);
  }

  return counts;
}

async function processRow(
  callId: string,
  externalCallId: string,
  recallBotId: string,
  counts: TranscriptSyncCounts,
  emit: (d: TranscriptSyncDecision) => void,
): Promise<void> {
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

  // ----- 2. Pull the transcript. -----

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

  // ----- 3. Mark has_been_extracted = true BEFORE anything that must not
  //          repeat. This is the at-most-once gate. -----

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
    return;
  }

  // ----- 4. Ingest the transcript. -----
  //
  // The transcripts body row is the durability gate: ingestTranscript
  // writes it BEFORE any extraction_runs / field_extractions rows, and
  // throws TranscriptPersistError if that write fails. We must not
  // delete Recall media in that case — the customer's only durable
  // copy of the body would be lost. The retry script can pick it up
  // when the underlying issue is resolved.
  //
  // For any other error past the at-most-once mark, the body is
  // already durable, so deleting the upstream media is safe.

  let transcriptIsDurable = false;
  try {
    await ingestTranscript({
      source: "recall_ai",
      externalCallId,
      transcript,
    });
    transcriptIsDurable = true;
    counts.extracted += 1;
    emit({ kind: "extracted", callId, recallBotId });
  } catch (err) {
    counts.ingestErrors += 1;
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof TranscriptPersistError) {
      // Body not durably stored. Set ingest_error, SKIP delete entirely.
      await writeIngestError(
        callId,
        `transcript persist failed (Recall media preserved): ${message}`,
      );
      emit({
        kind: "ingest-error",
        callId,
        recallBotId,
        phase: "ingest",
        message,
      });
      return;
    }
    // Any other failure: ingest_error set, but the body MAY still be
    // durable (TranscriptPersistError throws only when the body write
    // itself failed). Verify by direct query before deleting.
    await writeIngestError(
      callId,
      `ingest failed (will not retry): ${message}`,
    );
    emit({
      kind: "ingest-error",
      callId,
      recallBotId,
      phase: "ingest",
      message,
    });
    transcriptIsDurable = await transcriptBodyExists(callId);
  }

  // ----- 5. Delete the source recording — ONLY if the body is durable. -----

  if (!transcriptIsDurable) {
    return;
  }

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

async function transcriptBodyExists(callId: string): Promise<boolean> {
  const db = supabaseAdmin();
  const row = await db
    .from("transcripts")
    .select("id")
    .eq("call_id", callId)
    .limit(1);
  if (row.error) {
    console.error(
      `[transcript-sync] could not verify transcripts row for call ${callId}: ${row.error.message}. Assuming NOT durable, skipping delete.`,
    );
    return false;
  }
  return !!row.data && row.data.length > 0;
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
