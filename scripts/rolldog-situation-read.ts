/**
 * Reads the actual Situation sub-resource from Rolldog for one or more deals and
 * prints the raw attributes exactly as Rolldog stores them. Use it to confirm
 * that DealRipe's writes landed as separate clean fields (why-looking,
 * existing-systems, ...) and NOT as a JSON blob, and to check the type Rolldog
 * returns for existing-systems (string vs array).
 *
 * Runs on your Mac (reads Rolldog + Supabase). Read-only, writes nothing.
 *
 *   npx tsx scripts/rolldog-situation-read.ts --account "Air Americas"
 *   npx tsx scripts/rolldog-situation-read.ts --rep juan
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { repName } from "../lib/display-names";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { getSubResource } from "../lib/rolldog";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function describe(val: unknown): string {
  if (val === null || val === undefined) return "(empty)";
  if (Array.isArray(val)) return `array[${val.length}] ${JSON.stringify(val)}`;
  if (typeof val === "string") return `string "${val}"`;
  return `${typeof val} ${JSON.stringify(val)}`;
}

async function main(): Promise<void> {
  const account = arg("--account");
  const rep = (arg("--rep") ?? "").toLowerCase();
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const { data } = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rep_email")
    .eq("tenant_id", tenantId);
  let deals = (data ?? []) as Array<{
    id: string;
    account: string;
    external_id: string | null;
    rolldog_opportunity_id: string | null;
    rep_email: string | null;
  }>;
  // Space- and case-insensitive account match ("Air Americas" == "Airamericas").
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (account) {
    const target = norm(account);
    deals = deals.filter((d) => norm(d.account).includes(target));
  }
  if (rep) {
    deals = deals.filter(
      (d) => (d.rep_email ?? "").toLowerCase().includes(rep) || repName(d.rep_email).toLowerCase().includes(rep),
    );
  }

  if (deals.length === 0) {
    console.log(`\nNo matching deals.\n`);
    return;
  }

  for (const d of deals) {
    const opp = (d.external_id ? rolldogOppIdForDeal(d.external_id) : null) ?? d.rolldog_opportunity_id;
    console.log(`\n=== ${d.account} ===`);
    if (!opp) {
      console.log("  Not linked to a Rolldog opportunity (nothing to read).");
      continue;
    }
    try {
      const sit = await getSubResource(String(opp), "situation");
      if (!sit) {
        console.log(`  opp ${opp}: no Situation sub-resource yet.`);
        continue;
      }
      console.log(`  opp ${opp}  (situation id ${sit.id})`);
      for (const [k, v] of Object.entries(sit.attributes)) {
        console.log(`    ${k}: ${describe(v)}`);
      }
    } catch (e) {
      console.log(`  opp ${opp}: read failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
