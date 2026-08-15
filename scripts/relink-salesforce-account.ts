/**
 * Point a deal at the correct Salesforce account.
 *
 * Dunavant was matched to 0013j000031vT62AAE, an account with no activity from
 * anyone, while the account the rep actually works is 001RN00000mDzS9YAK. Every
 * write would have landed somewhere nobody looks, and nothing would have thrown.
 * That is the failure mode this codebase is built around: silence read as
 * success.
 *
 * So this verifies the target before writing it. It reads the account from
 * Salesforce and prints the name, owner and record type, and refuses if the id
 * does not resolve. A relink to a second wrong account is not an improvement.
 *
 * Read-only without --apply.
 *
 *   npx tsx scripts/relink-salesforce-account.ts --deal Dunavant --account 001RN00000mDzS9YAK
 *   npx tsx scripts/relink-salesforce-account.ts --deal Dunavant --account 001RN00000mDzS9YAK --apply
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
  const dealName = arg("--deal");
  const accountId = arg("--account");
  const apply = process.argv.includes("--apply");
  if (!dealName || !accountId) {
    console.log("\nPass --deal <name fragment> --account <Salesforce account id>.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const res = await db
    .from("deals")
    .select("id, account, rep_email, salesforce_account_id")
    .eq("tenant_id", tenantId);
  if (res.error) throw new Error(res.error.message);

  const matches = (res.data ?? []).filter((d) =>
    String(d.account ?? "").toLowerCase().includes(dealName.toLowerCase()),
  ) as Array<{ id: string; account: string; rep_email: string | null; salesforce_account_id: string | null }>;

  if (matches.length === 0) {
    console.log(`\nNo deal matched "${dealName}".\n`);
    return;
  }
  if (matches.length > 1) {
    console.log(`\n"${dealName}" matched ${matches.length} deals. Narrow it:\n`);
    for (const m of matches) console.log(`  ${m.account}  (${m.rep_email ?? "no rep"})`);
    console.log("");
    return;
  }
  const deal = matches[0];

  // Verify the target exists before pointing anything at it.
  const { token, instanceUrl } = await getSalesforceClient();
  const r = await fetch(
    `${instanceUrl}/services/data/${API}/sobjects/Account/${accountId}?fields=Id,Name,OwnerId,Type`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!r.ok) {
    console.log(`\nSalesforce would not return ${accountId} (${r.status}).`);
    console.log(`That is "could not verify", not "does not exist". Nothing was changed.\n`);
    return;
  }
  const acct = (await r.json()) as { Id: string; Name: string; OwnerId: string; Type?: string };

  console.log(`\n${deal.account}`);
  console.log(`  currently  ${deal.salesforce_account_id ?? "not linked"}`);
  console.log(`  target     ${acct.Id}  ${acct.Name}${acct.Type ? `  (${acct.Type})` : ""}`);

  if (deal.salesforce_account_id === accountId) {
    console.log(`\n  Already pointed here. Nothing to do.\n`);
    return;
  }

  if (!apply) {
    console.log(`\n  Dry run. Add --apply to write it.\n`);
    return;
  }

  // See the note in match-accounts.ts. The id alone leaves the deal linked and
  // unwritable, because resolveSalesforceWriteTarget fails closed below
  // 'confirmed'. A human supplying the id is the evidence that earns it.
  const upd = await db
    .from("deals")
    .update({ salesforce_account_id: accountId, salesforce_link_confidence: "confirmed" })
    .eq("id", deal.id);
  if (upd.error) throw new Error(upd.error.message);
  console.log(`\n  Relinked, confidence 'confirmed' (a person supplied this id).`);
  console.log(`  Now backfill the calls so the account shows its history:`);
  console.log(`    npx tsx scripts/log-salesforce-calls.ts --deal "${deal.account}" --apply\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
