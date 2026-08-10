/**
 * Rename consumer-mail deals from the meeting subject instead of the sender.
 *
 * Small brokers and forwarders genuinely run their businesses on Gmail, so
 * these are real prospects. What they are not is companies: keying the deal by
 * address is right, but NAMING it from the sender leaves Mark reading a weekly
 * digest of rows called "Manele Khoury" and "Lucianosolis99", which tell him
 * nothing about who Gezairi or Cummins are.
 *
 * The subject nearly always carries the real name, because reps title meetings
 * after the company. New deals pick this up automatically now; this fixes the
 * ones already in the database.
 *
 *   npx tsx scripts/rename-freemail-deals.ts
 *   npx tsx scripts/rename-freemail-deals.ts --apply
 *   npx tsx scripts/rename-freemail-deals.ts --deal auto:x@gmail.com --name "Gezairi" --apply
 *
 * Preview by default. Only ever renames; never touches the external_id, so
 * call history and CRM links are unaffected.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { accountFromSubject, isFreeMailDomain } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const onlyDeal = arg("--deal");
  const override = arg("--name");

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const deals = await db
    .from("deals")
    .select("id, external_id, account")
    .eq("tenant_id", tenantId)
    .like("external_id", "auto:%");
  if (deals.error) throw new Error(deals.error.message);

  const rows = (deals.data ?? []).filter((d) => {
    const tail = (d.external_id ?? "").slice("auto:".length);
    if (!tail.includes("@")) return false; // domain-keyed, already a company
    if (onlyDeal && d.external_id !== onlyDeal) return false;
    return isFreeMailDomain(tail.split("@")[1] ?? "");
  });

  console.log("");
  console.log(`Consumer-mail deals: ${rows.length}`);
  console.log("");

  let changed = 0;
  for (const d of rows) {
    // Titles from this deal's own meetings, newest first. A rep names the
    // meeting after the company, so the most recent title is the best source.
    const calls = await db
      .from("calls")
      .select("title, scheduled_start")
      .eq("tenant_id", tenantId)
      .eq("deal_id", d.id)
      .order("scheduled_start", { ascending: false })
      .limit(5);

    const titles = (calls.data ?? []).map((c) => c.title).filter((t): t is string => !!t);
    const proposed = override ?? titles.map((t) => accountFromSubject(t)).find((n): n is string => !!n) ?? null;

    if (!proposed) {
      console.log(`  ${(d.account ?? "").padEnd(24)}no usable subject on ${titles.length} call(s), leaving alone`);
      continue;
    }
    if (proposed.toLowerCase() === (d.account ?? "").toLowerCase()) continue;

    console.log(`  ${(d.account ?? "").padEnd(24)} -> ${proposed.padEnd(28)}from "${titles[0]?.slice(0, 44) ?? ""}"`);
    changed += 1;

    if (apply) {
      const upd = await db.from("deals").update({ account: proposed }).eq("id", d.id);
      if (upd.error) console.error(`     update failed: ${upd.error.message}`);
    }
  }

  console.log("");
  if (changed === 0) {
    console.log("Nothing to rename.");
  } else if (apply) {
    console.log(`${changed} deal(s) renamed. external_id untouched, so call history and CRM links are intact.`);
  } else {
    console.log(`${changed} deal(s) would be renamed. Check each line above, then re-run with --apply.`);
    console.log('Override a bad guess with --deal <external_id> --name "Real Name" --apply.');
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
