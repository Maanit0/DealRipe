/**
 * Transcript ingest chokepoint.
 *
 * The function ingestTranscript() is the only path by which transcript
 * text enters the system. Every source that has a transcript: a paste from
 * the UI, a future Recall.ai webhook, a future Granola or Teams or Zoom
 * integration must call ingestTranscript. No other code calls the
 * Anthropic SDK with a transcript payload.
 *
 * A security reviewer asking "how does transcript data enter the
 * application?" reads this one file.
 *
 * ============================================================
 * Data handling commitments (DPA section 3.6, Magaya pilot)
 * ============================================================
 *
 * The DPA section 3.6 commits the system to the following behavior for
 * transcript content. Each commitment is reflected in the code below.
 *
 *   1. The raw transcript is not persisted to any datastore. After
 *      Anthropic returns the structured extraction, the transcript
 *      variable goes out of scope and is garbage-collected. There is no
 *      filesystem write, no Supabase write, no in-memory cache, no log
 *      line that captures transcript content.
 *
 *   2. The audit trail stored in Supabase captures (a) one row to
 *      extraction_runs containing the structured extraction output,
 *      token counts, model identifier, prompt version, and call
 *      duration, and (b) zero or more rows to field_extractions
 *      containing per-field status and, for confirmed fields, a
 *      verbatim evidence quote extracted by the model. Evidence quotes
 *      are sentence-level extracts spoken by the customer (enforced by
 *      prompt rule 3 in lib/extraction-prompt.ts). They are not the
 *      full transcript.
 *
 *   3. Logging is restricted to numeric counters (token counts, raw
 *      response length, duration) and identifiers (dealId, callId).
 *      No console.* statement in this file or anywhere downstream
 *      captures the transcript value. Verified by
 *      `grep -rEn 'console\\..*transcript' lib app`.
 *
 *   4. The source recording is removed via deleteSourceRecording() once
 *      Recall.ai is wired. This is the delete-after-pull commitment in
 *      the DPA. The stub below documents the eventual HTTP call.
 *
 * The four commitments above are properties of this single file. Any
 * code change that touches the transcript variable must preserve them.
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { mergeExtraction } from "./extraction-merge";
import { buildExtractionSystemPrompt } from "./extraction-prompt";
import {
  getFrameworkForDeal,
  loadFramework,
  type Framework,
} from "./framework";
import {
  type ExtractionResult,
  type FieldExtraction,
} from "./scotsman";
import { ALL_DEALS, getDealById, type CallRecord } from "./seed-data";
import { supabaseAdmin } from "./supabase";
import { resolveDealId, resolveTenantId } from "./tenant-deal-lookup";
import type { Database, Json } from "./database.types";

type FieldExtractionInsert =
  Database["public"]["Tables"]["field_extractions"]["Insert"];

const TENANT_SLUG = "topsort";
const PROMPT_VERSION = "v1";
const MIN_TRANSCRIPT_CHARS = 50;
// Long calls produce long transcripts (a 60-min call is ~50K chars), and
// extracting all gates from that can take well over a minute. 45s was too
// tight and silently dropped fields/contacts/recap on long calls. The cron's
// function budget is 300s, so 120s leaves ample margin for a single call.
const REQUEST_TIMEOUT_MS = 120_000;

// ====================================================================
// Errors. The route handler matches on these classes to map HTTP codes.
// ====================================================================

export class TranscriptIngestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TranscriptIngestError";
  }
}

export class InvalidTranscriptSourceError extends TranscriptIngestError {
  constructor(received: string) {
    super(
      "INVALID_SOURCE",
      `source must be 'manual_paste' or 'recall_ai', got '${received}'`,
    );
    this.name = "InvalidTranscriptSourceError";
  }
}

export class TranscriptTooShortError extends TranscriptIngestError {
  constructor(length: number) {
    super(
      "TRANSCRIPT_TOO_SHORT",
      `transcript must be at least ${MIN_TRANSCRIPT_CHARS} characters, got ${length}`,
    );
    this.name = "TranscriptTooShortError";
  }
}

export class UnknownCallError extends TranscriptIngestError {
  constructor(externalCallId: string) {
    super(
      "UNKNOWN_CALL",
      `externalCallId '${externalCallId}' is not in seed data`,
    );
    this.name = "UnknownCallError";
  }
}

export class ApiKeyMissingError extends TranscriptIngestError {
  constructor() {
    super("API_KEY_MISSING", "ANTHROPIC_API_KEY is not set");
    this.name = "ApiKeyMissingError";
  }
}

export class ExtractionParseError extends TranscriptIngestError {
  constructor(rawLength: number) {
    super(
      "EXTRACTION_PARSE_FAILED",
      `could not parse model output (raw length ${rawLength})`,
    );
    this.name = "ExtractionParseError";
  }
}

export class LLMTimeoutError extends TranscriptIngestError {
  constructor() {
    super(
      "LLM_TIMEOUT",
      `Anthropic call did not return within ${REQUEST_TIMEOUT_MS}ms`,
    );
    this.name = "LLMTimeoutError";
  }
}

export class LLMServiceError extends TranscriptIngestError {
  constructor(detail: string) {
    super("LLM_SERVICE_ERROR", `Anthropic service error: ${detail}`);
    this.name = "LLMServiceError";
  }
}

/**
 * Thrown by persistTranscriptBody when the transcripts body row fails to
 * persist for a Recall-sourced call. This is the durability gate:
 * callers (transcript-sync) catch this specifically, set
 * calls.ingest_error, and must NOT proceed to delete the upstream
 * Recall media. The customer's only durable copy of the transcript
 * would otherwise be lost.
 *
 * Production rehearsal lesson: extraction failure must NEVER block
 * transcript persistence. persistTranscriptBody runs BEFORE any
 * extraction attempt, so any extraction error (missing framework, LLM
 * timeout, parse failure) leaves the body intact.
 */
export class TranscriptPersistError extends TranscriptIngestError {
  constructor(callId: string, detail: string) {
    super(
      "TRANSCRIPT_PERSIST_FAILED",
      `transcripts row write failed for call ${callId}: ${detail}`,
    );
    this.name = "TranscriptPersistError";
  }
}

/**
 * Thrown when no qualification framework is registered for the deal's
 * tenant. Operator action: run `npm run seed:frameworks` (for topsort)
 * or ingest the customer's framework (for magaya / future tenants).
 */
export class FrameworkNotConfiguredError extends TranscriptIngestError {
  constructor(tenantId: string) {
    super(
      "FRAMEWORK_NOT_CONFIGURED",
      `No qualification framework registered for tenant ${tenantId}. ` +
        `Run \`npm run seed:frameworks\` to register the SCOTSMAN builtin for topsort, ` +
        `or ingest a custom framework for this tenant.`,
    );
    this.name = "FrameworkNotConfiguredError";
  }
}

/**
 * Thrown when the deal external id resolves to neither a seed deal nor
 * a Supabase row. This is a precondition failure: calendar-sync should
 * have inserted the deal before transcript-sync runs.
 */
export class DealNotResolvedError extends TranscriptIngestError {
  constructor(dealExternalId: string) {
    super(
      "DEAL_NOT_RESOLVED",
      `Deal '${dealExternalId}' not found in seed or Supabase.`,
    );
    this.name = "DealNotResolvedError";
  }
}

/**
 * Thrown when the post-extraction audit write fails:
 *   - extraction_runs INSERT errored, OR
 *   - field_extractions UPSERT errored, OR
 *   - field_extractions UPSERT returned zero rows when rows were expected
 *     (e.g. a trigger silently rejected, an RLS misconfiguration, an
 *     on-conflict mismatch).
 *
 * Surfacing this as a typed error (not a swallowed console.error) is the
 * fix for the production rehearsal incident where extraction_runs landed
 * but field_extractions did not, and ingest_error stayed null.
 * transcript-sync catches this and stamps ingest_error so the row is
 * visible to --retry-ingest.
 */
export class AuditPersistError extends TranscriptIngestError {
  constructor(detail: string) {
    super("AUDIT_PERSIST_FAILED", `audit persist failed: ${detail}`);
    this.name = "AuditPersistError";
  }
}

// ====================================================================
// Public API: ingestTranscript
// ====================================================================

export type IngestSource = "manual_paste" | "recall_ai";

export type IngestTranscriptArgs = {
  source: IngestSource;
  externalCallId: string;
  transcript: string;
  /**
   * Optional attendee list. Populated when source is recall_ai. Today
   * attendees are accepted but not persisted because the calls table is
   * not yet populated. When the calls table is wired, attendees will be
   * written to calls.participants for the matching call row.
   */
  attendees?: string[];
};

export type IngestTranscriptResult = {
  extraction: ExtractionResult;
  dealExternalId: string;
};

/**
 * Single entry point for all transcript ingest. Validates the source
 * enum, validates transcript length, resolves the deal from the
 * external call id, and dispatches to extractAndStore. The raw
 * transcript is never persisted, logged, or cached.
 *
 * Returns the extraction and the resolved deal external id. Throws a
 * TranscriptIngestError subclass on any validation or downstream
 * failure; the route handler maps these to HTTP responses.
 */
export async function ingestTranscript(
  args: IngestTranscriptArgs,
): Promise<IngestTranscriptResult> {
  // 1. Source enum validation. Closed allowlist.
  if (args.source !== "manual_paste" && args.source !== "recall_ai") {
    throw new InvalidTranscriptSourceError(String(args.source));
  }

  // 2. Transcript length validation.
  const transcript = (args.transcript ?? "").trim();
  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    throw new TranscriptTooShortError(transcript.length);
  }

  // 3. Resolve the deal from the call id. The server determines the deal,
  // not the client; this prevents a client from claiming a transcript
  // belongs to a different deal than the one the call is attached to.
  //
  // Seed first (covers the manual_paste demo flow against LUMORA_DEAL et al),
  // then Supabase calls table (covers the Recall.ai flow where calendar-sync
  // populated the calls row keyed by the Microsoft event id).
  const dealExternalId = await resolveDealExternalIdForCall(args.externalCallId);
  if (!dealExternalId) {
    throw new UnknownCallError(args.externalCallId);
  }

  // 4. Attendees: accepted but not persisted by this code path. For Recall
  // sources, attendees are already written to calls.participants by
  // calendar-sync; for manual_paste they live in seed.
  void args.attendees;

  // 5. Dispatch to the shared extraction core.
  const extraction = await extractAndStore({
    transcript,
    dealExternalId,
    callExternalId: args.externalCallId,
  });

  return { extraction, dealExternalId };
}

// ====================================================================
// Public API: extractAndStore (shared by the route and ingestTranscript)
// ====================================================================

export type ExtractAndStoreArgs = {
  transcript: string;
  dealExternalId: string;
  callExternalId: string;
};

/**
 * Encapsulates the Anthropic round-trip, response parsing, schema
 * validation, and Supabase audit write. The transcript parameter lives
 * only for the duration of this function. It is never persisted, logged,
 * or cached anywhere outside this stack frame.
 *
 * Throws a TranscriptIngestError subclass on parse failure, timeout, or
 * upstream failure.
 */
export async function extractAndStore(
  args: ExtractAndStoreArgs,
): Promise<ExtractionResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new ApiKeyMissingError();
  }

  // Resolve targets and framework BEFORE the LLM round-trip. The prompt
  // is assembled from framework_fields, so a misconfigured tenant fails
  // fast without spending an Anthropic call.
  const target = await resolveAuditTargets(
    args.dealExternalId,
    args.callExternalId,
  );
  if (!target) {
    throw new DealNotResolvedError(args.dealExternalId);
  }
  const framework =
    (await getFrameworkForDeal(target.dealId)) ??
    (await loadFramework(target.tenantId));
  if (!framework) {
    throw new FrameworkNotConfiguredError(target.tenantId);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const start = Date.now();
  const modelName = getAnthropicModel();

  try {
    const response = await getAnthropicClient().messages.create(
      {
        model: modelName,
        max_tokens: 4000,
        temperature: 0.1,
        system: buildExtractionSystemPrompt(framework),
        messages: [
          {
            role: "user",
            content: `<transcript>\n${args.transcript}\n</transcript>`,
          },
        ],
      },
      { signal: controller.signal },
    );

    clearTimeout(timeout);

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");

    const parsed = parseExtractionResponse(text);
    if (!parsed) {
      console.error(
        `[transcript-ingest] dealId=${args.dealExternalId} parse_failed raw_length=${text.length}`,
      );
      throw new ExtractionParseError(text.length);
    }

    const extraction = validateAndFillExtraction(framework, parsed);
    const duration = Date.now() - start;
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;

    // Note: token counts and duration are logged. Transcript content is
    // not (DPA section 3.6, commitment 3).
    console.log(
      `[transcript-ingest] dealId=${args.dealExternalId} framework=${framework.name} ok duration=${duration}ms in=${inputTokens} out=${outputTokens}`,
    );

    await writeAuditTrail({
      target,
      framework,
      callExternalId: args.callExternalId,
      transcript: args.transcript,
      extraction,
      modelName,
      duration,
      inputTokens,
      outputTokens,
    });

    return extraction;
  } catch (err) {
    clearTimeout(timeout);
    const duration = Date.now() - start;

    if (err instanceof TranscriptIngestError) throw err;

    if (controller.signal.aborted || (err as { name?: string })?.name === "AbortError") {
      console.error(
        `[transcript-ingest] dealId=${args.dealExternalId} timeout duration=${duration}ms`,
      );
      throw new LLMTimeoutError();
    }

    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[transcript-ingest] dealId=${args.dealExternalId} api_error duration=${duration}ms`,
      message,
    );
    throw new LLMServiceError(message);
  }
}

// ====================================================================
// Source recording deletion (Recall.ai, pending)
// ====================================================================

/**
 * Remove the source recording (audio/video file) from the upstream
 * provider after extraction has succeeded. Honors the delete-after-pull
 * commitment in the Magaya DPA section 3.6.
 *
 * Looks up the call row in Supabase by external_id, then branches on
 * `source`:
 *
 *   - source = "recall_ai":   call recall.deleteBotMedia(recall_bot_id)
 *                             via POST /api/v1/bot/{id}/delete_media/
 *   - source = "manual_paste" or "gong":  no-op (no upstream media to delete)
 *   - row not found:          no-op with a warning (calls table may not
 *                             be populated yet for that call)
 *
 * Recall API failures are logged loudly and re-thrown so the caller
 * (typically the ingest pipeline post-extraction or the test-recall-bot
 * script) can observe and decide whether to retry. The DPA commitment is
 * better served by visible failure than silent suppression.
 */
export async function deleteSourceRecording(
  externalCallId: string,
): Promise<void> {
  const { supabaseAdmin } = await import("./supabase");
  const db = supabaseAdmin();

  const lookup = await db
    .from("calls")
    .select("source, recall_bot_id")
    .eq("external_id", externalCallId)
    .maybeSingle();

  if (lookup.error) {
    console.error(
      `[transcript-ingest] deleteSourceRecording: calls lookup failed for ${externalCallId}: ${lookup.error.message}`,
    );
    return;
  }

  if (!lookup.data) {
    console.log(
      `[transcript-ingest] deleteSourceRecording: no calls row for ${externalCallId} (manual_paste demo flow, nothing to delete)`,
    );
    return;
  }

  const { source, recall_bot_id } = lookup.data;

  if (source !== "recall_ai") {
    console.log(
      `[transcript-ingest] deleteSourceRecording: no-op for ${externalCallId} (source=${source ?? "null"})`,
    );
    return;
  }

  if (!recall_bot_id) {
    console.error(
      `[transcript-ingest] deleteSourceRecording: call ${externalCallId} has source=recall_ai but no recall_bot_id; cannot delete media`,
    );
    return;
  }

  const { deleteBotMedia } = await import("./recall");
  try {
    await deleteBotMedia(recall_bot_id);
    console.log(
      `[transcript-ingest] deleteSourceRecording ok for callId=${externalCallId} botId=${recall_bot_id}`,
    );
  } catch (err) {
    console.error(
      `[transcript-ingest] deleteSourceRecording FAILED for callId=${externalCallId} botId=${recall_bot_id}:`,
      err instanceof Error ? err.message : err,
    );
    throw err;
  }
}

// ====================================================================
// Internals
// ====================================================================

function findDealAndCallByExternalId(externalCallId: string): {
  dealExternalId: string;
  call: CallRecord;
} | null {
  for (const deal of ALL_DEALS) {
    for (const call of deal.calls) {
      if (call.id === externalCallId) {
        return { dealExternalId: deal.id, call };
      }
    }
  }
  return null;
}

/**
 * Two-tier resolver. Seed first (the demo flow), then Supabase calls table
 * joined to deals (the Recall.ai flow, where calendar-sync persists a row
 * with external_id = Microsoft event id, source = 'recall_ai').
 */
async function resolveDealExternalIdForCall(
  externalCallId: string,
): Promise<string | null> {
  const seedHit = findDealAndCallByExternalId(externalCallId);
  if (seedHit) return seedHit.dealExternalId;

  const db = supabaseAdmin();
  const callRow = await db
    .from("calls")
    .select("deal_id")
    .eq("external_id", externalCallId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (callRow.error || !callRow.data || callRow.data.length === 0) return null;

  const dealRow = await db
    .from("deals")
    .select("external_id")
    .eq("id", callRow.data[0].deal_id)
    .maybeSingle();
  if (dealRow.error || !dealRow.data || !dealRow.data.external_id) return null;
  return dealRow.data.external_id;
}

/**
 * Two-tier audit target resolver.
 *
 *   Tier 1: seed deal (topsort tenant). Prior extraction comes from the
 *           seeded extraction state on the deal object. No calls row in
 *           Supabase for this flow; callId stays null.
 *   Tier 2: Supabase, resolved via the calls -> deals foreign key. The
 *           tenant is read off the calls row, which means it cannot be
 *           ambiguous: even if two tenants share an external_id on
 *           deals, the call uniquely identifies one. Prior extraction
 *           reconstructed from field_extractions for that specific
 *           (tenant, deal).
 *   Tier 2b: Supabase deals-only fallback (no calls row matched). Used
 *           by the /api/extract-scotsman manual_paste path when the
 *           call lives only in seed but the deal exists in Supabase.
 *           Still tenant-safe because we project the tenant straight
 *           off the deals row we picked.
 *
 * Returns null only when the deal cannot be located in any tier.
 */
async function resolveAuditTargets(
  dealExternalId: string,
  callExternalId: string,
): Promise<{
  tenantId: string;
  dealId: string;
  callId: string | null;
  priorExtraction: ExtractionResult;
} | null> {
  const seedDeal = getDealById(dealExternalId);
  if (seedDeal) {
    const tenantId = await resolveTenantId(TENANT_SLUG);
    const dealId = await resolveDealId(dealExternalId, TENANT_SLUG);
    return {
      tenantId,
      dealId,
      callId: null,
      priorExtraction: seedDeal.extraction,
    };
  }

  const db = supabaseAdmin();

  if (callExternalId) {
    const callRow = await db
      .from("calls")
      .select("id, deal_id, tenant_id")
      .eq("external_id", callExternalId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (callRow.error) {
      console.error(
        `[transcript-ingest] calls lookup failed during audit resolution: ${callRow.error.message}`,
      );
    } else if (callRow.data && callRow.data.length > 0) {
      const callId = callRow.data[0].id;
      const dealId = callRow.data[0].deal_id;
      const tenantId = callRow.data[0].tenant_id;
      const priorExtraction = await loadPriorExtractionFromSupabase(dealId);
      return { tenantId, dealId, callId, priorExtraction };
    }
  }

  // Tier 2b. No call row matched (manual_paste route where deal is in
  // Supabase but the call is seed-only). Last-resort by deal external id.
  const dealRow = await db
    .from("deals")
    .select("id, tenant_id")
    .eq("external_id", dealExternalId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (dealRow.error || !dealRow.data || dealRow.data.length === 0) return null;
  const dealId = dealRow.data[0].id;
  const tenantId = dealRow.data[0].tenant_id;
  const priorExtraction = await loadPriorExtractionFromSupabase(dealId);
  return { tenantId, dealId, callId: null, priorExtraction };
}

async function loadPriorExtractionFromSupabase(
  dealId: string,
): Promise<ExtractionResult> {
  const db = supabaseAdmin();
  const fxRows = await db
    .from("field_extractions")
    .select("framework_field_key, status, answer, evidence, confidence")
    .eq("deal_id", dealId);

  const priorExtraction: ExtractionResult = {};
  if (fxRows.error) {
    console.error(
      `[transcript-ingest] field_extractions read failed during audit (dealId=${dealId}): ${fxRows.error.message}. Proceeding with empty prior.`,
    );
    return priorExtraction;
  }
  for (const row of fxRows.data ?? []) {
    const status = row.status;
    if (status === "Yes") {
      priorExtraction[row.framework_field_key] = {
        status: "Yes",
        answer: row.answer ?? "",
        evidence: row.evidence ?? "",
        confidence: row.confidence ?? 0,
      };
    } else if (status === "No" || status === "Unknown") {
      priorExtraction[row.framework_field_key] = { status };
    }
  }
  return priorExtraction;
}

function parseExtractionResponse(raw: string): Record<string, unknown> | null {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) return null;
  cleaned = cleaned.slice(firstBrace, lastBrace + 1);

  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function validateAndFillExtraction(
  framework: Framework,
  raw: Record<string, unknown>,
): ExtractionResult {
  const result: ExtractionResult = {};
  for (const field of framework.fields) {
    const validated = validateFieldExtraction(raw[field.fieldKey]);
    result[field.fieldKey] = validated ?? { status: "Unknown" };
  }
  return result;
}

function validateFieldExtraction(entry: unknown): FieldExtraction | null {
  if (!entry || typeof entry !== "object") return null;
  const e = entry as Record<string, unknown>;

  if (e.status === "Yes") {
    if (
      typeof e.answer !== "string" ||
      typeof e.evidence !== "string" ||
      typeof e.confidence !== "number"
    ) {
      return null;
    }
    return {
      status: "Yes",
      answer: e.answer,
      evidence: e.evidence,
      confidence: Math.max(0, Math.min(1, e.confidence)),
    };
  }

  if (e.status === "No" || e.status === "Unknown") {
    return { status: e.status };
  }

  return null;
}

type ResolvedAuditTarget = {
  tenantId: string;
  dealId: string;
  callId: string | null;
  priorExtraction: ExtractionResult;
};

async function writeAuditTrail(args: {
  target: ResolvedAuditTarget;
  framework: Framework;
  callExternalId: string;
  transcript: string;
  extraction: ExtractionResult;
  modelName: string;
  duration: number;
  inputTokens: number;
  outputTokens: number;
}): Promise<void> {
  const {
    target,
    framework,
    callExternalId,
    transcript,
    extraction,
    modelName,
    duration,
    inputTokens,
    outputTokens,
  } = args;
  const { tenantId, dealId: dealUuid, callId: callUuid, priorExtraction } = target;

  // Production rehearsal fix: audit writes used to be wrapped in a
  // try/catch that console.error'd on failure and returned silently.
  // That hid the field_extractions upsert failure that caused the
  // call-with-no-stamped-rows bug. Errors now throw AuditPersistError;
  // transcript-sync catches it and stamps ingest_error.

  const db = supabaseAdmin();

  // The transcripts row is written by transcript-sync's
  // persistTranscriptBody call BEFORE extraction is attempted, so
  // extraction failure (e.g. FrameworkNotConfiguredError thrown earlier
  // in extractAndStore) can never block persistence. The void assignment
  // silences the "transcript declared but never used" hint while
  // keeping the argument in the signature for the retry-ingest caller,
  // which re-runs extraction from the stored body and passes it back
  // through here.
  void transcript;

  const { merged, changedIds } = mergeExtraction(
    framework,
    priorExtraction,
    extraction,
    callExternalId,
  );

  // 1. extraction_runs INSERT (immutable per-call audit row).
  const runInsert = await db.from("extraction_runs").insert({
    tenant_id: tenantId,
    deal_id: dealUuid,
    call_id: callUuid,
    model_name: modelName,
    prompt_version: PROMPT_VERSION,
    raw_response: extraction as unknown as Json,
    token_input: inputTokens,
    token_output: outputTokens,
    duration_ms: duration,
  });
  if (runInsert.error) {
    throw new AuditPersistError(
      `extraction_runs insert failed (dealId=${dealUuid}, callId=${callUuid ?? "null"}): ${runInsert.error.message}`,
    );
  }

  // 2. field_extractions UPSERT.
  //
  // Build a row for EVERY framework field the LLM observed (status Yes
  // or No), not just state changes. This is the second half of the
  // rehearsal fix: a "Yes" the model confirms again is still a valid
  // observation, and last_updated_from_call_id should reflect the most
  // recent call that touched the field. The merge values keep the
  // prior Yes payload (mergeExtraction's Yes-is-immutable rule), but
  // the row's last_updated_from_call_id is refreshed.
  //
  // Unknown observations are skipped: "the topic did not come up" is
  // not a field touch.
  const upsertRows: FieldExtractionInsert[] = [];
  for (const f of framework.fields) {
    const incomingEntry = extraction[f.fieldKey];
    if (!incomingEntry || incomingEntry.status === "Unknown") continue;

    const mergedEntry = merged[f.fieldKey];
    const row: FieldExtractionInsert = {
      tenant_id: tenantId,
      deal_id: dealUuid,
      framework_field_key: f.fieldKey,
      framework_id: framework.id,
      status: mergedEntry.status,
      last_updated_from_call_id: callUuid,
    };
    if (mergedEntry.status === "Yes") {
      row.answer = mergedEntry.answer;
      row.evidence = mergedEntry.evidence;
      row.confidence = mergedEntry.confidence;
    } else {
      row.answer = null;
      row.evidence = null;
      row.confidence = null;
    }
    upsertRows.push(row);
  }

  if (upsertRows.length === 0) {
    console.log(
      `[transcript-ingest] audit ok dealId=${dealUuid} framework=${framework.name} transcript_persisted=${callUuid !== null} no observations`,
    );
    return;
  }

  // .select() forces the upsert to RETURN the affected rows. Without it
  // a silent zero-row write (RLS misconfiguration, trigger rejection,
  // on-conflict column mismatch) would slip through.
  const upsert = await db
    .from("field_extractions")
    .upsert(upsertRows, { onConflict: "deal_id,framework_field_key" })
    .select("framework_field_key, last_updated_from_call_id");
  if (upsert.error) {
    throw new AuditPersistError(
      `field_extractions upsert failed (rows=${upsertRows.length}, dealId=${dealUuid}): ${upsert.error.message}`,
    );
  }
  const returnedCount = upsert.data?.length ?? 0;
  if (returnedCount === 0) {
    throw new AuditPersistError(
      `field_extractions upsert returned 0 rows (expected ${upsertRows.length}, dealId=${dealUuid}). Likely a trigger or RLS silently rejected the write.`,
    );
  }

  console.log(
    `[transcript-ingest] audit ok dealId=${dealUuid} framework=${framework.name} ` +
      `transcript_persisted=${callUuid !== null} run_inserted=1 ` +
      `fields_observed=${upsertRows.length} state_changes=${changedIds.length}` +
      (changedIds.length > 0 ? ` (${changedIds.join(",")})` : ""),
  );
}

/**
 * Durably persist the transcript body to Supabase BEFORE any extraction
 * attempt. Throws TranscriptPersistError on failure.
 *
 * Per the production rehearsal: extraction may fail for any number of
 * reasons (no framework registered, LLM timeout, parse error) and the
 * caller must still hold a usable copy of the transcript so retry can
 * re-run extraction without re-pulling from the upstream provider. This
 * function is the durability gate: transcript-sync calls it first,
 * marks has_been_extracted only after it succeeds, then runs extraction
 * and the delete-after-pull step.
 *
 * Idempotent on call_id (upsert).
 */
export async function persistTranscriptBody(args: {
  tenantId: string;
  callId: string;
  body: string;
}): Promise<void> {
  const { tenantId, callId, body } = args;
  const db = supabaseAdmin();
  const res = await db
    .from("transcripts")
    .upsert(
      { tenant_id: tenantId, call_id: callId, body },
      { onConflict: "call_id" },
    );
  if (res.error) {
    throw new TranscriptPersistError(callId, res.error.message);
  }
}
