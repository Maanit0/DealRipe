/**
 * Backfill rep_email on the seeded pilot deals that were created without one.
 * Auto-created deals already get the rep from the calendar they appeared on;
 * the seeded deals only recorded the rep in their notes. This sets rep_email
 * from the known seed mapping so the digest and recaps can name the rep.
 *
 * Only fills rows where rep_email IS NULL, never overwrites an existing value.
 * Safe by default: previews unless you pass --apply.
 *
 *   npx tsx scripts/backfill-rep-emails.ts            # preview
 *   npx tsx scripts/backfill-rep-emails.ts --apply    # write
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

// external_id -> rep email, taken from scripts/seed-magaya-deals.ts rep_notes.
const REP_BY_DEAL: Record<string, string> = {
  morneau: "ebencomo@magaya.com",
  alba: "ebencomo@magaya.com",
  martinbrower: "jlopez@magaya.com",
  omniva: "jlopez@magaya.com",
  iff: "ebencomo@magaya.com",
  norwegian: "ebencomo@magaya.com",
  dutyfreeamericas: "ebencomo@magaya.com",
  seino: "ebencomo@magaya.com",
  capito: "jlopez@magaya.com",
  cltair: "jlopez@magaya.com",
};

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const res = await db
    .from("deals")
    .select("id, external_id, account, rep_email")
    .eq("tenant_id", tenantId)
    .in("external_id", Object.keys(REP_BY_DEAL));
  if (res.error) throw new Error(res.error.message);

  let planned = 0;
  for (const d of res.data ?? []) {
    const want = REP_BY_DEAL[d.external_id ?? ""];
    if (!want) continue;
    if (d.rep_email) {
      console.log(`  skip  ${d.account}  (already ${d.rep_email})`);
      continue;
    }
    planned += 1;
    console.log(`  set   ${d.account}  ->  ${want}`);
    if (apply) {
      const upd = await db.from("deals").update({ rep_email: want }).eq("id", d.id);
      if (upd.error) throw new Error(`update ${d.external_id} failed: ${upd.error.message}`);
    }
  }

  console.log(`\n${planned} deal(s) ${apply ? "updated" : "to update"}.`);
  if (!apply && planned > 0) console.log("Re-run with --apply to write.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
