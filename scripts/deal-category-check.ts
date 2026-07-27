/**
 * Confirm a deal's forecast category across sources: LIVE Rolldog vs the last few
 * daily snapshots. Explains why the Deals dashboard (live) can differ from the
 * digest / pipeline-changes (latest snapshot) after a rep changes the category.
 *
 *   npx tsx scripts/deal-category-check.ts IFF
 *   npx tsx scripts/deal-category-check.ts "Alba Wheels"
 *
 * Runs on your Mac with .env.local (needs Rolldog + Supabase access).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { getRolldogSummary } from "../lib/rolldog-summary";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const account = process.argv[2] ?? "IFF";
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id")
    .eq("tenant_id", tenantId)
    .ilike("account", `%${account}%`);
  const deals = (dealsRes.data ?? []) as Array<{ id: string; account: string; external_id: string | null; rolldog_opportunity_id: string | null }>;
  if (deals.length === 0) {
    console.log(`No magaya deal matching "${account}".`);
    return;
  }

  for (const d of deals) {
    const opp = (d.external_id ? rolldogOppIdForDeal(d.external_id) : null) ?? d.rolldog_opportunity_id;
    console.log(`\n=== ${d.account}  (deal ${d.id}, opp ${opp ?? "none"}) ===`);

    if (opp) {
      try {
        const sum = (await getRolldogSummary(String(opp))) as Record<string, unknown> | null;
        console.log(
          `  LIVE Rolldog:  category=${String(sum?.forecastCategory ?? "?")}  score=${String(sum?.score ?? "?")}  stage=${String(sum?.stageName ?? "?")}`,
        );
      } catch (e) {
        console.log(`  LIVE Rolldog read failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      console.log("  LIVE Rolldog:  (no opportunity id — not in Rolldog)");
    }

    const snap = await db
      .from("deal_signal_snapshots")
      .select("snapshot_date, signals")
      .eq("deal_id", d.id)
      .order("snapshot_date", { ascending: false })
      .limit(4);
    const rows = (snap.data ?? []) as Array<{ snapshot_date: string; signals: unknown }>;
    if (rows.length === 0) {
      console.log("  SNAPSHOTS:     none recorded yet (the snapshot cron has not run on this deal)");
    }
    for (const s of rows) {
      const sig = s.signals as { forecastCategory?: string | null; rolldog?: { forecastCategory?: string | null } } | null;
      const cat = sig?.rolldog?.forecastCategory ?? sig?.forecastCategory ?? "?";
      console.log(`  SNAPSHOT ${s.snapshot_date}:  category=${cat}`);
    }
  }
  console.log(
    `\nIf LIVE differs from the newest SNAPSHOT, the rep changed the category after the last snapshot ran.\nThe digest/pipeline-changes will catch up (and flag the move) once the snapshot cron runs again.`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
