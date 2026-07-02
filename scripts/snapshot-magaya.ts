/**
 * Write a daily signal snapshot for every Magaya pilot deal. Run nightly
 * (cron) so the digest has week-over-week history to diff. Idempotent: one
 * snapshot per deal per calendar day (re-running today overwrites today).
 *
 *   npx tsx scripts/snapshot-magaya.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getFrameworkForDeal } from "../lib/framework";
import { recordDealSnapshot } from "../lib/snapshot";
import { getDealsForTenant } from "../lib/supabase-queries";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const deals = await getDealsForTenant(tenantId);
  if (deals.length === 0) {
    console.log("No Magaya deals to snapshot yet.");
    return;
  }

  let written = 0;
  for (const deal of deals) {
    const framework = await getFrameworkForDeal(deal.id);
    if (!framework) {
      console.warn(`  skip ${deal.account}: no framework`);
      continue;
    }
    await recordDealSnapshot(tenantId, deal, framework);
    written += 1;
    console.log(`  snapshot: ${deal.account} (${deal.stageKey})`);
  }
  console.log(`snapshot-magaya complete: ${written} deal(s).`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
