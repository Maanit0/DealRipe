/**
 * For each Magaya deal, shows which framework it resolves to via
 * getFrameworkForDeal (the per-deal path the snapshot cron, forecast, and
 * briefings use). Flags any deal that falls back to the stale tenant-default
 * "SCOTSMAN" framework, since its snapshot gate-completion would then be
 * computed against fields that don't match the deal's gates.
 *
 * Runs on your Mac (reads Supabase). Sends nothing.
 *
 *   npx tsx scripts/deal-framework-check.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getFrameworkForDeal } from "../lib/framework";
import { getDealsForTenant } from "../lib/supabase-queries";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const deals = await getDealsForTenant(tenantId);
  console.log(`\n${deals.length} Magaya deals\n`);

  let scotsman = 0;
  let sqlish = 0;
  let none = 0;
  for (const deal of deals) {
    const fw = await getFrameworkForDeal(deal.id).catch(() => null);
    if (!fw) {
      none += 1;
      console.log(`  ${deal.account}: NO framework resolved`);
      continue;
    }
    // Heuristic: SCOTSMAN uses abbreviated keys (Sc1, C1, T1); the real Magaya
    // framework uses semantic keys (budget..., why_looking, sql2_...).
    const semantic = fw.fields.some((f) => /budget|why_looking|sql\d|decision|compet/i.test(f.fieldKey));
    if (fw.name.toLowerCase().includes("scotsman") || !semantic) {
      scotsman += 1;
      console.log(`  ${deal.account}: "${fw.name}" (${fw.fields.length} fields, keys: ${fw.fields.slice(0, 4).map((f) => f.fieldKey).join(", ")}) <-- STALE?`);
    } else {
      sqlish += 1;
    }
  }
  console.log(`\nsemantic/SQL framework: ${sqlish} · SCOTSMAN/stale: ${scotsman} · none: ${none}`);
  console.log(scotsman + none === 0 ? "\nAll deals resolve to the correct framework. Snapshot path is safe." : "\nSome deals resolve to the stale/none framework — their snapshot gate-completion will be empty.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
