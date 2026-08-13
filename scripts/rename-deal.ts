/**
 * Give a deal the customer's real name.
 *
 * Deal names are derived, and the derivation is often wrong. accountFromSubject
 * takes the tail after the last separator, so "Magaya Call - LUMISTAR -
 * 08/13/2026 9:30 PM Korea" became "Korea" and "Magaya Call - Logistics Plus -
 * 08/14..." became "Pakistan". A free-mail address with a generic subject gives
 * "Aileenrer" for a company called Green Java. Reps do not recognise their own
 * deals under these names, which is how a simple question turns into three
 * emails.
 *
 * The name matters beyond display: it is a search term. Every Rolldog and
 * Salesforce lookup starts from it, so a wrong name is a lookup that cannot
 * succeed.
 *
 * Only `account` changes. external_id stays as it is, because that is the key
 * calendar-sync matches future meetings on, and rewriting it would orphan the
 * deal from its own calendar.
 *
 *   npx tsx scripts/rename-deal.ts --deal Pakistan --to "Logistics Plus"
 *   npx tsx scripts/rename-deal.ts --deal Pakistan --to "Logistics Plus" --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const from = arg("--deal");
  const to = arg("--to");
  const apply = process.argv.includes("--apply");
  if (!from || !to) {
    console.log(`\nUsage: --deal <current name or external_id> --to "<real name>" [--apply]\n`);
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const res = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, salesforce_account_id")
    .eq("tenant_id", tenantId);
  if (res.error) throw new Error(res.error.message);

  const rows = (res.data ?? []) as Array<Record<string, unknown>>;
  const needle = from.trim().toLowerCase();
  const exact = rows.filter((d) => String(d.external_id ?? "").toLowerCase() === needle);
  const byName = rows.filter((d) => String(d.account ?? "").toLowerCase().includes(needle));
  const hits = exact.length > 0 ? exact : byName;

  if (hits.length === 0) {
    console.log(`\nNo deal matching "${from}".\n`);
    process.exit(1);
  }
  if (hits.length > 1) {
    console.log(`\n"${from}" matches ${hits.length} deals. Use the external_id:`);
    for (const h of hits) console.log(`  ${h.account}  ${h.external_id}`);
    console.log("");
    process.exit(1);
  }

  const d = hits[0];
  console.log("");
  console.log(`  ${d.account}  ->  ${to}`);
  console.log(`  external_id ${d.external_id} (unchanged)`);
  if (d.rolldog_opportunity_id) console.log(`  rolldog opp ${d.rolldog_opportunity_id} (unchanged)`);
  if (d.salesforce_account_id) console.log(`  salesforce ${d.salesforce_account_id} (unchanged)`);

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply.\n`);
    return;
  }
  const upd = await db.from("deals").update({ account: to } as never).eq("id", String(d.id));
  console.log(upd.error ? `\n  FAILED: ${upd.error.message}\n` : `\n  renamed\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
