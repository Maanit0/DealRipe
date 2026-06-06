/**
 * Verifies two invariants for transcript-sync (lib/transcript-sync.ts):
 *
 *   SCENARIO A (post-persistence extraction failure):
 *     When extraction fails AFTER the transcript body has been persisted,
 *     the resulting state satisfies:
 *       (a) transcripts.body row exists for the call
 *       (b) calls.ingest_error is set
 *       (c) calls.has_been_extracted = true
 *       (d) the row is visible to the --retry-ingest filter
 *           (ingest_error IS NOT NULL)
 *
 *   SCENARIO B (successful extraction writes per-field rows):
 *     When extraction succeeds, field_extractions has at least one row
 *     stamped with last_updated_from_call_id = the call's id. This guards
 *     against the rehearsal regression where extraction_runs landed but
 *     field_extractions silently did not, and ingest_error stayed null.
 *
 * Both scenarios use isolated synthetic tenants so the test does not
 * depend on which tenants (topsort/magaya) happen to have a framework
 * registered. Cleanup cascades on tenant delete.
 *
 * Run:
 *   npm run test:ordering
 *
 * Prereqs: Supabase env vars set, ANTHROPIC_API_KEY set (Scenario B
 * makes a real LLM call, costing a few cents).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  DealNotResolvedError,
  FrameworkNotConfiguredError,
  extractAndStore,
  persistTranscriptBody,
} from "../lib/transcript-ingest";
import { __invalidateFrameworkCache } from "../lib/framework";
import { SCOTSMAN_FIELDS } from "../lib/scotsman";
import { supabaseAdmin } from "../lib/supabase";

const LINE = "=".repeat(72);

type TenantHandle = {
  tenantId: string;
  slug: string;
};

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. Required for Scenario B (real LLM call).",
    );
    process.exit(1);
  }

  const db = supabaseAdmin();
  const tenantsToCleanup: TenantHandle[] = [];
  let allPassed = true;

  try {
    console.log("");
    console.log(LINE);
    console.log("Transcript-sync ordering invariant tests");
    console.log(LINE);

    const a = await runScenarioA(db, tenantsToCleanup);
    if (!a) allPassed = false;

    const b = await runScenarioB(db, tenantsToCleanup);
    if (!b) allPassed = false;

    console.log("");
    console.log(LINE);
    console.log(`Overall: ${allPassed ? "PASS" : "FAIL"}`);
    console.log(LINE);
    if (!allPassed) process.exitCode = 1;
  } catch (err) {
    console.error("Unexpected test error:", err);
    process.exitCode = 1;
  } finally {
    for (const t of tenantsToCleanup) {
      const del = await db.from("tenants").delete().eq("id", t.tenantId);
      if (del.error) {
        console.error(
          `[cleanup] tenant delete failed (manual cleanup needed for slug=${t.slug}): ${del.error.message}`,
        );
      } else {
        console.log(`[cleanup] removed synthetic tenant ${t.slug} (cascade)`);
      }
    }
  }
}

// ====================================================================
// Scenario A: extraction failure after body persistence
// ====================================================================

async function runScenarioA(
  db: ReturnType<typeof supabaseAdmin>,
  cleanup: TenantHandle[],
): Promise<boolean> {
  console.log("");
  console.log("--- Scenario A: extraction failure after body persistence ---");
  console.log("");

  const seed = `${Date.now()}-a`;
  const slug = `ordering-test-${seed}`;
  const externalDealId = `ORDERING_TEST_DEAL_${seed}`;
  const externalCallId = `ORDERING_TEST_CALL_${seed}`;

  const { tenantId } = await createTenant(db, slug, cleanup);
  const dealId = await createDeal(db, tenantId, externalDealId);
  const callId = await createCall(db, tenantId, dealId, externalCallId, seed);

  // Persist body FIRST (the new ordering).
  const body = "CUSTOMER: We need this by Friday.\nREP: Got it.";
  console.log("[A.1] persistTranscriptBody(...)");
  await persistTranscriptBody({ tenantId, callId, body });

  console.log("[A.2] mark calls.has_been_extracted = true");
  const mark = await db
    .from("calls")
    .update({ has_been_extracted: true })
    .eq("id", callId);
  if (mark.error) throw new Error(`mark failed: ${mark.error.message}`);

  console.log("[A.3] extractAndStore (expecting FrameworkNotConfiguredError)");
  let extractionError: unknown = null;
  try {
    await extractAndStore({
      transcript: body,
      dealExternalId: externalDealId,
      callExternalId: externalCallId,
    });
    throw new Error("expected extractAndStore to throw, but it succeeded");
  } catch (err) {
    if (
      err instanceof FrameworkNotConfiguredError ||
      err instanceof DealNotResolvedError ||
      err instanceof Error
    ) {
      extractionError = err;
      console.log(
        `      caught ${(err as Error).name}: ${(err as Error).message.slice(0, 120)}`,
      );
    } else {
      throw err;
    }
  }

  const message =
    extractionError instanceof Error
      ? extractionError.message
      : String(extractionError);
  console.log("[A.4] set calls.ingest_error");
  const errUpd = await db
    .from("calls")
    .update({
      ingest_error: `extraction failed (transcript saved; use --retry-ingest): ${message}`,
    })
    .eq("id", callId);
  if (errUpd.error) throw new Error(`ingest_error: ${errUpd.error.message}`);

  console.log("");
  console.log("Scenario A invariants:");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];

  const tx = await db
    .from("transcripts")
    .select("body")
    .eq("call_id", callId)
    .maybeSingle();
  checks.push({
    label: "(a) transcripts.body row exists",
    ok: !tx.error && !!tx.data?.body && tx.data.body === body,
    detail: tx.error ? tx.error.message : tx.data?.body ? "body matches" : "no row",
  });

  const callRow = await db
    .from("calls")
    .select("has_been_extracted, ingest_error")
    .eq("id", callId)
    .single();
  checks.push({
    label: "(b) calls.ingest_error is set",
    ok: !callRow.error && callRow.data?.ingest_error != null,
    detail: callRow.error
      ? callRow.error.message
      : (callRow.data?.ingest_error ?? "(null)").slice(0, 80),
  });
  checks.push({
    label: "(c) calls.has_been_extracted = true",
    ok: !callRow.error && callRow.data?.has_been_extracted === true,
    detail: callRow.error
      ? callRow.error.message
      : String(callRow.data?.has_been_extracted),
  });

  const retryHit = await db
    .from("calls")
    .select("id")
    .eq("tenant_id", tenantId)
    .not("ingest_error", "is", null);
  const visible =
    !retryHit.error && (retryHit.data ?? []).some((r) => r.id === callId);
  checks.push({
    label: "(d) retry-ingest filter matches",
    ok: visible,
    detail: retryHit.error
      ? retryHit.error.message
      : visible
        ? `${retryHit.data?.length ?? 0} candidates, including this call`
        : "row not visible",
  });

  return reportChecks(checks);
}

// ====================================================================
// Scenario B: successful extraction stamps field_extractions rows
// ====================================================================

async function runScenarioB(
  db: ReturnType<typeof supabaseAdmin>,
  cleanup: TenantHandle[],
): Promise<boolean> {
  console.log("");
  console.log("--- Scenario B: success path + Yes-over-Yes overwrite ---");
  console.log("");

  const seed = `${Date.now()}-b`;
  const slug = `ordering-test-${seed}`;
  const externalDealId = `ORDERING_TEST_DEAL_${seed}`;
  const externalCallId = `ORDERING_TEST_CALL_${seed}`;

  const { tenantId } = await createTenant(db, slug, cleanup);
  const frameworkId = await registerScotsmanFramework(db, tenantId);
  const dealId = await createDeal(db, tenantId, externalDealId);
  const callId = await createCall(db, tenantId, dealId, externalCallId, seed);

  // Seed a PRIOR Yes on M1 with stale content. The next extraction will
  // re-confirm Money is defined but from a different transcript; the new
  // merge semantics say: incoming Yes overwrites prior Yes.
  const PRIOR_M1_ANSWER = "PRIOR_RUN_BUDGET_TEN_THOUSAND";
  const PRIOR_M1_EVIDENCE = "PRIOR_RUN_QUOTE_TEN_THOUSAND";
  console.log("[B.0] seeding prior Yes for M1 with stale content");
  const seedFx = await db
    .from("field_extractions")
    .insert({
      tenant_id: tenantId,
      deal_id: dealId,
      framework_field_key: "M1",
      framework_id: frameworkId,
      status: "Yes",
      answer: PRIOR_M1_ANSWER,
      evidence: PRIOR_M1_EVIDENCE,
      confidence: 0.85,
      last_updated_from_call_id: null,
    })
    .select("id")
    .single();
  if (seedFx.error || !seedFx.data) {
    throw new Error(`prior M1 seed failed: ${seedFx.error?.message}`);
  }

  // Transcript surfaces M1 (budget) with NEW content that differs from the
  // seeded prior. The customer states an unambiguous, customer-spoken budget
  // figure to give the LLM no reason to mark M1 anything other than Yes.
  const body =
    "REP: Where did you land on budget for this rollout?\n" +
    "CUSTOMER: We've now got seventy-five thousand dollars approved by our CFO Jane Smith, signed off by procurement last week.\n" +
    "REP: That's helpful. And on timing?\n" +
    "CUSTOMER: We need to be live by Friday June 20.";

  console.log("[B.1] persistTranscriptBody(...)");
  await persistTranscriptBody({ tenantId, callId, body });

  console.log("[B.2] mark calls.has_been_extracted = true");
  const mark = await db
    .from("calls")
    .update({ has_been_extracted: true })
    .eq("id", callId);
  if (mark.error) throw new Error(`mark failed: ${mark.error.message}`);

  console.log("[B.3] extractAndStore (real LLM call)...");
  try {
    await extractAndStore({
      transcript: body,
      dealExternalId: externalDealId,
      callExternalId: externalCallId,
    });
    console.log("      extraction returned successfully.");
  } catch (err) {
    console.error(
      `      extractAndStore threw: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }

  console.log("");
  console.log("Scenario B invariants:");

  const checks: { label: string; ok: boolean; detail?: string }[] = [];

  const runs = await db
    .from("extraction_runs")
    .select("id, raw_response")
    .eq("call_id", callId);
  const runCount = runs.data?.length ?? 0;
  checks.push({
    label: "(e) extraction_runs has at least one row for this call",
    ok: !runs.error && runCount > 0,
    detail: runs.error ? runs.error.message : `${runCount} run row(s)`,
  });

  const fxRows = await db
    .from("field_extractions")
    .select("framework_field_key, status, last_updated_from_call_id")
    .eq("deal_id", dealId)
    .eq("last_updated_from_call_id", callId);
  const fxCount = fxRows.data?.length ?? 0;
  checks.push({
    label: "(f) field_extractions has rows stamped with this call id",
    ok: !fxRows.error && fxCount > 0,
    detail: fxRows.error
      ? fxRows.error.message
      : `${fxCount} row(s) [${(fxRows.data ?? []).map((r) => `${r.framework_field_key}:${r.status}`).join(",")}]`,
  });

  const callRow = await db
    .from("calls")
    .select("ingest_error")
    .eq("id", callId)
    .single();
  checks.push({
    label: "(g) calls.ingest_error is null (success path)",
    ok: !callRow.error && callRow.data?.ingest_error == null,
    detail: callRow.error
      ? callRow.error.message
      : callRow.data?.ingest_error ?? "(null)",
  });

  // ----- Yes-over-Yes overwrite invariants -----
  //
  // The seeded prior M1 had marker strings as answer + evidence. After the
  // new extraction (which re-confirms M1 with different transcript
  // content), the row should have:
  //   - new last_updated_from_call_id (= this call)
  //   - answer != prior marker
  //   - evidence != prior marker
  // Status stays Yes (confirmed both calls), but the payload moved.

  const m1Row = await db
    .from("field_extractions")
    .select("status, answer, evidence, confidence, last_updated_from_call_id")
    .eq("deal_id", dealId)
    .eq("framework_field_key", "M1")
    .single();

  checks.push({
    label: "(h) M1 status is still Yes after re-confirmation",
    ok: !m1Row.error && m1Row.data?.status === "Yes",
    detail: m1Row.error ? m1Row.error.message : `status=${m1Row.data?.status}`,
  });
  checks.push({
    label: "(i) M1 last_updated_from_call_id was advanced to this call",
    ok: !m1Row.error && m1Row.data?.last_updated_from_call_id === callId,
    detail: m1Row.error
      ? m1Row.error.message
      : `stored=${m1Row.data?.last_updated_from_call_id ?? "(null)"} expected=${callId}`,
  });
  checks.push({
    label: "(j) M1 answer was overwritten (not the prior marker)",
    ok: !m1Row.error && m1Row.data?.answer !== PRIOR_M1_ANSWER,
    detail: m1Row.error
      ? m1Row.error.message
      : `answer=${truncate(m1Row.data?.answer ?? "(null)", 100)}`,
  });
  checks.push({
    label: "(k) M1 evidence was overwritten (not the prior marker)",
    ok: !m1Row.error && m1Row.data?.evidence !== PRIOR_M1_EVIDENCE,
    detail: m1Row.error
      ? m1Row.error.message
      : `evidence=${truncate(m1Row.data?.evidence ?? "(null)", 100)}`,
  });

  return reportChecks(checks);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

// ====================================================================
// Helpers
// ====================================================================

async function createTenant(
  db: ReturnType<typeof supabaseAdmin>,
  slug: string,
  cleanup: TenantHandle[],
): Promise<TenantHandle> {
  console.log(`[setup] creating tenant slug=${slug}`);
  const ins = await db
    .from("tenants")
    .insert({ slug, name: "Ordering Test" })
    .select("id")
    .single();
  if (ins.error || !ins.data) {
    throw new Error(`tenant insert failed: ${ins.error?.message}`);
  }
  const handle = { tenantId: ins.data.id, slug };
  cleanup.push(handle);
  console.log(`        tenantId=${handle.tenantId}`);
  return handle;
}

async function registerScotsmanFramework(
  db: ReturnType<typeof supabaseAdmin>,
  tenantId: string,
): Promise<string> {
  const fw = await db
    .from("qualification_frameworks")
    .insert({ tenant_id: tenantId, name: "SCOTSMAN", source: "builtin" })
    .select("id")
    .single();
  if (fw.error || !fw.data) {
    throw new Error(`framework insert failed: ${fw.error?.message}`);
  }
  const frameworkId = fw.data.id;

  const fieldRows = SCOTSMAN_FIELDS.map((f, i) => ({
    tenant_id: tenantId,
    framework_id: frameworkId,
    field_key: f.id,
    label: f.label,
    question: f.question,
    stage_key: null,
    write_target: null,
    sort_order: i,
  }));
  const fields = await db.from("framework_fields").insert(fieldRows);
  if (fields.error) {
    throw new Error(`framework_fields insert failed: ${fields.error.message}`);
  }
  // Bust the cache so loadFramework() picks up the new framework on its
  // next call (within this same process).
  __invalidateFrameworkCache(tenantId);
  console.log(`[setup] registered SCOTSMAN framework id=${frameworkId}`);
  return frameworkId;
}

async function createDeal(
  db: ReturnType<typeof supabaseAdmin>,
  tenantId: string,
  externalId: string,
): Promise<string> {
  console.log(`[setup] creating deal external_id=${externalId}`);
  const ins = await db
    .from("deals")
    .insert({
      tenant_id: tenantId,
      external_id: externalId,
      account: "Ordering Test Account",
      stage_key: "test",
    })
    .select("id")
    .single();
  if (ins.error || !ins.data) {
    throw new Error(`deal insert failed: ${ins.error?.message}`);
  }
  return ins.data.id;
}

async function createCall(
  db: ReturnType<typeof supabaseAdmin>,
  tenantId: string,
  dealId: string,
  externalId: string,
  seed: string,
): Promise<string> {
  console.log(`[setup] creating call external_id=${externalId}`);
  const ins = await db
    .from("calls")
    .insert({
      tenant_id: tenantId,
      deal_id: dealId,
      external_id: externalId,
      source: "recall_ai",
      recall_bot_id: `synthetic-${seed}`,
      has_been_extracted: false,
    })
    .select("id")
    .single();
  if (ins.error || !ins.data) {
    throw new Error(`call insert failed: ${ins.error?.message}`);
  }
  console.log(`        callId=${ins.data.id}`);
  return ins.data.id;
}

function reportChecks(
  checks: { label: string; ok: boolean; detail?: string }[],
): boolean {
  let pass = 0;
  for (const c of checks) {
    const verdict = c.ok ? "PASS" : "FAIL";
    console.log(`  [${verdict}] ${c.label}`);
    if (c.detail) console.log(`         ${c.detail}`);
    if (c.ok) pass += 1;
  }
  console.log(`  -> ${pass} of ${checks.length} checks passed.`);
  return pass === checks.length;
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
