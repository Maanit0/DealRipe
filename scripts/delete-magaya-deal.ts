/**
 * Delete a Magaya deal and all its child rows. Use to remove leftover test
 * deals so they don't pollute the pilot view or skew the scorecard.
 *
 *   npx tsx scripts/delete-magaya-deal.ts TEST_DEAL_1
 *   npx tsx scripts/delete-magaya-deal.ts demo-harbor-freight
 *
 * Arg is the deal's external_id. Defaults to TEST_DEAL_1.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const CHILD_TABLES = [
  "deal_signal_snapshots",
  "field_extractions",
  "calls",
  "contacts",
  "prescribed_actions",
  "briefing_runs",
  "extraction_runs",
];

async function main(): Promise<void> {
  const externalId = process.argv[2] ?? "TEST_DEAL_1";
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  const dealRes = await db
    .from("deals")
    .select("id, account")
    .eq("tenant_id", tenantId)
    .eq("external_id", externalId)
    .maybeSingle();
  if (dealRes.error) {
    console.error(`lookup failed: ${dealRes.error.message}`);
    process.exit(1);
  }
  if (!dealRes.data) {
    console.log(`No deal with external_id "${externalId}" for tenant magaya. Nothing to delete.`);
    return;
  }
  const dealId = dealRes.data.id;

  for (const tbl of CHILD_TABLES) {
    // Dynamic table name: the typed client can't infer the column, so cast.
    const del = await (db as unknown as {
      from: (t: string) => {
        delete: () => { eq: (c: string, v: string) => Promise<{ error: { message: string } | null }> };
      };
    })
      .from(tbl)
      .delete()
      .eq("deal_id", dealId);
    if (del.error) console.warn(`  warn deleting from ${tbl}: ${del.error.message}`);
  }
  const dealDel = await db.from("deals").delete().eq("id", dealId);
  if (dealDel.error) {
    console.error(`deal delete failed: ${dealDel.error.message}`);
    process.exit(1);
  }

  console.log(`Deleted deal "${dealRes.data.account}" (${externalId}) and its child rows.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
