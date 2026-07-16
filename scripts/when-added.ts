/**
 * When each deal actually entered the live pilot (deals.created_at in the DB).
 * The definitive answer to "was IFF in the pilot on July 7 / July 9?" Read-only.
 *
 *   npx tsx scripts/when-added.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const rows = await supabaseAdmin()
    .from("deals")
    .select("external_id, account, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (rows.error) {
    console.error(rows.error.message);
    process.exit(1);
  }
  for (const d of rows.data ?? []) {
    console.log(`${d.created_at}  ${String(d.external_id).padEnd(24)} ${d.account}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
