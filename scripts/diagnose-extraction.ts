/**
 * Why did this call's extraction produce nothing?
 *
 * scripts/check-extraction-yield.ts found 3 of 37 captured calls in 45 days that
 * produced almost no field_extractions rows despite substantial transcripts:
 * Speed International (54,860 chars, 1 row), Diamond Forwarding (19,700 chars,
 * 0 rows) and TW Customs (1,198 chars, 0 rows). All three were flagged
 * has_been_extracted = true, so nothing anywhere said the qualification was
 * lost.
 *
 * There are four different failures behind that one symptom, and they need
 * completely different fixes:
 *
 *   no extraction_runs row      the LLM call never happened, or threw before
 *                               the audit write. Look at calls.ingest_error.
 *   run row, empty raw_response the model returned nothing usable. A prompt or
 *                               transcript-shape problem, not a plumbing one.
 *   run row, full raw_response, the model found fields and the persist dropped
 *   but no field_extractions    them. This is the incident AuditPersistError
 *                               was added for; check whether it fired.
 *   run row + rows, all "No"    it evaluated properly and the call genuinely
 *                               had no qualification. Not a bug.
 *
 * Prints token counts and duration too, because a run with output tokens near
 * zero is a different story from one that produced 4,000 tokens nobody kept.
 *
 *   npx tsx scripts/diagnose-extraction.ts --deal Speedintlog
 *   npx tsx scripts/diagnose-extraction.ts --deal Diamondforwarding --raw
 *
 * READ ONLY. --raw prints the model's response, which contains customer
 * content, so treat that output as you would a transcript: Magaya is under NDA.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const only = arg("--deal")?.toLowerCase();
  const raw = process.argv.includes("--raw");
  if (!only) {
    console.log("\nPass --deal <name>.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const deals = await db.from("deals").select("id, account").eq("tenant_id", tenantId);
  const deal = ((deals.data ?? []) as Array<{ id: string; account: string }>).find((d) =>
    (d.account ?? "").toLowerCase().includes(only),
  );
  if (!deal) {
    console.log(`\nNo deal matching "${only}".\n`);
    process.exit(1);
  }

  console.log(`\n${deal.account}\n${"=".repeat(72)}`);

  const callsRes = await db
    .from("calls")
    .select("id, title, scheduled_start, outcome, has_been_extracted, ingest_error")
    .eq("deal_id", deal.id)
    .order("scheduled_start", { ascending: false });
  const calls = (callsRes.data ?? []) as Array<Record<string, unknown>>;

  const trs = await db
    .from("transcripts")
    .select("call_id, body")
    .in("call_id", calls.map((c) => String(c.id)));
  const lenByCall = new Map(
    ((trs.data ?? []) as Array<{ call_id: string; body: string | null }>).map((t) => [t.call_id, (t.body ?? "").length]),
  );

  const runsRes = await db
    .from("extraction_runs")
    .select("call_id, model_name, prompt_version, raw_response, token_input, token_output, duration_ms, created_at")
    .eq("deal_id", deal.id)
    .order("created_at", { ascending: false });
  const runs = (runsRes.data ?? []) as Array<Record<string, unknown>>;

  const fxRes = await db
    .from("field_extractions")
    .select("framework_field_key, status, last_updated_from_call_id")
    .eq("deal_id", deal.id);
  const fx = (fxRes.data ?? []) as Array<Record<string, unknown>>;

  for (const c of calls) {
    const id = String(c.id);
    const chars = lenByCall.get(id) ?? 0;
    const myRuns = runs.filter((r) => String(r.call_id) === id);
    const myFx = fx.filter((f) => String(f.last_updated_from_call_id) === id);

    console.log(`\n${formatMeetingTime(String(c.scheduled_start ?? ""))}  ${String(c.title ?? "").slice(0, 44)}`);
    console.log(`  outcome=${c.outcome ?? "none"}  extracted=${c.has_been_extracted ? "yes" : "no"}  transcript=${chars} chars`);
    if (c.ingest_error) console.log(`  ingest_error: ${c.ingest_error}`);

    if (myRuns.length === 0) {
      console.log(`  NO extraction_runs ROW.`);
      console.log(`    The model was never called, or it threw before the audit write.`);
      console.log(`    ${c.ingest_error ? "ingest_error above is the reason." : "And ingest_error is null, so the failure was swallowed."}`);
      continue;
    }

    for (const r of myRuns) {
      const rr = r.raw_response;
      const size = rr == null ? 0 : JSON.stringify(rr).length;
      const fields = Array.isArray((rr as { fields?: unknown[] })?.fields)
        ? ((rr as { fields: unknown[] }).fields).length
        : null;
      console.log(
        `  run ${String(r.created_at).slice(0, 19)}  ${r.model_name}  in=${r.token_input ?? "?"} out=${r.token_output ?? "?"} ${r.duration_ms ?? "?"}ms`,
      );
      console.log(`      raw_response ${size} bytes${fields === null ? "" : `, ${fields} field(s) returned`}`);
      if (raw && rr != null) console.log(`      ${JSON.stringify(rr).slice(0, 4000)}`);
    }

    console.log(`  field_extractions attributed to this call: ${myFx.length}`);
    const lastRun = myRuns[0];
    const outTokens = Number(lastRun?.token_output ?? 0);
    if (myFx.length === 0 && outTokens > 200) {
      console.log(`  MISMATCH: the model produced ${outTokens} output tokens and nothing persisted.`);
      console.log(`    That is the AuditPersistError case. If ingest_error is null it did not fire.`);
    } else if (myFx.length === 0 && outTokens <= 200) {
      console.log(`  The model returned almost nothing. Prompt or transcript shape, not persistence.`);
    }
  }

  console.log(`\nTOTALS FOR THIS DEAL`);
  console.log(`  extraction_runs ${runs.length}   field_extractions ${fx.length}`);
  const unattributed = fx.filter((f) => !f.last_updated_from_call_id).length;
  if (unattributed > 0) {
    console.log(`  ${unattributed} extraction row(s) carry no call id, so per-call counts above undercount.`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
