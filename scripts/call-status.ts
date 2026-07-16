/**
 * Inspect what happened on a deal's call(s): bot, transcript capture,
 * extraction, write-back, recap. Read-only.
 *
 *   npx tsx scripts/call-status.ts --deal dutyfreeamericas
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ext = arg("--deal");
  if (!ext) {
    console.error("Usage: --deal <external_id>");
    process.exit(1);
  }
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const deal = await db
    .from("deals")
    .select("id, external_id, account, rep_email, rolldog_opportunity_id, rolldog_link_confidence, dealripe_last_writeback_at")
    .eq("tenant_id", tenantId)
    .eq("external_id", ext)
    .maybeSingle();
  if (deal.error || !deal.data) {
    console.error(`Deal '${ext}' not found.`);
    process.exit(1);
  }
  const d = deal.data;
  console.log(`\nDeal:            ${d.external_id}  "${d.account}"  [${d.rep_email ?? "?"}]`);
  console.log(`Rolldog opp:     ${d.rolldog_opportunity_id ?? "(pilot map / none in column)"}`);
  console.log(`Last write-back: ${d.dealripe_last_writeback_at ?? "NONE yet"}`);

  const calls = await db
    .from("calls")
    .select("id, call_date, scheduled_start, duration_minutes, source, recall_bot_id, transcript_id, has_been_extracted, briefing_sent_at, ingest_error")
    .eq("tenant_id", tenantId)
    .eq("deal_id", d.id)
    .order("scheduled_start", { ascending: false });

  console.log(`\nCalls (${calls.data?.length ?? 0}):`);
  for (const c of calls.data ?? []) {
    // The transcript body lives in the transcripts table (keyed by call_id),
    // not the calls.transcript_id column, so check there for the real answer.
    const t = await db.from("transcripts").select("body").eq("call_id", c.id).maybeSingle();
    const bodyLen = t.data?.body?.length ?? 0;
    console.log(`  - scheduled: ${c.scheduled_start ?? "?"}   source: ${c.source ?? "?"}`);
    console.log(`    bot:        ${c.recall_bot_id ?? "(none)"}`);
    console.log(`    transcript: ${bodyLen > 0 ? `STORED (${bodyLen} chars)` : "not stored"}   duration: ${c.duration_minutes ?? "?"} min`);
    console.log(`    extracted:  ${c.has_been_extracted ? "YES" : "no"}`);
    console.log(`    briefing:   ${c.briefing_sent_at ?? "not sent"}`);
    console.log(`    ingest err: ${c.ingest_error ?? "none"}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
