/**
 * Salesforce record links for deals, so a live call does not stall on someone
 * typing a name into a search bar.
 *
 * Prints the account link, and the links to any activities DealRipe has written
 * there, asked of Salesforce rather than assumed. A deal with no Salesforce
 * account prints as such rather than being skipped, because "not linked" and
 * "not in this list" are different things.
 *
 * READ ONLY.
 *
 *   npx tsx scripts/sf-link.ts --deal Medov
 *   npx tsx scripts/sf-link.ts --rep ebencomo
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSalesforceClient } from "../lib/salesforce";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const API = "v61.0";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const deal = (arg("--deal") ?? "").toLowerCase();
  const rep = (arg("--rep") ?? "").toLowerCase();
  if (!deal && !rep) {
    console.log("\nPass --deal <name fragment> or --rep <email fragment>.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const res = await db
    .from("deals")
    .select("account, rep_email, salesforce_account_id, rolldog_opportunity_id")
    .eq("tenant_id", tenantId);
  if (res.error) throw new Error(res.error.message);

  const rows = (res.data ?? []).filter((d) => {
    const a = String(d.account ?? "").toLowerCase();
    const r = String(d.rep_email ?? "").toLowerCase();
    return (deal && a.includes(deal)) || (rep && r.includes(rep));
  }) as Array<{
    account: string; rep_email: string | null;
    salesforce_account_id: string | null; rolldog_opportunity_id: string | null;
  }>;

  if (rows.length === 0) {
    console.log(`\nNo deal matched.\n`);
    return;
  }

  const { token, instanceUrl } = await getSalesforceClient();
  const base = instanceUrl.replace(/\/$/, "");

  for (const d of rows) {
    console.log(`\n${d.account}`);
    if (!d.salesforce_account_id) {
      console.log(`  no Salesforce account linked${d.rolldog_opportunity_id ? `; Rolldog opportunity ${d.rolldog_opportunity_id}` : ""}`);
      continue;
    }
    console.log(`  ${base}/lightning/r/Account/${d.salesforce_account_id}/view`);

    const soql =
      `SELECT Id, Subject, ActivityDate, Status FROM Task ` +
      `WHERE WhatId = '${d.salesforce_account_id}' ORDER BY CreatedDate DESC LIMIT 10`;
    const r = await fetch(`${base}/services/data/${API}/query?q=${encodeURIComponent(soql)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      console.log(`    (could not read activities: ${r.status}. That is not "none".)`);
      continue;
    }
    const recs = ((await r.json()) as {
      records?: Array<{ Id: string; Subject: string; ActivityDate: string; Status: string }>;
    }).records ?? [];
    if (recs.length === 0) {
      console.log(`    no activities on this account`);
      continue;
    }
    for (const t of recs) {
      console.log(`    ${t.Status === "Completed" ? "done" : "open"}  ${t.ActivityDate ?? "no date"}  ${t.Subject}`);
      console.log(`          ${base}/lightning/r/Task/${t.Id}/view`);
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
