/**
 * Probes and fixes the existing-systems field shape in Rolldog. For each matched
 * deal that has a non-empty existing-systems string (one DealRipe wrote as a
 * scalar), it re-writes the SAME text as a one-element array (the field's native
 * type) and reads the value back, printing the before/after shape. Non-destructive:
 * the text is unchanged, only the type is corrected. Touches only the
 * existing-systems attribute, no other situation field.
 *
 * Runs on your Mac (reads + writes Rolldog). --dry to preview matches without writing.
 *
 *   npx tsx scripts/rolldog-existing-systems-fix.ts --account "Air Americas"
 *   npx tsx scripts/rolldog-existing-systems-fix.ts --rep juan
 *   npx tsx scripts/rolldog-existing-systems-fix.ts --rep juan --dry
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { repName } from "../lib/display-names";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { getSubResource, writeSituation } from "../lib/rolldog";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}
function shape(val: unknown): string {
  if (val === null || val === undefined) return "(empty)";
  if (Array.isArray(val)) return `array[${val.length}] ${JSON.stringify(val)}`;
  if (typeof val === "string") return `string ${JSON.stringify(val)}`;
  return `${typeof val} ${JSON.stringify(val)}`;
}

async function main(): Promise<void> {
  const account = arg("--account");
  const rep = (arg("--rep") ?? "").toLowerCase();
  const dry = has("--dry");
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
    if (!opp) continue;
    const before = await getSubResource(String(opp), "situation");
    const cur = before?.attributes?.["existing-systems"];
    // Only act on scalar strings DealRipe wrote (skip empties and already-arrays).
    if (typeof cur !== "string" || cur.trim().length === 0) continue;

    console.log(`\n=== ${d.account} (opp ${opp}) ===`);
    console.log(`  before: ${shape(cur)}`);
    if (dry) {
      console.log(`  would write: ${shape([cur])}`);
      continue;
    }
    await writeSituation(String(opp), { existingSystems: [cur] });
    const after = await getSubResource(String(opp), "situation");
    console.log(`  after:  ${shape(after?.attributes?.["existing-systems"])}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
