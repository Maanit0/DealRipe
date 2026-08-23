/**
 * The one place a model call happens.
 *
 * WHY THIS EXISTS
 *
 * DealRipe makes 17 model calls across 13 modules and exactly one of them
 * writes a trace row. briefing_runs has columns for tokens, duration and
 * prompt version, and nothing in lib/ has ever written it: 61 rows, all on the
 * demo tenant, zero for Magaya against 89 briefings delivered.
 *
 * The cause is structural. lib/anthropic.ts exposes getAnthropicClient() and
 * getAnthropicModel() and nothing else, so there is no choke point: model name
 * is centralised while max_tokens, retries, error handling and tracing are
 * copy-pasted per site. Until a choke point exists, none of these are
 * answerable: what a briefing costs, which site burns the most tokens, how
 * often a call fails, how long it takes, whether a prompt change helped.
 *
 * WHAT IT GUARANTEES
 *
 *   Every call is traced, with tokens, latency, stop reason and prompt version.
 *   Every call retries transient failures the same way.
 *   A tracing failure NEVER fails the caller.
 *
 * That last one matters more than it sounds. The point of this file is
 * observability, and observability that can break the thing it observes is
 * worse than none. Every write here is best-effort and swallowed.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not own prompts, and it does not parse responses. Callers keep their
 * own system prompts and their own JSON handling, because the shapes genuinely
 * differ: a 5-token join-gate yes/no and a three-pass recap have nothing useful
 * in common above the transport. Forcing them into one abstraction would make
 * this file the thing everyone edits.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import type Anthropic from "@anthropic-ai/sdk";

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { supabaseAdmin } from "./supabase";

/**
 * WHO this work is for, carried ambiently rather than threaded.
 *
 * Measured 2026-08-23: 3,906 traced model calls and THREE of them carried a
 * tenant_id. Every trace was landing, and none of it could answer the questions
 * the table exists for: what does this customer cost, what does this deal cost,
 * is one tenant's spend running away. reengage_draft was the only site passing
 * a tenantId, because it was the only one written after the table existed.
 *
 * The obvious fix is to thread tenantId through fourteen call sites, seven of
 * which do not have it in scope and would need it plumbed through their own
 * callers. That is a wide diff across live cron paths for a bookkeeping field,
 * and it has to be redone for every new call site and every new tenant.
 *
 * This is ambient instead. A cron route or a script wraps its work once, and
 * every model call underneath it, however deeply nested, is attributed. An
 * explicit argument still wins, so a caller that knows better always can.
 *
 * AsyncLocalStorage survives await boundaries, which is what makes this safe
 * under the concurrency these crons run at: two tenants processed in parallel
 * do not see each other's context.
 */
type ModelContext = { tenantId?: string | null; dealId?: string | null; callId?: string | null };
const modelContext = new AsyncLocalStorage<ModelContext>();

/**
 * Run `fn` with every model call inside it attributed to this tenant/deal/call.
 *
 * Nests: an inner call overrides only the fields it names, so a route can set
 * the tenant once and a per-deal loop can add the deal id without restating it.
 */
export function withModelContext<T>(ctx: ModelContext, fn: () => Promise<T>): Promise<T> {
  const parent = modelContext.getStore() ?? {};
  return modelContext.run({ ...parent, ...ctx }, fn);
}

/** What the ambient context currently holds, for a diagnostic that wants to
 *  prove attribution is on the path before a long run. */
export function currentModelContext(): ModelContext {
  return { ...(modelContext.getStore() ?? {}) };
}

export type ModelRunArgs = {
  /**
   * Stable slug for the call site. Dotted for families, so "recap.narrative"
   * and "recap.demo_strategy" roll up without parsing.
   *
   * Never interpolate a deal name or an id into this. It is a dimension, and a
   * dimension with unbounded cardinality cannot be grouped.
   */
  task: string;
  /** Bump when the prompt changes. Without it every prompt is v1 forever. */
  promptVersion?: string;
  tenantId?: string | null;
  dealId?: string | null;
  callId?: string | null;

  system?: string;
  messages: Anthropic.MessageParam[];
  maxTokens: number;
  temperature?: number;
  /** Override the model for one call. Almost never right; the default is the
   *  project model and keeping sites on it is what makes costs comparable. */
  model?: string;
  /** Transient-failure retries. Zero for a call whose caller has its own. */
  retries?: number;
  /**
   * Abort signal, for a caller that enforces its own deadline.
   *
   * Extraction is the one site with a hard timeout, because transcript-sync
   * runs inside a 300s ceiling and a hung extraction costs the whole run. An
   * abort is never retried: the caller's deadline has passed, so retrying would
   * spend time the caller has already said it does not have.
   */
  signal?: AbortSignal;
};

export type ModelRunResult = {
  /** Concatenated text blocks. Every current call site wants exactly this. */
  text: string;
  /** The raw message, for a caller that needs stop_reason or usage itself. */
  message: Anthropic.Message;
  /** True when the model ran out of room. NOT an error: the answer is real
   *  and truncated, and several callers already check for this by hand. */
  truncated: boolean;
  durationMs: number;
};

/** Overloaded, rate-limited, or a 5xx. A 400 is a bug in our request and
 *  retrying it just delays an honest error. */
function isTransient(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

function textOf(m: Anthropic.Message): string {
  return m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/**
 * Best effort, always. A trace that can fail the call it traces is worse than
 * no trace, so every error here is swallowed after one console line.
 *
 * The table may not exist yet, which is the common case on a fresh
 * environment. That is not worth a stack trace on every call.
 */
async function record(row: Record<string, unknown>): Promise<void> {
  try {
    const res = await supabaseAdmin().from("model_runs").insert(row as never);
    if (res.error && !/schema cache|does not exist/i.test(res.error.message)) {
      console.warn(`[model-run] trace insert failed: ${res.error.message}`);
    }
  } catch (err) {
    console.warn(`[model-run] trace threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Run one model call and trace it.
 *
 * Throws what the SDK throws, after tracing the failure. Callers keep their
 * existing try/catch and their existing fallbacks; this changes what is
 * recorded, not what happens.
 */
export async function runModel(args: ModelRunArgs): Promise<ModelRunResult> {
  const model = args.model ?? getAnthropicModel();
  // Explicit wins, ambient fills in. `undefined` means "not stated", while an
  // explicit null means "deliberately none", so only undefined falls through.
  const ambient = modelContext.getStore() ?? {};
  const tenantId = args.tenantId !== undefined ? args.tenantId : (ambient.tenantId ?? null);
  const dealId = args.dealId !== undefined ? args.dealId : (ambient.dealId ?? null);
  const callId = args.callId !== undefined ? args.callId : (ambient.callId ?? null);
  const started = Date.now();
  const retries = args.retries ?? 2;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const message = await getAnthropicClient().messages.create(
        {
          model,
          max_tokens: args.maxTokens,
          ...(args.temperature !== undefined ? { temperature: args.temperature } : {}),
          ...(args.system ? { system: args.system } : {}),
          messages: args.messages,
        },
        args.signal ? { signal: args.signal } : undefined,
      );
      const durationMs = Date.now() - started;
      const u = message.usage as unknown as {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
      await record({
        tenant_id: tenantId,
        deal_id: dealId,
        call_id: callId,
        task: args.task,
        prompt_version: args.promptVersion ?? "v1",
        model,
        input_tokens: u?.input_tokens ?? null,
        output_tokens: u?.output_tokens ?? null,
        cache_read_tokens: u?.cache_read_input_tokens ?? null,
        cache_write_tokens: u?.cache_creation_input_tokens ?? null,
        duration_ms: durationMs,
        stop_reason: message.stop_reason ?? null,
        ok: true,
        error: null,
      });
      return {
        text: textOf(message),
        message,
        // Truncation is a QUALITY fact, not a failure. ok stays true and the
        // caller decides what a half-written answer is worth.
        truncated: message.stop_reason === "max_tokens",
        durationMs,
      };
    } catch (err) {
      lastErr = err;
      // An abort is the caller's deadline, not a transient fault.
      if (args.signal?.aborted) break;
      if (attempt < retries && isTransient(err)) {
        const waitMs = 1000 * 2 ** attempt;
        console.warn(
          `[model-run] ${args.task} attempt ${attempt + 1} failed transiently, retrying in ${waitMs}ms`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      break;
    }
  }

  await record({
    tenant_id: tenantId,
    deal_id: dealId,
    call_id: callId,
    task: args.task,
    prompt_version: args.promptVersion ?? "v1",
    model,
    duration_ms: Date.now() - started,
    ok: false,
    error: lastErr instanceof Error ? lastErr.message.slice(0, 500) : String(lastErr).slice(0, 500),
  });
  throw lastErr;
}
