/**
 * List the deals currently in Supabase for the magaya tenant, so you can tell
 * whether the seed actually landed (vs a stale UI cache).
 *
 *   npx tsx scripts/list-magaya-deals.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const res = await supabaseAdmin()
    .from("deals")
    .select("external_id, account, stage_key")
    .eq("tenant_id", tenantId)
    .order("account", { ascending: true });
  if (res.error) {
    console.error(`query failed: ${res.error.message}`);
    process.exit(1);
  }
  const rows = res.data ?? [];
  console.log("");
  console.log(`magaya deals in DB: ${rows.length}`);
  for (const r of rows) {
    console.log(`  ${r.external_id}  |  ${r.account}  |  ${r.stage_key}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
