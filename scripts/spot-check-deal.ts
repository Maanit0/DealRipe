/**
 * Spot-check the stage divergence on one deal: what Rolldog actually shows vs
 * what DealRipe inferred from the calls, and which confirmed gates justify it.
 * Answers the two questions before we trust the digest's divergence flag:
 *   1. Does Rolldog really sit at the stage we read (or are we misreading it)?
 *   2. Are the calls really that far along, or is inferStageKey overshooting?
 *
 * Read-only. Live Rolldog read (runs on your Mac).
 *
 *   npx tsx scripts/spot-check-deal.ts --account "Core Logistics"
 *   npx tsx scripts/spot-check-deal.ts --deal <external_id>
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getFrameworkForDeal } from "../lib/framework";
import { readOpportunity } from "../lib/rolldog";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ext = arg("--deal");
  const account = arg("--account");
  if (!ext && !account) {
    console.error('Usage: --deal <external_id> | --account "<name>"');
    process.exit(1);
  }
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const pattern = account ? `%${account.trim().split(/\s+/).join("%")}%` : "";
  let q = db.from("deals").select("id, account, external_id, stage_key, rolldog_opportunity_id").eq("tenant_id", tenantId);
  q = ext ? q.eq("external_id", ext) : q.ilike("account", pattern);
  const res = await q.limit(5);
  const rows = (res.data ?? []) as Array<{ id: string; account: string; external_id: string | null; stage_key: string | null; rolldog_opportunity_id: string | null }>;
  if (rows.length === 0) { console.error("Deal not found."); process.exit(1); }
  if (rows.length > 1) { console.error(`Ambiguous (${rows.length}); use --deal:`); rows.forEach((r) => console.error(`  ${r.account} -> ${r.external_id}`)); process.exit(1); }
  const deal = rows[0];
  const opp = (deal.external_id ? rolldogOppIdForDeal(deal.external_id) : null) ?? deal.rolldog_opportunity_id;

  console.log(`\n=== ${deal.account} (${deal.external_id}) ===`);

  // --- 1. What Rolldog actually shows ---
  if (opp) {
    try {
      const core = await readOpportunity(String(opp), ["stage", "close_date", "amount"]);
      const g = (k: string) => core[k] ?? core[k.replace(/_/g, "-")] ?? "—";
      console.log(`\nROLLDOG (rep-entered):`);
      console.log(`  stage (numeric id) : ${g("stage")}`);
      console.log(`  stage-name         : ${g("stage-name")}`);
      console.log(`  current-stage-date : ${String(g("current-stage-date")).slice(0, 10)}`);
      console.log(`  percentage         : ${g("percentage")}`);
      console.log(`  forecast-category  : ${g("forecast-category")}`);
      console.log(`  deal-size (monthly): ${g("deal-size")}`);
      console.log(`  score              : ${g("score")}`);
      console.log(`  status             : ${g("status")}  reason: ${g("status-reason")}`);
      console.log(`  created-at         : ${String(g("created-at")).slice(0, 10)}`);
    } catch (err) {
      console.log(`  Rolldog read failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log(`\nROLLDOG: not linked (no opportunity id).`);
  }

  // --- 2. What DealRipe inferred + which gates justify it ---
  const snap = await db
    .from("deal_signal_snapshots")
    .select("snapshot_date, signals")
    .eq("deal_id", deal.id)
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  const inferred = (snap.data?.signals as { stage?: string } | undefined)?.stage ?? "—";

  const fx = await db.from("field_extractions").select("framework_field_key, status").eq("deal_id", deal.id).eq("status", "Yes");
  const confirmed = new Set(((fx.data ?? []) as Array<{ framework_field_key: string }>).map((r) => r.framework_field_key));

  console.log(`\nDEALRIPE (from calls):`);
  console.log(`  deal.stage_key     : ${deal.stage_key ?? "—"}`);
  console.log(`  inferred stage     : ${inferred}   (this is what the digest compares to Rolldog)`);
  console.log(`  gates confirmed    : ${confirmed.size}`);

  // Group confirmed gates by the SQL stage they belong to, so you can see
  // whether the evidence really supports the inferred stage.
  try {
    const fw = await getFrameworkForDeal(deal.id);
    if (fw) {
      const byStage = new Map<string, string[]>();
      for (const f of fw.fields) {
        if (!confirmed.has(f.fieldKey)) continue;
        const sk = f.stageKey ?? "unstaged";
        const list = byStage.get(sk) ?? [];
        list.push(f.fieldKey);
        byStage.set(sk, list);
      }
      console.log(`  confirmed gates by stage:`);
      for (const sk of Array.from(byStage.keys()).sort()) {
        console.log(`    ${sk}: ${byStage.get(sk)!.length}  (${byStage.get(sk)!.join(", ")})`);
      }
    }
  } catch {
    /* framework load best-effort */
  }

  console.log(`\nRead: if Rolldog stage-name and DealRipe inferred stage match reality, the divergence is real.`);
  console.log(`If the inferred stage sits well above where the confirmed gates land, inferStageKey is overshooting.\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
