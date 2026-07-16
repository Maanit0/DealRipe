/**
 * Repoint auto-created deals onto the tenant's real framework (Magaya Rolldog),
 * fixing the deals that were created against the wrong framework (SCOTSMAN) by
 * the old ensureAutoDeal .limit(1) bug. Also clears each fixed deal's stale
 * field_extractions, which were keyed to SCOTSMAN field keys and are
 * meaningless under the correct framework, so the deal re-extracts cleanly on
 * its next call.
 *
 *   npx tsx scripts/fix-auto-frameworks.ts            # dry run (default)
 *   npx tsx scripts/fix-auto-frameworks.ts --apply    # make the changes
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  // The correct framework: the tenant's Rolldog Stage Gates.
  const rolldog = await db
    .from("qualification_frameworks")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .eq("source", "rolldog")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (rolldog.error || !rolldog.data) {
    console.error("No 'rolldog' framework found for the magaya tenant. Aborting.");
    process.exit(1);
  }
  const correctId = rolldog.data.id;
  console.log(`Correct framework: "${rolldog.data.name}" (${correctId})\n`);

  // Auto deals not already on the correct framework.
  const deals = await db
    .from("deals")
    .select("id, external_id, account, framework_id")
    .eq("tenant_id", tenantId)
    .like("external_id", "auto:%");
  if (deals.error) {
    console.error(deals.error.message);
    process.exit(1);
  }
  const wrong = (deals.data ?? []).filter((d) => d.framework_id !== correctId);
  if (wrong.length === 0) {
    console.log("All auto deals are already on the correct framework. Nothing to do.");
    return;
  }

  console.log(`${wrong.length} auto deal(s) to fix:`);
  for (const d of wrong) {
    console.log(`  ${String(d.external_id).padEnd(28)} "${d.account}"  framework ${d.framework_id ?? "(none)"} -> ${correctId}`);
  }
  console.log("");

  if (!apply) {
    console.log("Dry run. Re-run with --apply to repoint the framework and clear stale extractions.");
    return;
  }

  for (const d of wrong) {
    const upd = await db.from("deals").update({ framework_id: correctId }).eq("id", d.id);
    if (upd.error) {
      console.error(`  ${d.external_id}: framework update failed: ${upd.error.message}`);
      continue;
    }
    const del = await db.from("field_extractions").delete().eq("deal_id", d.id);
    if (del.error) {
      console.error(`  ${d.external_id}: framework repointed but extraction clear failed: ${del.error.message}`);
      continue;
    }
    console.log(`  ${d.external_id}: repointed + cleared stale extraction.`);
  }
  console.log("\nDone. Auto deals now qualify on the Magaya Rolldog framework.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
