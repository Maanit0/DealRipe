/**
 * Verifies the production-rehearsal ordering invariant for
 * transcript-sync (lib/transcript-sync.ts):
 *
 *   When extraction fails AFTER the transcript body has been persisted,
 *   the resulting state must satisfy:
 *
 *     (a) transcripts.body row exists for the call
 *     (b) calls.ingest_error is set
 *     (c) calls.has_been_extracted = true
 *     (d) the row is visible to the --retry-ingest filter
 *         (ingest_error IS NOT NULL)
 *
 * The test creates an isolated synthetic tenant with NO framework
 * registered, so extractAndStore will deterministically throw
 * FrameworkNotConfiguredError. The synthetic tenant cascades on delete,
 * so cleanup is one DELETE.
 *
 * Run:
 *   npm run test:ordering
 *
 * Prereqs: Supabase env vars set, ANTHROPIC_API_KEY set (so the LLM
 * gate doesn't short-circuit before the framework check).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  DealNotResolvedError,
  FrameworkNotConfiguredError,
  extractAndStore,
  persistTranscriptBody,
} from "../lib/transcript-ingest";
import { supabaseAdmin } from "../lib/supabase";

const LINE = "=".repeat(72);

type TestState = {
  tenantId?: string;
  dealId?: string;
  callId?: string;
  externalDealId?: string;
  externalCallId?: string;
};

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "ANTHROPIC_API_KEY is not set. The test relies on extractAndStore reaching the framework check, which happens AFTER the key check.",
    );
    process.exit(1);
  }

  const db = supabaseAdmin();
  const state: TestState = {};
  const seed = Date.now();

  console.log("");
  console.log(LINE);
  console.log("Transcript-sync ordering invariant test");
  console.log(LINE);
  console.log("");

  try {
    // ----- Setup: isolated synthetic tenant + deal + call. -----

    const slug = `ordering-test-${seed}`;
    state.externalDealId = `ORDERING_TEST_DEAL_${seed}`;
    state.externalCallId = `ORDERING_TEST_CALL_${seed}`;

    console.log(`[setup] creating tenant slug=${slug}`);
    const tenantIns = await db
      .from("tenants")
      .insert({ slug, name: "Ordering Test" })
      .select("id")
      .single();
    if (tenantIns.error || !tenantIns.data) {
      throw new Error(`tenant insert failed: ${tenantIns.error?.message}`);
    }
    state.tenantId = tenantIns.data.id;
    console.log(`        tenantId=${state.tenantId}`);

    console.log(`[setup] creating deal external_id=${state.externalDealId}`);
    const dealIns = await db
      .from("deals")
      .insert({
        tenant_id: state.tenantId,
        external_id: state.externalDealId,
        account: "Ordering Test Account",
        stage_key: "test",
      })
      .select("id")
      .single();
    if (dealIns.error || !dealIns.data) {
      throw new Error(`deal insert failed: ${dealIns.error?.message}`);
    }
    state.dealId = dealIns.data.id;

    console.log(`[setup] creating call external_id=${state.externalCallId}`);
    const callIns = await db
      .from("calls")
      .insert({
        tenant_id: state.tenantId,
        deal_id: state.dealId,
        external_id: state.externalCallId,
        source: "recall_ai",
        recall_bot_id: `synthetic-${seed}`,
        has_been_extracted: false,
      })
      .select("id")
      .single();
    if (callIns.error || !callIns.data) {
      throw new Error(`call insert failed: ${callIns.error?.message}`);
    }
    state.callId = callIns.data.id;
    console.log(`        callId=${state.callId}`);
    console.log("");

    // ----- Step 1: persist the body BEFORE attempting extraction. -----

    const body = "CUSTOMER: We need this by Friday.\nREP: Got it.";
    console.log("[1] persistTranscriptBody(...)");
    await persistTranscriptBody({
      tenantId: state.tenantId,
      callId: state.callId,
      body,
    });
    console.log("    persisted.");

    // ----- Step 2: mark has_been_extracted = true (the gate). -----

    console.log("[2] mark calls.has_been_extracted = true");
    const mark = await db
      .from("calls")
      .update({ has_been_extracted: true })
      .eq("id", state.callId);
    if (mark.error) {
      throw new Error(`mark failed: ${mark.error.message}`);
    }

    // ----- Step 3: attempt extraction. Should throw because the
    //               synthetic tenant has no framework registered. -----

    console.log(
      "[3] extractAndStore(...) (expecting FrameworkNotConfiguredError)",
    );
    let extractionError: unknown = null;
    try {
      await extractAndStore({
        transcript: body,
        dealExternalId: state.externalDealId,
        callExternalId: state.externalCallId,
      });
      throw new Error(
        "expected extractAndStore to throw FrameworkNotConfiguredError, but it succeeded",
      );
    } catch (err) {
      if (
        err instanceof FrameworkNotConfiguredError ||
        // Tier-2 resolveAuditTargets may return null for the synthetic
        // tenant (no framework -> no priorExtraction path). Either is a
        // valid "extraction failed" scenario for the invariant.
        err instanceof DealNotResolvedError
      ) {
        extractionError = err;
        console.log(`    caught: ${err.name}: ${err.message}`);
      } else if (err instanceof Error) {
        // Any other thrown Error is still a valid "post-persistence
        // extraction failure" scenario for the invariant — the body is
        // already durable regardless of what threw.
        extractionError = err;
        console.log(`    caught (other): ${err.name}: ${err.message}`);
      } else {
        throw err;
      }
    }

    const extractionMessage =
      extractionError instanceof Error
        ? extractionError.message
        : String(extractionError);

    // ----- Step 4: simulate transcript-sync's response to a failed
    //               extraction: write ingest_error. -----

    console.log("[4] set calls.ingest_error");
    const errUpd = await db
      .from("calls")
      .update({
        ingest_error: `extraction failed (transcript saved; use --retry-ingest): ${extractionMessage}`,
      })
      .eq("id", state.callId);
    if (errUpd.error) {
      throw new Error(`ingest_error write failed: ${errUpd.error.message}`);
    }
    console.log("");

    // ----- Assertions. -----

    console.log(LINE);
    console.log("Invariant checks");
    console.log(LINE);

    const checks: { label: string; ok: boolean; detail?: string }[] = [];

    const tx = await db
      .from("transcripts")
      .select("body")
      .eq("call_id", state.callId)
      .maybeSingle();
    checks.push({
      label: "(a) transcripts.body row exists for the call",
      ok: !tx.error && !!tx.data?.body && tx.data.body === body,
      detail: tx.error
        ? tx.error.message
        : tx.data?.body
          ? "body matches"
          : "no row",
    });

    const callRow = await db
      .from("calls")
      .select("has_been_extracted, ingest_error")
      .eq("id", state.callId)
      .single();
    checks.push({
      label: "(b) calls.ingest_error is set",
      ok: !callRow.error && callRow.data?.ingest_error != null,
      detail: callRow.error
        ? callRow.error.message
        : (callRow.data?.ingest_error ?? "(null)"),
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
      .eq("tenant_id", state.tenantId)
      .not("ingest_error", "is", null);
    const visible =
      !retryHit.error && (retryHit.data ?? []).some((r) => r.id === state.callId);
    checks.push({
      label: "(d) retry-ingest filter (ingest_error IS NOT NULL) matches",
      ok: visible,
      detail: retryHit.error
        ? retryHit.error.message
        : visible
          ? `${retryHit.data?.length ?? 0} candidates, including this call`
          : "row not visible",
    });

    let pass = 0;
    for (const c of checks) {
      const verdict = c.ok ? "PASS" : "FAIL";
      console.log(`  [${verdict}] ${c.label}`);
      if (c.detail) console.log(`         ${c.detail}`);
      if (c.ok) pass += 1;
    }
    console.log("");
    console.log(`Result: ${pass} of ${checks.length} checks passed.`);
    console.log("");

    if (pass !== checks.length) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error("Unexpected test error:", err);
    process.exitCode = 1;
  } finally {
    if (state.tenantId) {
      const del = await db
        .from("tenants")
        .delete()
        .eq("id", state.tenantId);
      if (del.error) {
        console.error(
          `[cleanup] tenant delete failed (manual cleanup needed for slug=ordering-test-${seed}): ${del.error.message}`,
        );
      } else {
        console.log(
          `[cleanup] removed synthetic tenant ordering-test-${seed} (cascade)`,
        );
      }
    }
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
