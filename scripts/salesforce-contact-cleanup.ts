/**
 * Find and remove Contacts DealRipe created that should never have existed.
 *
 * On 2026-08-13 the contact write-back created records named after email
 * addresses: "BEary@tql.com", "jwelsch@Laufer.com", nineteen of them on TQL's
 * account alone. Outlook puts the address in the display name when an organiser
 * types one rather than picking a person, and the create path used it whole.
 * Salesforce requires LastName, so it accepted every one.
 *
 * The cause is fixed: realName() in lib/salesforce-contacts.ts now refuses
 * anything containing "@" or shorter than two words, and skips the create. This
 * removes what already landed.
 *
 * Only touches Contacts created by the integration user, which is the account
 * DealRipe authenticates as. A contact a Magaya rep created is never a candidate
 * no matter how it is named.
 *
 * Dry run by default.
 *
 *   npx tsx scripts/salesforce-contact-cleanup.ts
 *   npx tsx scripts/salesforce-contact-cleanup.ts --account 0013j00003ALbtWAAT
 *   npx tsx scripts/salesforce-contact-cleanup.ts --apply
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

/**
 * Is this record junk we made?
 *
 * Narrow on purpose. The only defect being cleaned up is a name that is an
 * email address, which no human would type into a Name field. A contact with a
 * thin but real name is left alone: deleting a record someone might be using is
 * worse than leaving one we created.
 */
function isJunkName(name: string | null, lastName: string | null): boolean {
  const n = (name ?? "").trim();
  const l = (lastName ?? "").trim();
  return n.includes("@") || l.includes("@");
}

async function main(): Promise<void> {
  const only = arg("--account");
  const apply = process.argv.includes("--apply");

  const { token, instanceUrl } = await getSalesforceClient();
  const auth = { authorization: `Bearer ${token}` };

  // Who we are, so "created by us" is asked rather than assumed.
  const me = await fetch(`${instanceUrl}/services/oauth2/userinfo`, { headers: auth });
  if (!me.ok) {
    console.log(`\nCould not identify the integration user (${me.status}). Refusing to delete anything.\n`);
    process.exit(1);
  }
  const userId = ((await me.json()) as { user_id?: string }).user_id ?? "";
  if (!userId) {
    console.log(`\nuserinfo returned no user_id. Refusing to delete anything.\n`);
    process.exit(1);
  }

  let accountIds: string[];
  if (only) {
    accountIds = [only];
  } else {
    const db = supabaseAdmin();
    const tenantId = await resolveTenantId("magaya");
    const res = await db
      .from("deals")
      .select("salesforce_account_id")
      .eq("tenant_id", tenantId)
      .not("salesforce_account_id", "is", null);
    accountIds = ((res.data ?? []) as Array<{ salesforce_account_id: string }>)
      .map((d) => d.salesforce_account_id)
      .filter(Boolean);
  }
  if (accountIds.length === 0) {
    console.log("\nNo linked accounts.\n");
    return;
  }

  const inList = accountIds.map((i) => `'${i}'`).join(",");
  const soql =
    `SELECT Id, Name, FirstName, LastName, Email, Title, AccountId, Account.Name, CreatedDate ` +
    `FROM Contact WHERE AccountId IN (${inList}) AND CreatedById = '${userId}' ORDER BY CreatedDate DESC`;
  const r = await fetch(`${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`, { headers: auth });
  if (!r.ok) {
    console.log(`\nCould not read contacts (${r.status}): ${(await r.text().catch(() => "")).slice(0, 200)}`);
    console.log(`That is a failure to look, not an absence of junk. Nothing deleted.\n`);
    process.exit(1);
  }
  const rows = ((await r.json()) as {
    records?: Array<{
      Id: string; Name: string | null; LastName: string | null; Email: string | null;
      Title: string | null; AccountId: string; Account?: { Name?: string }; CreatedDate: string;
    }>;
  }).records ?? [];

  console.log(`\n${rows.length} contact(s) on linked accounts were created by the integration user.`);

  const junk = rows.filter((c) => isJunkName(c.Name, c.LastName));
  const kept = rows.length - junk.length;
  console.log(`  ${junk.length} named after an email address`);
  console.log(`  ${kept} with a real name, which are left alone\n`);

  if (junk.length === 0) {
    console.log("Nothing to clean up.\n");
    return;
  }

  console.log(apply ? "APPLYING." : "Dry run. Nothing will be deleted.\n");
  let deleted = 0;
  let failed = 0;
  for (const c of junk) {
    const label = `${(c.Account?.Name ?? c.AccountId).slice(0, 24).padEnd(24)} ${c.Name ?? "(no name)"}`;
    if (!apply) {
      console.log(`  would delete  ${label}`);
      continue;
    }
    const del = await fetch(`${instanceUrl}/services/data/${API}/sobjects/Contact/${c.Id}`, {
      method: "DELETE",
      headers: auth,
    });
    if (del.status === 204) {
      deleted++;
      console.log(`  DELETED       ${label}`);
    } else {
      failed++;
      console.log(`  FAILED        ${label}  ${del.status} ${(await del.text().catch(() => "")).slice(0, 140)}`);
    }
  }

  console.log("");
  if (!apply) {
    console.log(`Re-run with --apply to delete these ${junk.length}.\n`);
  } else {
    console.log(`Deleted ${deleted}. Failed ${failed}.\n`);
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  let cause: unknown = (e as { cause?: unknown })?.cause;
  while (cause) {
    const c = cause as { message?: string; code?: string; cause?: unknown };
    console.error(`  caused by: ${c.code ?? ""} ${c.message ?? String(cause)}`);
    cause = c.cause;
  }
  console.error("");
  process.exit(1);
});
