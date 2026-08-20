/**
 * How many deals are attributed to a rep who does not own the account?
 *
 * Eduardo Bencomo raised this himself on 2026-08-19: "some accounts are no
 * longer under my name. The meeting might be in my calendar because I'm
 * invited to, or sometimes customers just decide to send me an invite out of
 * the blue, like Starwood."
 *
 * DealRipe attributes a deal to the rep whose calendar carried the meeting, so
 * every one of those lands under the wrong rep in the weekly digest, in per-rep
 * calibration, and in write-back. This measures how many before anything
 * changes behaviour, because a fix sized by anecdote is a fix sized wrong.
 *
 * Imports resolveDealOwnership rather than restating the comparison. A checker
 * that can disagree with the code it checks will, and it will do so
 * confidently.
 *
 *   npx tsx scripts/deal-ownership-report.ts
 *   npx tsx scripts/deal-ownership-report.ts --rep ebencomo@magaya.com
 *
 * READ ONLY. Writes nothing, to Supabase or to Salesforce.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { resolveDealOwnership, type OwnershipStatus } from "../lib/deal-ownership";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Ordered so the two that need action print first. */
const ORDER: OwnershipStatus[] = [
  "owned_by_other_ae",
  "owned_by_integration",
  "owner_role_unknown",
  "rep_not_in_salesforce",
  "owned_by_bdr",
  "owner",
  "unconfirmed_link",
  "no_account",
  "no_rep",
  "unavailable",
];

const EXPLAIN: Record<OwnershipStatus, string> = {
  owned_by_other_ae: "ACTION: owned by a different seller, not the rep on the call",
  owned_by_integration: "owned by an integration user, so no human is the seller of record",
  owner_role_unknown: "owner's role could not be read, so this is undecidable",
  rep_not_in_salesforce: "rep matches no active Salesforce user, so we could not compare",
  owned_by_bdr: "owned by the BDR who sourced it, which is the normal motion",
  owner: "calendar rep owns the account",
  unconfirmed_link: "link below 'confirmed', so the account may not be this deal's",
  no_account: "no Salesforce account linked",
  no_rep: "deal carries no rep email",
  unavailable: "could not check",
};

async function main(): Promise<void> {
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const only = arg("--rep")?.toLowerCase();

  const res = await db
    .from("deals")
    .select("id, account, rep_email")
    .eq("tenant_id", tenantId);
  if (res.error) throw new Error(`deals read failed: ${res.error.message}`);

  let deals = (res.data ?? []) as Array<{ id: string; account: string; rep_email: string | null }>;
  if (only) deals = deals.filter((d) => (d.rep_email ?? "").toLowerCase() === only);
  if (deals.length === 0) {
    console.log(`\nNo deals${only ? ` for ${only}` : ""}.\n`);
    return;
  }

  const byDeal = await resolveDealOwnership(
    tenantId,
    deals.map((d) => d.id),
  );
  const name = new Map(deals.map((d) => [d.id, d.account]));

  const counts = new Map<OwnershipStatus, number>();
  for (const o of byDeal.values()) counts.set(o.status, (counts.get(o.status) ?? 0) + 1);

  console.log(`\n${"=".repeat(78)}`);
  console.log(`DEAL OWNERSHIP, ${TENANT_SLUG}${only ? `, ${only}` : ""}: ${deals.length} deal(s)`);
  console.log(`${"=".repeat(78)}\n`);

  for (const status of ORDER) {
    const n = counts.get(status) ?? 0;
    if (n === 0) continue;
    console.log(`  ${String(n).padStart(4)}  ${status.padEnd(22)} ${EXPLAIN[status]}`);
  }

  const wrong = [...byDeal.values()].filter((o) => o.status === "owned_by_other_ae");
  if (wrong.length > 0) {
    console.log(`\n${"-".repeat(78)}`);
    console.log(`OWNED BY A DIFFERENT SELLER (${wrong.length})`);
    console.log(`These appear under the calendar rep in the weekly digest and in per-rep`);
    console.log(`calibration, while Salesforce records a different AE or manager as the`);
    console.log(`seller. BDR-owned accounts are excluded: a BDR sourcing and an AE closing`);
    console.log(`is Magaya's normal motion, not a misattribution.`);
    console.log(`${"-".repeat(78)}\n`);

    // Grouped by the rep they currently sit under, since that is how the
    // digest reports and therefore how the error is seen.
    const byRep = new Map<string, typeof wrong>();
    for (const o of wrong) {
      const k = o.repEmail ?? "(no rep)";
      (byRep.get(k) ?? byRep.set(k, []).get(k)!).push(o);
    }
    for (const [rep, list] of [...byRep.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${rep}  (${list.length})`);
      for (const o of list.sort((a, b) => (name.get(a.dealId) ?? "").localeCompare(name.get(b.dealId) ?? ""))) {
        console.log(`     ${(name.get(o.dealId) ?? o.dealId).padEnd(30)} owned by ${o.ownerName ?? o.ownerEmail} (${o.ownerRole})`);
      }
      console.log("");
    }
  }

  console.log(`${"=".repeat(78)}`);
  console.log(`Nothing here changes attribution. It measures it.`);
  console.log(`${"=".repeat(78)}\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
