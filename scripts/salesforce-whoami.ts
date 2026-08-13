/**
 * Which Salesforce user does DealRipe actually authenticate as?
 *
 * Asked once, answered forever. Magaya's Salesforce work goes through a
 * third-party contractor, so every unanswered detail costs a day of email. When
 * they are told to exempt "the DealRipe integration user" they need a username
 * and an Id, not a description, and guessing at it means they build the
 * exemption around the wrong user and the write still fails.
 *
 * The identity endpoint answers this directly from the token we already hold,
 * so there is no reason to ask anyone.
 *
 * READ ONLY.
 *
 *   npx tsx scripts/salesforce-whoami.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSalesforceClient } from "../lib/salesforce";

async function main(): Promise<void> {
  const { token, instanceUrl } = await getSalesforceClient();
  const auth = { authorization: `Bearer ${token}` };

  const res = await fetch(`${instanceUrl}/services/oauth2/userinfo`, { headers: auth });
  if (!res.ok) {
    console.log(`\nuserinfo returned ${res.status}`);
    console.log((await res.text().catch(() => "")).slice(0, 300));
    console.log(`\nThat is a failure to ask, not an absence of a user.\n`);
    process.exit(1);
  }
  const me = (await res.json()) as {
    user_id?: string;
    organization_id?: string;
    preferred_username?: string;
    name?: string;
    email?: string;
  };

  // The 15-character Id is what an admin sees in the UI; the 18-character one is
  // what the API returns. Print both so nobody has to convert.
  const id18 = me.user_id ?? "";
  const id15 = id18.length === 18 ? id18.slice(0, 15) : id18;

  console.log(`\nDealRipe authenticates to Salesforce as:\n`);
  console.log(`  Username        ${me.preferred_username ?? "(not returned)"}`);
  console.log(`  Name            ${me.name ?? "(not returned)"}`);
  console.log(`  Email           ${me.email ?? "(not returned)"}`);
  console.log(`  User Id (18)    ${id18}`);
  console.log(`  User Id (15)    ${id15}`);
  console.log(`  Org Id          ${me.organization_id ?? "(not returned)"}`);

  // Profile and permission sets, because whoever writes the exemption will want
  // to know where to hang a custom permission.
  const q = async (soql: string) => {
    const r = await fetch(
      `${instanceUrl}/services/data/v61.0/query?q=${encodeURIComponent(soql)}`,
      { headers: auth },
    );
    if (!r.ok) return null;
    return (await r.json()) as { records?: Array<Record<string, unknown>> };
  };

  const user = await q(`SELECT Id, Username, Name, Profile.Name, IsActive FROM User WHERE Id = '${id18}'`);
  const u = user?.records?.[0] as { Profile?: { Name?: string }; IsActive?: boolean } | undefined;
  if (u) {
    console.log(`  Profile         ${u.Profile?.Name ?? "(unknown)"}`);
    console.log(`  Active          ${u.IsActive}`);
  } else {
    console.log(`  Profile         could not read the User record, so not shown`);
  }

  const psa = await q(
    `SELECT PermissionSet.Name, PermissionSet.Label FROM PermissionSetAssignment WHERE AssigneeId = '${id18}'`,
  );
  if (psa === null) {
    console.log(`\n  Permission sets: could not read. That is not "none".`);
  } else {
    const rows = (psa.records ?? []) as Array<{ PermissionSet?: { Name?: string; Label?: string } }>;
    console.log(`\n  Permission sets (${rows.length}):`);
    for (const r of rows) console.log(`    ${r.PermissionSet?.Label ?? "?"}  (${r.PermissionSet?.Name ?? "?"})`);
  }

  console.log(`\nGive the username and the 18 character Id to whoever writes the flow`);
  console.log(`exemption. A custom permission hangs off one of the permission sets above.\n`);
}

main().catch((e) => {
  // "fetch failed" on its own is useless: it is Node's wrapper for a DNS or
  // connection error and the reason lives in e.cause. Print the chain.
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  let cause: unknown = (e as { cause?: unknown })?.cause;
  while (cause) {
    const c = cause as { message?: string; code?: string; errno?: number; hostname?: string; cause?: unknown };
    console.error(`  caused by: ${c.code ?? ""} ${c.message ?? String(cause)}${c.hostname ? ` (host ${c.hostname})` : ""}`);
    cause = c.cause;
  }
  console.error("");
  process.exit(1);
});
