/**
 * Deliberate, single-deal Rolldog write for one active deal whose recommended
 * next step is still live and worth having in Rolldog before its next call.
 * NOT a pipeline sweep. Uses the exact live write-back path, so it refreshes
 * DealRipe's own notes fields (idempotent) and creates ONE next-step activity in
 * the interactions tab.
 *
 * Safe by default: prints the deal, its latest captured call, and the next
 * action that would be written, and does nothing without --apply. Run the
 * preview first, confirm the deal is Rolldog-linked and the next step reads
 * right, THEN re-run with --apply. Run --apply at most once (the next-step
 * activity is not idempotent; a second run adds a second activity).
 *
 *   npx tsx scripts/write-nextstep.ts --deal <external_id>
 *   npx tsx scripts/write-nextstep.ts --account "Air Americas"       # find by name
 *   npx tsx scripts/write-nextstep.ts --account "Air Americas" --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import type { ExtractionMap } from "../lib/briefing-magaya";
import { loadFramework } from "../lib/framework";
import { generatePostCallSummary } from "../lib/post-call-summary";
import { getDealExtraction } from "../lib/supabase-queries";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { writeBackDealToRolldog } from "../lib/rolldog-writeback";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ext = arg("--deal");
  const account = arg("--account");
  const apply = process.argv.includes("--apply");
  if (!ext && !account) {
    console.error('Usage: --deal <external_id> | --account "<name>" [--apply]');
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const cols =
    "id, account, external_id, stage_key, framework_id, rep_forecast_close_date, rolldog_opportunity_id, rolldog_link_confidence";
  // Spaces become wildcards so "Air Americas" also matches a stored "Airamericas".
  const pattern = account ? `%${account.trim().split(/\s+/).join("%")}%` : "";
  let query = db.from("deals").select(cols).eq("tenant_id", tenantId);
  query = ext ? query.eq("external_id", ext) : query.ilike("account", pattern);
  const dealRes = await query.limit(5);
  const rows = (dealRes.data ?? []) as Array<{ id: string; account: string; external_id: string | null }>;
  if (dealRes.error || rows.length === 0) {
    console.error(`Deal not found for ${ext ? `--deal ${ext}` : `--account "${account}"`}.`);
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error(`Ambiguous: ${rows.length} deals match "${account}". Re-run with --deal <external_id>:`);
    for (const r of rows) console.error(`  ${r.account}  ->  ${r.external_id}`);
    process.exit(1);
  }
  const deal = rows[0] as typeof rows[0] & {
    stage_key: string;
    framework_id: string | null;
    rep_forecast_close_date: string | null;
    rolldog_opportunity_id: string | null;
    rolldog_link_confidence: string | null;
  };

  const dealExt = deal.external_id ?? "";
  const staticOpp = rolldogOppIdForDeal(dealExt);
  const opp = staticOpp ?? deal.rolldog_opportunity_id;
  const linked = !!staticOpp || (!!deal.rolldog_opportunity_id && ["confirmed", "high"].includes(deal.rolldog_link_confidence ?? ""));

  // Latest captured call + its transcript, to regenerate the current next step.
  const callRes = await db
    .from("calls")
    .select("id, scheduled_start")
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.id)
    .eq("outcome", "captured")
    .order("scheduled_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (callRes.error || !callRes.data) {
    console.error(`No captured call found for '${deal.account}'.`);
    process.exit(1);
  }
  const call = callRes.data;
  const txRes = await db.from("transcripts").select("body").eq("call_id", call.id).maybeSingle();
  const transcript = txRes.data?.body ?? "";

  const framework = deal.framework_id ? await loadFramework(tenantId, deal.framework_id) : null;
  const extraction = (await getDealExtraction(deal.id)) as unknown as ExtractionMap;

  let nextAction = "";
  if (framework && transcript) {
    const summary = await generatePostCallSummary({
      account: deal.account,
      stageKey: deal.stage_key,
      closeDate: deal.rep_forecast_close_date ?? undefined,
      framework,
      extraction,
      gapExtraction: extraction,
      transcript,
    });
    nextAction = summary.nextStepCommitment ?? summary.suggestedNextStep ?? "";
  }

  console.log(`\nDeal:        ${deal.account} (${dealExt})`);
  console.log(`Rolldog:     ${linked ? `linked -> opp ${opp}` : "NOT linked (write would be skipped)"}`);
  console.log(`Latest call: ${call.id}  ${call.scheduled_start}`);
  console.log(`Next step:   ${nextAction || "(none generated)"}`);
  console.log(`Mode:        ${apply ? "APPLY (live write)" : "DRY (nothing written)"}`);

  if (!linked) {
    console.log(`\nDeal is not Rolldog-linked, so nothing would be written. Stopping.`);
    return;
  }
  if (!nextAction) {
    console.log(`\nNo next step generated, so there is nothing to write. Stopping.`);
    return;
  }
  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to write this next step (and refresh notes) to Rolldog.`);
    return;
  }

  const wb = await writeBackDealToRolldog("magaya", dealExt, { nextAction, callId: call.id });
  if (wb.written) {
    console.log(`\nWrote to opp ${wb.opportunityId}.`);
    for (const r of wb.results ?? []) console.log(`  ${r.method}: ${r.status}${r.fieldsWritten.length ? ` (${r.fieldsWritten.join(", ")})` : ""}`);
  } else {
    console.log(`\nWrite skipped: ${wb.reason}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
