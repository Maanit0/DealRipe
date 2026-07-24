/**
 * Read-only preview of deal -> Rolldog opportunity auto-linking. For every deal
 * DealRipe tracks that is NOT yet linked to a Rolldog opportunity (Salesforce-only
 * discovery deals), it runs the matcher and prints the proposed match and its
 * confidence. Nothing is linked and nothing is written, this is the eyeball pass
 * before we turn on auto-link + backfill.
 *
 * Runs on your Mac (Supabase + Rolldog search). Writes nothing.
 *
 *   npx tsx scripts/rolldog-link-preview.ts
 *   npx tsx scripts/rolldog-link-preview.ts --rep juan
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { repName } from "../lib/display-names";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { matchDealToOpportunity } from "../lib/rolldog-match";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function d(iso: string | null): string {
  if (!iso) return "?";
  try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch { return "?"; }
}

async function main(): Promise<void> {
  const rep = (arg("--rep") ?? "").toLowerCase();
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const { data } = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence, rep_email")
    .eq("tenant_id", tenantId);
  let deals = (data ?? []) as Array<{
    id: string; account: string; external_id: string | null;
    rolldog_opportunity_id: string | null; rolldog_link_confidence: string | null; rep_email: string | null;
  }>;
  if (rep) {
    deals = deals.filter((x) => (x.rep_email ?? "").toLowerCase().includes(rep) || repName(x.rep_email).toLowerCase().includes(rep));
  }

  // Unlinked = no static pilot mapping AND no stored opportunity id.
  const unlinked = deals.filter((x) => {
    const staticOpp = x.external_id ? rolldogOppIdForDeal(x.external_id) : null;
    return !staticOpp && !x.rolldog_opportunity_id;
  });

  if (unlinked.length === 0) {
    console.log(`\nEvery tracked deal${rep ? ` for "${rep}"` : ""} is already linked to a Rolldog opportunity.\n`);
    return;
  }

  console.log(`\nUnlinked deals to check: ${unlinked.length}\n`);
  let confirmed = 0, review = 0, none = 0;

  for (const x of unlinked) {
    const m = await matchDealToOpportunity({ account: x.account, externalId: x.external_id });
    if (m.status === "confirmed") {
      confirmed++;
      console.log(`✓ CONFIRMED  ${x.account}`);
      console.log(`    -> opp ${m.opp.id}  "${m.opp.accountName || m.opp.name}"  stage=${m.opp.stageName ?? "?"}  created=${d(m.opp.createdAt)}  sf-id=${m.opp.externalId ?? "—"}`);
    } else if (m.status === "review") {
      review++;
      console.log(`? REVIEW     ${x.account}  (${m.reason})`);
      for (const c of m.candidates) {
        console.log(`    candidate opp ${c.id}  "${c.accountName || c.name}"  stage=${c.stageName ?? "?"}  created=${d(c.createdAt)}`);
      }
    } else {
      none++;
      console.log(`·  no match   ${x.account}  (not in Rolldog yet)`);
    }
    console.log("");
  }

  console.log(`Summary: ${confirmed} confirmed, ${review} need review, ${none} no match yet.`);
  console.log(`(Nothing was linked or written. Confirmed matches are the ones safe to auto-link next.)\n`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
