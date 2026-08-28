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
import { writeBackDealToSalesforce } from "./salesforce-writeback-run";
import {
  getBot,
  getTranscript,
  latestStatusAt,
  recordingDurationMinutes,
  type BotStatus,
} from "./recall";
import {
  captureColumns,
  captureEvidenceFromBot,
  classifyCapture,
  hostSideOf,
  mediaIsImpossible,
} from "./capture-classify";
import {
  MAX_CONTENT_ATTEMPTS,
  MAX_INFRA_ATTEMPTS,
  classifyDraftOutcome,
  classifyIngestFailure,
} from "./ingest-failure-class";
import { extractContactsFromTranscript, upsertDealContacts } from "./contacts-extract";
import { customerParticipation } from "./attendance";
import { classifyCallSubtype, classifyMeetingType } from "./meeting-classify";
import { rolldogOppIdForDeal } from "./pilot-config";
import { withModelContext } from "./model-run";
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

  // Stop before Vercel kills us.
  //
  // maxDuration is 300s and this loop does every pending call in one
  // invocation: extraction, recap, draft, two CRM write-backs and contacts,
  // roughly 60-90 seconds each. Four or five calls finishing in the same window
  // and the function is terminated mid-chain, silently, with no error anywhere.
  //
  // That is what happened to Ariel on 2026-08-13. Miracle, Mollax and KCarlton
  // all show a recap sent and no follow-up draft, and the draft is the step
  // immediately after the recap. No guard declined those drafts; the process
  // died before reaching them.
  //
  // Leaving a call for the next run costs five minutes. Being killed halfway
  // costs the draft, the CRM write and the contacts, and reports nothing.
  const startedAt = Date.now();
  const BUDGET_MS = 240_000;

  for (const row of rows.data ?? []) {
    if (!row.recall_bot_id || !row.external_id) continue;
    if (Date.now() - startedAt > BUDGET_MS) {
      console.warn(
        `[transcript-sync] stopping after ${Math.round((Date.now() - startedAt) / 1000)}s with ` +
          `calls still pending. They are untouched and the next run picks them up.`,
      );
      break;
    }
    counts.pollBots += 1;
    // Captured before the closure: the guard above narrows these to string, and
    // TypeScript drops property narrowing inside a callback because it cannot
    // prove the object was not mutated in between.
    const args = {
      callId: row.id,
      tenantId: row.tenant_id,
      externalCallId: row.external_id,
      recallBotId: row.recall_bot_id,
    };
    // Extraction is the most expensive single call in the system. Attributing
    // it to the tenant and the call is what makes cost per customer and cost
    // per deal answerable at all.
    await withModelContext({ tenantId: row.tenant_id, callId: row.id }, () =>
      processRow(args, counts, emit),
    );
  }

  // Second pass: recover calls whose transcript was saved but whose extraction
  // failed (they carry has_been_extracted=true, so the loop above skips them).
  await retryFailedExtractions(counts, emit);

  // Third pass: recover follow-up drafts that failed for a transient reason.
  await retryFailedDrafts();

  // Hand off to recap-sync rather than making the call wait for its next tick.
  //
  // Both crons run every five minutes, so a transcript stored at :06 sat until
  // :11 before the recap even started, and the follow-up draft is the step
  // after that. Measured over 110 captured calls, a transcript lands a median
  // of 36 minutes after the meeting starts, which is about six minutes after a
  // half-hour call ends. The poll wait was adding another two and a half on top
  // of a delay we do not control, for nothing.
  //
  // Fire and forget, deliberately. recap-sync takes up to 3m 27s and this
  // function has a 240 second budget; awaiting it is the exact shape of the
  // 2026-08-13 failure that killed three of Ariel's drafts. The request only
  // has to be RECEIVED, after which that invocation runs on its own clock with
  // its own ceiling.
  //
  // Safe to double-fire: recap-sync claims each row before working it and skips
  // what it cannot claim, so an overlap with the scheduled run costs nothing.
  await pingRecapSync(counts.extracted);

  return counts;
}

/** Best effort. A failed ping costs latency, never the sync that just ran. */
async function pingRecapSync(extracted: number): Promise<void> {
  if (extracted < 1) return;
  const base = (process.env.DEALRIPE_APP_URL ?? "").replace(/\/$/, "");
  const secret = process.env.CRON_SECRET;
  if (!base || !secret) return;
  try {
    await fetch(`${base}/api/cron/recap-sync`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      // We are not waiting for the recap. Aborting after the request is sent is
      // the intent, not a failure, which is why the catch below is silent.
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    // Expected on the timeout path.
  }
  console.log(`[transcript-sync] pinged recap-sync after ${extracted} extraction(s)`);
}

/**
 * Re-attempt follow-up drafts that failed transiently.
 *
 * On 2026-08-13 three of Ariel's drafts failed on the same afternoon and were
 * never retried, because a draft got one attempt and its failure lived only in
 * a console line. He wrote all three himself. Every one succeeded on the first
 * manual retry with no code change, which is the definition of a failure that
 * should have healed itself.
 *
 * Runs every five minutes with the rest of the sync. The rep-already-emailed
 * check inside createFollowUpDraft is what makes this safe: by the time a retry
 * lands, the rep may have sent their own, and a duplicate draft is worse than
 * the original miss.
 */
export async function retryFailedDrafts(): Promise<void> {
  const db = supabaseAdmin();
  // Only failed and unavailable. A held draft is a decision, not a queue item,
  // and re-running it would ask Graph the same question and get the same
  // correct answer forever.
  const rows = await db
    .from("calls")
    .select(
      "id, deal_id, participants, scheduled_start, call_date, meeting_type, call_subtype, followup_draft_state, followup_draft_reason, followup_draft_attempts, deals!inner(account, rep_email)",
    )
    .in("followup_draft_state", ["failed", "unavailable"])
    .limit(20);
  if (rows.error) return;

  for (const r of (rows.data ?? []) as unknown as Array<{
    id: string;
    deal_id: string;
    participants: unknown;
    scheduled_start: string | null;
    call_date: string | null;
    meeting_type: string | null;
    call_subtype: string | null;
    followup_draft_state: string;
    followup_draft_reason: string | null;
    followup_draft_attempts: number;
    deals: { account: string; rep_email: string | null };
  }>) {
    if (r.followup_draft_attempts >= MAX_DRAFT_RETRIES) continue;

    // 'unavailable' means we could not find out whether a draft was warranted,
    // so it is always worth asking again. 'failed' is retried only when the
    // reason suggests another run would go differently.
    const d = classifyDraftOutcome(r.followup_draft_reason ?? "");
    if (r.followup_draft_state === "failed" && !d.retryable) continue;

    try {
      const { generatePostCallSummary } = await import("./post-call-summary");
      const { getFrameworkForDeal } = await import("./framework");
      const { autoDraftFollowUpForCall } = await import("./followup-draft");

      const tr = await db.from("transcripts").select("body").eq("call_id", r.id).maybeSingle();
      const body = tr.data?.body ?? "";
      if (body.trim().length < 50) continue;
      const framework = await getFrameworkForDeal(r.deal_id);
      if (!framework) continue;
      const fx = await db
        .from("field_extractions")
        .select("framework_field_key, status, answer, evidence, confidence")
        .eq("deal_id", r.deal_id);
      const extraction = Object.fromEntries(
        (fx.data ?? []).map((x) => [String((x as { framework_field_key: string }).framework_field_key), x]),
      );

      const summary = await generatePostCallSummary({
        account: r.deals.account,
        stageKey: "SQL1",
        framework,
        extraction: extraction as never,
        transcript: body,
      });

      const draft = await autoDraftFollowUpForCall({
        tenantId: await resolveMagayaTenantId(db),
        callId: r.id,
        dealId: r.deal_id,
        account: r.deals.account,
        repEmail: r.deals.rep_email,
        meetingType: r.meeting_type,
        // This IS the retry path. The already-followed-up guard exists to stop a
        // retry dropping a near-duplicate, so it applies here and nowhere else.
        isRetry: true,
        // So a proposal call gets a terms email and a discovery call gets a recap.
        callSubtype: r.call_subtype ?? null,
        summary,
        callDate: r.scheduled_start ?? r.call_date,
        participants: r.participants,
      });

      if (draft.created) {
        console.log(`[transcript-sync] follow-up draft recovered on retry for call ${r.id}`);
        await recordDraftWritten(db, r.id);
      } else {
        console.warn(
          `[transcript-sync] draft retry ${r.followup_draft_attempts + 1} for call ${r.id}: ${draft.reason}`,
        );
        await recordDraftOutcome(db, r.id, draft.reason ?? "no reason given");
      }
    } catch (e) {
      await recordDraftOutcome(db, r.id, e instanceof Error ? e.message : String(e));
    }
  }
}

/** The tenant every cron in this file is pinned to. */
async function resolveMagayaTenantId(db: ReturnType<typeof supabaseAdmin>): Promise<string> {
  const t = await db.from("tenants").select("id").eq("slug", "magaya").maybeSingle();
  return (t.data?.id as string) ?? "";
}

/**
 * How long a finished bot may go without attached media before we treat the
 * recording as lost. Recall uploads after the call ends and a long meeting can
 * take several minutes, so anything shorter than this turns a slow upload into
 * a permanently lost conversation. The cost of waiting is a delayed recap; the
 * cost of not waiting is a call nobody can ever recover.
 */
const MEDIA_GRACE_MS = 45 * 60_000;

const MAX_DRAFT_RETRIES = 3;

/**
 * Record the outcome of a draft attempt.
 *
 * The whole point of routing through classifyDraftOutcome is that a hold is
 * not a failure. "rep already emailed the customer after this call" was going
 * into ingest_error and incrementing an attempt counter that lived in the same
 * string, so three healthy calls read as broken everywhere that column is
 * shown and had spent two of their three attempts on the product working
 * correctly.
 *
 * held and unavailable never increment. Only a failure does.
 */
async function recordDraftOutcome(
  db: ReturnType<typeof supabaseAdmin>,
  callId: string,
  reason: string,
): Promise<void> {
  try {
    const d = classifyDraftOutcome(reason);
    if (d.state === "failed") {
      const row = await db
        .from("calls")
        .select("followup_draft_attempts")
        .eq("id", callId)
        .maybeSingle();
      const attempts = Number(row.data?.followup_draft_attempts ?? 0) + 1;
      await db
        .from("calls")
        .update({
          followup_draft_state: "failed",
          followup_draft_reason: d.reason,
          followup_draft_attempts: attempts,
        })
        .eq("id", callId);
      return;
    }
    await db
      .from("calls")
      .update({ followup_draft_state: d.state, followup_draft_reason: d.reason })
      .eq("id", callId);
  } catch {
    // Recording why a draft was or was not written must never be the thing
    // that breaks ingest.
  }
}

async function recordDraftWritten(
  db: ReturnType<typeof supabaseAdmin>,
  callId: string,
): Promise<void> {
  try {
    await db
      .from("calls")
      .update({ followup_draft_state: "drafted", followup_draft_reason: null })
      .eq("id", callId);
  } catch {
    // Same. A stale marker is untidy; a broken ingest is not.
  }
}

/**
 * Re-run extraction from the stored transcript for calls whose first attempt
 * failed after the body was saved.
 *
 * Two budgets, because two different things are being counted and only one of
 * them has anything to do with the call.
 *
 *   content   the transcript could not be extracted. Three attempts, then a
 *             person looks. Unchanged.
 *   infra     a provider outage, an expired key, a rate limit, a billing stop.
 *             Backed off with a growing delay and capped separately.
 *
 * The old code had one budget of three at one attempt per five-minute run, so
 * the Anthropic credit stop on 2026-08-16 spent every affected call's entire
 * allowance in fifteen minutes and abandoned conversations that were never at
 * fault. Sorting the failure is the fix; classifyIngestFailure owns that
 * decision and this function does not restate it.
 */
async function retryFailedExtractions(
  counts: TranscriptSyncCounts,
  emit: (d: TranscriptSyncDecision) => void,
): Promise<void> {
  const db = supabaseAdmin();
  const rows = await db
    .from("calls")
    .select(
      "id, tenant_id, external_id, ingest_error, ingest_failure_class, ingest_content_attempts, ingest_infra_attempts, ingest_retry_after",
    )
    .eq("source", "recall_ai")
    .eq("has_been_extracted", true)
    .not("ingest_error", "is", null)
    // Both shapes. The yield guard below writes "low extraction yield" and
    // scripts/flag-low-yield-for-retry.ts writes the same phrase, and neither
    // contains "extraction failed", so until now every call either of them
    // flagged was queued for a retry pass that could not see it.
    .or("ingest_error.like.%extraction failed%,ingest_error.like.%low extraction yield%");
  if (rows.error) {
    console.error(`[transcript-sync] retry query failed: ${rows.error.message}`);
    return;
  }

  const now = Date.now();

  for (const row of (rows.data ?? []) as unknown as Array<{
    id: string;
    tenant_id: string;
    external_id: string | null;
    ingest_error: string | null;
    ingest_failure_class: string | null;
    ingest_content_attempts: number;
    ingest_infra_attempts: number;
    ingest_retry_after: string | null;
  }>) {
    if (!row.external_id) continue;

    const contentSpent = Number(row.ingest_content_attempts ?? 0);
    const infraSpent = Number(row.ingest_infra_attempts ?? 0);

    // Parked. Both ceilings are reported separately so the reason a call
    // stopped being retried is legible: "the transcript failed three times"
    // and "our provider was down all day" are different conversations.
    if (contentSpent >= MAX_CONTENT_ATTEMPTS || infraSpent >= MAX_INFRA_ATTEMPTS) continue;

    // Backing off. Not a failure, not abandoned, just not yet.
    if (row.ingest_retry_after !== null) {
      const after = Date.parse(row.ingest_retry_after);
      if (!Number.isNaN(after) && after > now) continue;
    }

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
      await db
        .from("calls")
        .update({
          ingest_error: null,
          outcome: "captured",
          ingest_failure_class: null,
          ingest_retry_after: null,
          // Set only once the fields actually exist. has_been_extracted was
          // already true before extraction ran, as a durability marker, so it
          // cannot answer "are the rows there". recap-sync gates on this one.
          extraction_completed_at: new Date().toISOString(),
        })
        .eq("id", row.id);
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
      await recordIngestFailure(row.id, message, {
        contentAttempts: contentSpent,
        infraAttempts: infraSpent,
      });
      counts.ingestErrors += 1;
    }
  }
}

/**
 * Write down an extraction failure and decide what it costs.
 *
 * Only a content failure spends the content budget. Everything else, an
 * unrecognised error included, spends the infra budget and is given a delay,
 * because "we could not process this transcript" and "we could not run" are
 * different sentences and only the first is about the call.
 */
async function recordIngestFailure(
  callId: string,
  message: string,
  spent: { contentAttempts: number; infraAttempts: number },
): Promise<void> {
  const db = supabaseAdmin();
  const verdict = classifyIngestFailure(message, spent.infraAttempts + 1);

  const contentAttempts = verdict.spendsContentBudget
    ? spent.contentAttempts + 1
    : spent.contentAttempts;
  const infraAttempts = verdict.spendsContentBudget
    ? spent.infraAttempts
    : spent.infraAttempts + 1;
  const retryAfter =
    verdict.backoffMs > 0 ? new Date(Date.now() + verdict.backoffMs).toISOString() : null;

  const parked =
    contentAttempts >= MAX_CONTENT_ATTEMPTS || infraAttempts >= MAX_INFRA_ATTEMPTS;
  const budget = verdict.spendsContentBudget
    ? `content attempt ${contentAttempts} of ${MAX_CONTENT_ATTEMPTS}`
    : `${verdict.class} attempt ${infraAttempts} of ${MAX_INFRA_ATTEMPTS}, retrying in ${Math.round(verdict.backoffMs / 60_000)} min`;
  const tail = parked
    ? verdict.needsHuman
      ? "; parked, and someone has to act on this before it can succeed"
      : "; parked for manual attention"
    : "";

  const upd = await db
    .from("calls")
    .update({
      ingest_error: `extraction failed (transcript saved): ${message} [${budget}${tail}]`,
      ingest_failure_class: verdict.class,
      ingest_content_attempts: contentAttempts,
      ingest_infra_attempts: infraAttempts,
      ingest_retry_after: retryAfter,
    })
    .eq("id", callId);
  if (upd.error) {
    console.error(
      `[transcript-sync] could not record ingest failure on call ${callId}: ${upd.error.message}`,
    );
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
    //
    // The observations go in alongside the verdict. Recall's copy of this bot
    // expires; ours does not, and a conclusion we cannot re-check later is a
    // conclusion nobody can argue with when it is wrong.
    const evidence = captureEvidenceFromBot(bot);
    const verdict = classifyCapture({ evidence, hostSide: await hostSideForCall(callId) });
    await db
      .from("calls")
      .update({
        outcome: "capture_failed",
        has_been_extracted: true,
        ...captureColumns(evidence, verdict),
      })
      .eq("id", callId);
    await writeIngestError(callId, `${verdict.category}: ${verdict.detail}`);
    emit({ kind: "fatal", callId, recallBotId, rawStatus: bot.rawStatusCode });
    return;
  }

  // Bot finished but no media is attached yet. This is the dangerous branch:
  // "the recording is gone" and "the recording has not finished uploading"
  // are indistinguishable in a single poll, and we used to declare the first
  // immediately. Because capture_failed sets has_been_extracted, that verdict
  // was final: a bot polled during its upload window lost a real conversation
  // permanently, and the row then said the capture failed rather than that we
  // stopped waiting. Absence of media is not absence of a recording.
  //
  // So wait MEDIA_GRACE_MS from the bot's last status change before concluding
  // anything. The cron runs every 5 minutes and will look again.
  if (bot.status === "done" && !bot.hasMedia) {
    const evidence = captureEvidenceFromBot(bot);
    const lastChange = latestStatusAt(bot);
    const waitedMs = lastChange === null ? null : Date.now() - lastChange;

    // The grace period exists for a bot that recorded and has not finished
    // uploading. It does not apply to a bot that never recorded: a history
    // ending in a lobby timeout with an empty recordings array has nothing to
    // upload, and waiting 45 minutes to say so is 45 minutes of a lost call
    // looking like a healthy one.
    //
    // Every capture failure in the pilot to date is this case, which is why
    // they were all discovered the following day.
    const decided = mediaIsImpossible(evidence);

    if (!decided && waitedMs !== null && waitedMs < MEDIA_GRACE_MS) {
      counts.inProgress += 1;
      emit({
        kind: "in-progress",
        callId,
        recallBotId,
        status: bot.status,
        rawStatus: `${bot.rawStatusCode} (awaiting media upload, ${Math.round(waitedMs / 60_000)} min so far)`,
      });
      return;
    }

    // "done" is Recall's terminal code for any finished lifecycle, including
    // one that never got into the room, so it names no cause on its own. The
    // cause is in the status history, and the classifier reads it off the
    // entry that carries a sub_code rather than the last entry, which is the
    // whole reason fourteen calls said "media unavailable" and meant "the bot
    // was never let in".
    const verdict = classifyCapture({ evidence, hostSide: await hostSideForCall(callId) });
    const waited = decided
      ? "decided immediately: the bot never recorded, so no media was ever coming"
      : waitedMs === null
        ? "no status timestamp to measure the wait from"
        : `waited ${Math.round(waitedMs / 60_000)} min for media`;
    await db
      .from("calls")
      .update({
        outcome: "capture_failed",
        has_been_extracted: true,
        ...captureColumns(evidence, verdict),
      })
      .eq("id", callId);
    await writeIngestError(callId, `${verdict.category}: ${verdict.detail} (${waited})`);
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

  // ----- 5. Classify the meeting, then extract + write back ONLY for
  //          customer sales calls. -----
  //
  // DealRipe auto-joins meetings, and the subject-match path can even put a bot
  // in an internal prep or pipeline-review meeting ABOUT a deal. Deal truth
  // (field_extractions + Rolldog write-back) must come only from real customer
  // sales calls, never from a rep's internal "happy ears" about a deal. So we
  // classify FIRST and gate qualification extraction + write-back on
  // new_opportunity. Internal / existing-customer meetings get a recap only.

  // Resolve the deal for this call (calendar-sync always sets deal_id) for the
  // classification tiebreaker and recap routing.
  const callDealRow = await db.from("calls").select("deal_id, participants, title").eq("id", callId).maybeSingle();
  let dealExternalId: string | null = null;
  let trackedOpportunity = false;
  if (callDealRow.data?.deal_id) {
    const dr = await db
      .from("deals")
      .select("external_id, rolldog_opportunity_id")
      .eq("id", callDealRow.data.deal_id)
      .maybeSingle();
    dealExternalId = dr.data?.external_id ?? null;
    trackedOpportunity =
      !!dr.data?.rolldog_opportunity_id ||
      (dealExternalId ? !!rolldogOppIdForDeal(dealExternalId) : false);
  }

  // A deal with a Rolldog opportunity is a tracked, open sales opportunity, so
  // customer-facing calls are sales calls (never existing-customer). An
  // all-internal meeting (no customer voice) still classifies as "internal".
  // The subject goes in so an onboarding or training session on a still-open
  // opportunity is not forced back into the pipeline by the tiebreaker. Without
  // it, EWI's "Onboarding & Training" classified as new_opportunity and a
  // paying customer in delivery counted as an active deal in the CRO's digest.
  const meetingType = await classifyMeetingType(transcript, {
    trackedOpportunity,
    subject: callDealRow.data?.title ?? null,
  });
  const callSubtype = await classifyCallSubtype({ transcript, meetingType }).catch(() => null);
  const mt = await db
    .from("calls")
    .update({ meeting_type: meetingType, call_subtype: callSubtype })
    .eq("id", callId);
  if (mt.error) {
    console.error(`[transcript-sync] meeting_type update failed for call ${callId}: ${mt.error.message}`);
  }

  // Deal truth is written only for customer sales calls. If the deal could not
  // be resolved at all, fall back to the qualification path (old behavior)
  // rather than silently dropping a call.
  const runQualification = meetingType === "new_opportunity" || dealExternalId === null;

  if (runQualification) {
    // ----- 5a. Customer sales call: extract + write back. Failure here sets
    //           ingest_error but does NOT block the delete step. -----
    try {
      const ingestResult = await ingestTranscript({
        source: "recall_ai",
        externalCallId,
        transcript,
      });
      counts.extracted += 1;
      emit({ kind: "extracted", callId, recallBotId });

      // The fields exist as of here. Recorded separately from
      // has_been_extracted, which is set BEFORE extraction so the transcript
      // body is durable and the call stops being re-polled. Two different facts
      // were sharing that column and recap-sync read the wrong one, which is
      // how Mohawk Global's recap said "nothing captured" while ten fields sat
      // correctly attributed to the call.
      // Tolerant: the column arrives in a migration and ingest must not fail
      // before it is applied. A missing stamp degrades recap-sync to its age
      // backstop, which is the behaviour it had before this existed.
      {
        const stamped = await db
          .from("calls")
          .update({ extraction_completed_at: new Date().toISOString() })
          .eq("id", callId);
        if (stamped.error) {
          console.warn(`[transcript-sync] could not stamp extraction_completed_at for ${callId}: ${stamped.error.message}`);
        }
      }

      // ----- Yield guard. -----
      //
      // Until 2026-08-11, "extraction succeeded" meant "ingestTranscript did not
      // throw". It is not the same thing. A model that answers one field out of
      // twenty-seven throws nothing, so the call was marked captured,
      // ingest_error stayed null, and retryFailedExtractions (which finds work
      // by looking for a non-null ingest_error) could never see it. Three of
      // thirty-seven calls in 45 days were lost this way, including a 54,860
      // character conversation that returned a single field.
      //
      // A real run returns a status for every field in the framework, including
      // the ones it rejects: the healthy comparison case returned 24 of 27. So a
      // handful or fewer means the model did not evaluate the transcript,
      // whatever the reason. Recording it as an ingest_error hands it to the
      // retry path that already exists, capped at MAX_INGEST_RETRIES.
      //
      // Deliberately not keyed on transcript length. A short call still gets
      // every field evaluated and returned as "No"; length tells you how much
      // was said, not whether we looked.
      // The length condition matters. A short call genuinely can contain no
      // qualification, and retrying it three times only burns tokens before
      // giving up. A 54,860 character conversation returning one field cannot
      // be explained that way.
      const MIN_FIELDS_RETURNED = 5;
      const SUBSTANTIAL_TRANSCRIPT = 5000;
      const fieldsReturned = Object.keys(
        (ingestResult.extraction ?? {}) as Record<string, unknown>,
      ).length;
      if (fieldsReturned < MIN_FIELDS_RETURNED && transcript.trim().length >= SUBSTANTIAL_TRANSCRIPT) {
        console.warn(
          `[transcript-sync] call ${callId}: extraction returned ${fieldsReturned} field(s) from ` +
            `${transcript.trim().length} chars. Flagging for retry.`,
        );
        await writeIngestError(
          callId,
          `low extraction yield: ${fieldsReturned} field(s) returned from a ${transcript.trim().length} char transcript`,
        );
      }

      // Record the positive outcome so the UI shows "Extracted" deterministically.
      const outc = await db.from("calls").update({ outcome: "captured" }).eq("id", callId);
      if (outc.error) {
        console.error(`[transcript-sync] outcome=captured mark failed for call ${callId}: ${outc.error.message}`);
      }

      // The recap and the follow-up draft used to run HERE, inline, and they
      // are now in lib/recap-sync.ts on their own cron.
      //
      // Measured 2026-08-16: one Dunavant-sized recap takes 3m 27s against a
      // 240s budget inside a 300s ceiling. Running it here is what killed the
      // process halfway through Ariel's calls on 2026-08-13 and cost three
      // follow-up drafts. recap-sync picks these calls up within five minutes
      // from the same sent_messages idempotency record this path used, so
      // nothing is lost by not doing it here, and a kill there costs a delay
      // rather than an artifact.
      //
      // recapNextAction fed the Rolldog next-step write below. It is no longer
      // available at this point, and the write-back reads its own next step
      // rather than being handed one.
      const recapNextAction: string | undefined = undefined;

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

      // Best-effort: the same push to Salesforce. In its OWN try/catch, and
      // deliberately after Rolldog rather than inside the same block, so a
      // failure of either CRM cannot stop the other. Two CRMs means two
      // independent chances to fail and neither is allowed to be load-bearing.
      //
      // Inert unless SALESFORCE_WRITEBACK_ENABLED is "1" and the deal carries a
      // domain-verified link. See the security-review note in
      // lib/salesforce-scope.ts before switching it on.
      try {
        // Its own lookup rather than reusing the draft block's, so this stays
        // isolated: the date is only a provenance stamp and a failure to read
        // it must not cost the write.
        const sfCall = await db
          .from("calls")
          .select("scheduled_start, call_date")
          .eq("id", callId)
          .maybeSingle();
        const sf = await writeBackDealToSalesforce("magaya", ingestResult.dealExternalId, {
          callId,
          callDate: sfCall.data?.scheduled_start ?? sfCall.data?.call_date ?? null,
          apply: true,
        });
        if (!sf.written) {
          console.warn(
            `[transcript-sync] salesforce write-back skipped for call ${callId}: ${sf.reason}`,
          );
        } else {
          console.log(
            `[transcript-sync] salesforce write-back wrote ${sf.plan?.writes.length ?? 0} field(s) to account ${sf.accountId} for call ${callId}`,
          );
        }

        // Log the call itself, whether or not any field changed.
        //
        // These are the deals whose only CRM record is a Salesforce account, so
        // without this the account shows a few silently altered fields and no
        // sign a call happened. The activity is what makes the field write
        // legible to the rep who opens it later. Deliberately outside the
        // `sf.written` branch: a call with nothing new to write is still a call
        // that took place, and the recap is the point.
        // notifySummary is what carries the recap. Without it there is nothing
        // worth logging, and an activity whose body is empty is worse than none.
        if (sf.accountId) {
          // The Salesforce call activity and the next-step Task used to be
          // here. They carry the RECAP body, so they moved to lib/recap-sync.ts
          // with the recap that produces it. Writing an activity here would
          // mean writing one with an empty description, which is worse than
          // none: it puts a row in a customer's timeline that says a call
          // happened and nothing about what was said.
          //
          // The field write-back above stays, because it depends on the
          // extraction rather than the recap and is cheap.
          //
          // The contacts and opportunity writes below still need the call's
          // account and rep, which the activity block used to fetch.
          const meta = await db
            .from("calls")
            .select("title, participants, deal_id, deals!inner(account, rep_email)")
            .eq("id", callId)
            .maybeSingle();
          const m = meta.data as
            | {
                title: string | null;
                participants: unknown;
                deal_id: string | null;
                deals: { account: string; rep_email: string | null };
              }
            | null;

          // Contacts: fill blank Titles and create people who have no record.
          // Separate from the activity write on purpose, so a contact problem
          // cannot cost the call log.
          try {
            const { syncContactsToSalesforce } = await import("./salesforce-contacts");
            // Reuse the people the pipeline already extracted into the deal's
            // contacts table rather than paying for a second pass over the same
            // transcript. Empty is fine: identity comes from the invite, and the
            // extraction only supplies the job title.
            const known = await db
              .from("contacts")
              .select("name, role, deals!inner(external_id)")
              .eq("deals.external_id", ingestResult.dealExternalId);
            const contacts = await syncContactsToSalesforce({
              tenantSlug: "magaya",
              accountId: sf.accountId,
              participants: m?.participants ?? null,
              extracted: ((known.data ?? []) as Array<{ name: string; role: string | null }>).map((k) => ({
                name: k.name,
                role: k.role,
              })),
              apply: true,
            });
            console.log(
              `[transcript-sync] salesforce contacts for call ${callId}: ` +
                `${contacts.created} created, ${contacts.titlesFilled} titles filled, ` +
                `${contacts.titleAlreadySet} already titled, ${contacts.noTitleAvailable} blank with no title found, ` +
                `${contacts.skipped} skipped` +
                (contacts.notes.length > 0 ? ` (${contacts.notes.slice(0, 3).join("; ")})` : ""),
            );
          } catch (cErr) {
            console.error(
              `[transcript-sync] salesforce contact sync threw for call ${callId}:`,
              cErr instanceof Error ? cErr.message : cErr,
            );
          }

          // The Salesforce OPPORTUNITY, which is a different surface from the
          // Account and holds two facts we already know. Runs even where a
          // Rolldog opportunity exists: Intro_Call_Appointment_Outcome has no
          // Rolldog equivalent, so deal-level precedence would record it
          // nowhere. Precedence is a per-field question.
          try {
            const { writeOpportunityFromCall } = await import("./salesforce-opportunity");
            // Is this the deal's first call that produced a conversation? The
            // field is named for the intro call, so stamping it after the
            // fourth meeting would overwrite what a rep uses it to remember.
            const prior = await db
              .from("calls")
              .select("id, outcome, scheduled_start")
              .eq("deal_id", m?.deal_id ?? "")
              .in("outcome", ["captured", "no_show", "no_conversation"])
              .order("scheduled_start", { ascending: true })
              .limit(1);
            const isFirstCall = (prior.data ?? [])[0]?.id === callId;

            const nextStep = await db
              .from("field_extractions")
              .select("status")
              .eq("deal_id", m?.deal_id ?? "")
              .eq("framework_field_key", "next_step_confirmed")
              .maybeSingle();

            const oppRes = await writeOpportunityFromCall({
              tenantSlug: "magaya",
              accountId: sf.accountId,
              callOutcome: "captured",
              isFirstCall,
              nextStepConfirmed: (nextStep.data as { status?: string } | null)?.status ?? null,
              apply: true,
            });
            console.log(
              `[transcript-sync] salesforce opportunity for call ${callId}: ` +
                (oppRes.written.length > 0 ? oppRes.written.join("; ") : "nothing written") +
                (oppRes.skipped.length > 0 ? `  (${oppRes.skipped.map((s) => `${s.field}: ${s.reason}`).join("; ")})` : ""),
            );
          } catch (oErr) {
            console.error(
              `[transcript-sync] salesforce opportunity write threw for call ${callId}:`,
              oErr instanceof Error ? oErr.message : oErr,
            );
          }
        }
      } catch (sfErr) {
        console.error(
          `[transcript-sync] salesforce write-back threw for call ${callId}:`,
          sfErr instanceof Error ? sfErr.message : sfErr,
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
      // First failure, so both budgets start at zero. Which one this spends is
      // classifyIngestFailure's decision, not this call site's: a credit stop
      // on the very first attempt must not cost the transcript one of its
      // three chances.
      await recordIngestFailure(callId, message, { contentAttempts: 0, infraAttempts: 0 });
      emit({
        kind: "ingest-error",
        callId,
        recallBotId,
        phase: "ingest",
        message,
      });
      // Fall through. Body is durable; delete is still safe.
    }
  } else {
    // ----- 5b. Not a customer sales call. Two sub-cases:
    //   (i)  a customer WAS invited but nobody from their side spoke: this is a
    //        customer NO-SHOW that turned into an internal chat. Draft a
    //        reschedule follow-up and log the no-show; do not send a meeting recap.
    //   (ii) a genuine internal / existing-customer meeting: recap only, no
    //        qualification extraction and no Rolldog write-back, so a rep's
    //        internal "happy ears" never becomes deal truth. -----
    const { hadCustomerInvitee, anyCustomerSpoke } = customerParticipation(
      callDealRow.data?.participants,
      transcript,
    );
    const customerNoShow = hadCustomerInvitee && !anyCustomerSpoke;

    if (customerNoShow) {
      const outc = await db.from("calls").update({ outcome: "no_show" }).eq("id", callId);
      if (outc.error) {
        console.error(`[transcript-sync] outcome=no_show mark failed for call ${callId}: ${outc.error.message}`);
      }
      // Draft the reschedule follow-up for the rep (never emails the customer).
      try {
        const ns = await sendNoShowFollowup({ tenantId, callId });
        console.log(
          `[transcript-sync] no-show follow-up for call ${callId}: ${ns.sent ? `sent to ${ns.to}` : `skipped (${ns.reason})`}`,
        );
      } catch (err) {
        console.warn(
          `[transcript-sync] no-show follow-up threw for call ${callId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Log the no-show to Rolldog (gated to a confirmed opportunity; no-ops otherwise).
      try {
        const wb = await logNoShowToRolldog("magaya", { callId });
        console.log(
          `[transcript-sync] no-show Rolldog log for call ${callId}: ${wb.written ? `wrote to opp ${wb.opportunityId}` : `skipped (${wb.reason})`}`,
        );
      } catch (err) {
        console.warn(
          `[transcript-sync] no-show Rolldog log threw for call ${callId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      console.log(
        `[transcript-sync] call ${callId} classified ${meetingType} but the invited customer never spoke; handled as a no-show.`,
      );
    } else {
      const outc = await db.from("calls").update({ outcome: "captured" }).eq("id", callId);
      if (outc.error) {
        console.error(`[transcript-sync] outcome=captured mark failed for call ${callId}: ${outc.error.message}`);
      }
      // Recap only. Empty extraction: sendPostCallSummary renders the general
      // (non-qualification) recap and sets no next-step, so nothing flows to Rolldog.
      try {
        const notify = await sendPostCallSummary({
          tenantId,
          dealExternalId: dealExternalId as string,
          extraction: {} as unknown as ExtractionMap,
          transcript,
          meetingType,
          callId,
        });
        if (!notify.sent) {
          console.warn(
            `[transcript-sync] ${meetingType} recap not sent for call ${callId}: ${notify.reason}`,
          );
        }
      } catch (notifyErr) {
        console.error(
          `[transcript-sync] ${meetingType} recap send threw for call ${callId}:`,
          notifyErr instanceof Error ? notifyErr.message : notifyErr,
        );
      }
      console.log(
        `[transcript-sync] call ${callId} classified ${meetingType}; recap only, no extraction or Rolldog write-back (deal truth stays customer-calls-only).`,
      );
    }
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

/**
 * Whose meeting this was, for the refusal verdict.
 *
 * Its own lookup rather than threading organizer_email through processRow: it
 * is only read on the two failure branches, and a failure to read it must
 * degrade to 'unknown' rather than cost the diagnostic that is being written.
 */
async function hostSideForCall(
  callId: string,
): Promise<"our_side" | "customer_side" | "unknown"> {
  try {
    const row = await supabaseAdmin()
      .from("calls")
      .select("organizer_email")
      .eq("id", callId)
      .maybeSingle();
    if (row.error) return "unknown";
    return hostSideOf(row.data?.organizer_email ?? null, MAGAYA_MAIL_DOMAIN);
  } catch {
    return "unknown";
  }
}

/** The pilot tenant's own mail domain. Every cron in this file is pinned to it. */
const MAGAYA_MAIL_DOMAIN = "magaya.com";

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
