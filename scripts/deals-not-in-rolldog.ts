/**
 * Lists deals DealRipe is tracking that do NOT resolve to a Rolldog opportunity,
 * grouped by rep. Use it to reconcile deals that live in Salesforce but not
 * Rolldog (so DealRipe can't write back to them yet).
 *
 * Runs on your Mac (reads Supabase/Rolldog). Sends nothing.
 *
 *   npx tsx scripts/deals-not-in-rolldog.ts             # all reps
 *   npx tsx scripts/deals-not-in-rolldog.ts --rep juan  # just Juan
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getPipelineChanges } from "../lib/pipeline-changes";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const repFilter = (arg("--rep") ?? "").toLowerCase();
  const tenantId = await resolveTenantId("magaya");
  // Wide window so we catch every tracked deal, not just this week's activity.
  const pc = await getPipelineChanges(tenantId, {
    sinceIso: new Date(Date.now() - 180 * 86_400_000).toISOString(),
    untilIso: new Date().toISOString(),
  });

  const notInRolldog = pc.deals.filter((d) => {
    if (d.inRolldog) return false;
    if (!repFilter) return true;
    return (d.repEmail ?? "").toLowerCase().includes(repFilter) || d.repName.toLowerCase().includes(repFilter);
  });

  if (notInRolldog.length === 0) {
    console.log(`\nEvery tracked deal${repFilter ? ` for "${repFilter}"` : ""} resolves to a Rolldog opportunity.\n`);
    return;
  }

  // Group by rep for a clean read.
  const byRep = new Map<string, typeof notInRolldog>();
  for (const d of notInRolldog) {
    const key = d.repName || "Unknown rep";
    (byRep.get(key) ?? byRep.set(key, []).get(key)!).push(d);
  }

  console.log(`\nDeals tracked by DealRipe but NOT in Rolldog${repFilter ? ` (rep: ${repFilter})` : ""}: ${notInRolldog.length}\n`);
  for (const [rep, deals] of byRep) {
    console.log(`${rep} (${deals.length}):`);
    for (const d of deals) {
      const last = d.lastConversationAt ? new Date(d.lastConversationAt).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "no call yet";
      console.log(`  - ${d.account}  [last call: ${last}]  dealId=${d.dealId}${d.isNoShow ? "  (no-show)" : ""}`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
