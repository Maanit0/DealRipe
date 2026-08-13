/**
 * How do Magaya's reps actually use Salesforce on these accounts?
 *
 * Before writing anything new we should copy what the reps already do, not
 * invent a convention and hope they adopt it. Three questions this answers,
 * all read-only:
 *
 *   1. Which Sales Development fields do reps actually fill in? The validation
 *      rule names twenty. If nobody has ever populated half of them, extracting
 *      them from calls is effort spent on a field no one reads.
 *   2. How do reps log calls? Task or Event, what Subject, what Type, and how
 *      soon after the meeting. Our activity should look like theirs.
 *   3. How are contacts and roles maintained? Whether OpportunityContactRole is
 *      used at all decides whether writing roles helps or creates noise.
 *
 * Nothing here writes. It is a survey, and its output is the spec for the
 * write-back rather than a guess at one.
 *
 *   npx tsx scripts/salesforce-rep-practice.ts
 *   npx tsx scripts/salesforce-rep-practice.ts --account 001RN00000mCyY1YAK
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSalesforceClient } from "../lib/salesforce";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const API = "v61.0";

/** The full Sales Development section, taken from the validation rule formula. */
const SALES_DEV_FIELDS = [
  "Are_they_FF_NVOCC_Courier_3PL__c",
  "Does_lead_have_a_warehouse__c",
  "Software_Purposes__c",
  "Annual_Company_Revenue__c",
  "Any_Other_Software__c",
  "Lead_Does_Not_Require_Integrations__c",
  "Number_of_Users__c",
  "ACE_AES_Filer_Code__c",
  "Desired_Go_Live_Date__c",
  "Less_Than_90_Days__c",
  "Accounting_System_Used__c",
  "Other_Providers_Reached_Out__c",
  "Knows_Magaya_Is_A_Referral__c",
  "Magaya_lead_NA_SA_Europe__c",
  "Acelynk_Existing_Filer_Code__c",
  "Budget_Confirmed__c",
  "Business_Issues__c",
  "Compelling_Events__c",
  "Executive_Sponsorship__c",
  "Special_Handling_Instructions__c",
  "Date_of_Software_Acquisition__c",
] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const { token, instanceUrl } = await getSalesforceClient();
  const auth = { authorization: `Bearer ${token}` };

  async function q<T>(soql: string, label: string): Promise<T[] | null> {
    const res = await fetch(`${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`, { headers: auth });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 220);
      console.log(`\n  ${label}: COULD NOT READ (${res.status}). That is not zero.`);
      console.log(`     ${body}`);
      return null;
    }
    const json = (await res.json()) as { records?: T[] };
    return json.records ?? [];
  }

  // Which accounts to survey: the ones DealRipe is already linked to, because
  // those are the ones a write-back would touch.
  const one = arg("--account");
  let accountIds: string[];
  if (one) {
    accountIds = [one];
  } else {
    const db = supabaseAdmin();
    const tenantId = await resolveTenantId("magaya");
    const res = await db
      .from("deals")
      .select("account, salesforce_account_id")
      .eq("tenant_id", tenantId)
      .not("salesforce_account_id", "is", null);
    accountIds = ((res.data ?? []) as Array<{ salesforce_account_id: string }>)
      .map((d) => d.salesforce_account_id)
      .filter(Boolean);
  }
  if (accountIds.length === 0) {
    console.log("\nNo Salesforce-linked accounts to survey.\n");
    return;
  }
  const inList = accountIds.map((i) => `'${i}'`).join(",");
  console.log(`\nSurveying ${accountIds.length} linked account(s).`);

  // ---------------------------------------------------------------
  // 1. Which Sales Development fields do reps actually populate?
  // ---------------------------------------------------------------
  console.log(`\n${"=".repeat(78)}\n1. SALES DEVELOPMENT FIELDS: what reps actually fill in\n${"=".repeat(78)}`);
  const accounts = await q<Record<string, unknown>>(
    `SELECT Id, Name, ${SALES_DEV_FIELDS.join(", ")} FROM Account WHERE Id IN (${inList})`,
    "Account fields",
  );
  if (accounts) {
    const filled = new Map<string, number>();
    for (const f of SALES_DEV_FIELDS) filled.set(f, 0);
    for (const a of accounts) {
      for (const f of SALES_DEV_FIELDS) {
        const v = a[f];
        // false on a checkbox is indistinguishable from never-set in Salesforce,
        // so only positive values count as evidence a rep filled it.
        const isSet = v !== null && v !== undefined && v !== "" && v !== false;
        if (isSet) filled.set(f, (filled.get(f) ?? 0) + 1);
      }
    }
    const rows = [...filled.entries()].sort((a, b) => b[1] - a[1]);
    for (const [f, n] of rows) {
      const pct = Math.round((n / accounts.length) * 100);
      const bar = "#".repeat(Math.round(pct / 5)).padEnd(20, ".");
      console.log(`  ${bar} ${String(pct).padStart(3)}%  ${n}/${accounts.length}  ${f}`);
    }
    console.log(`\n  A field at 0% is one no rep has ever filled on these accounts.`);
    console.log(`  Extracting it from calls would be work nobody reads.`);
  }

  // ---------------------------------------------------------------
  // 2. How do reps log calls?
  // ---------------------------------------------------------------
  console.log(`\n${"=".repeat(78)}\n2. ACTIVITY: how reps log a call today\n${"=".repeat(78)}`);
  const tasks = await q<{ Id: string; Subject: string | null; Type: string | null; Status: string | null; ActivityDate: string | null; CreatedDate: string; Owner?: { Name?: string }; Description: string | null; WhatId: string | null }>(
    `SELECT Id, Subject, Type, Status, ActivityDate, CreatedDate, Owner.Name, Description, WhatId ` +
      `FROM Task WHERE WhatId IN (${inList}) ORDER BY CreatedDate DESC LIMIT 60`,
    "Task",
  );
  if (tasks) {
    console.log(`  Tasks on these accounts: ${tasks.length}`);
    const bySubject = new Map<string, number>();
    const byType = new Map<string, number>();
    const byOwner = new Map<string, number>();
    for (const t of tasks) {
      bySubject.set(t.Subject ?? "(blank)", (bySubject.get(t.Subject ?? "(blank)") ?? 0) + 1);
      byType.set(t.Type ?? "(blank)", (byType.get(t.Type ?? "(blank)") ?? 0) + 1);
      byOwner.set(t.Owner?.Name ?? "(unknown)", (byOwner.get(t.Owner?.Name ?? "(unknown)") ?? 0) + 1);
    }
    const top = (m: Map<string, number>, n = 8) =>
      [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    console.log(`\n  Subjects reps use:`);
    for (const [k, v] of top(bySubject)) console.log(`    ${String(v).padStart(3)}x  ${k}`);
    console.log(`\n  Type values:`);
    for (const [k, v] of top(byType)) console.log(`    ${String(v).padStart(3)}x  ${k}`);
    console.log(`\n  Who logs them:`);
    for (const [k, v] of top(byOwner)) console.log(`    ${String(v).padStart(3)}x  ${k}`);
    const withBody = tasks.filter((t) => (t.Description ?? "").trim().length > 40);
    console.log(`\n  Tasks carrying a real description: ${withBody.length} of ${tasks.length}`);
    if (withBody[0]) {
      console.log(`\n  Most recent example (${withBody[0].Owner?.Name ?? "?"}, ${withBody[0].CreatedDate.slice(0, 10)}):`);
      console.log(`    Subject: ${withBody[0].Subject}`);
      for (const line of (withBody[0].Description ?? "").split("\n").slice(0, 10)) {
        console.log(`    ${line.trim().slice(0, 120)}`);
      }
    }
  }

  const events = await q<{ Id: string; Subject: string | null; Type: string | null; StartDateTime: string | null; Owner?: { Name?: string } }>(
    `SELECT Id, Subject, Type, StartDateTime, Owner.Name FROM Event WHERE WhatId IN (${inList}) ORDER BY StartDateTime DESC LIMIT 40`,
    "Event",
  );
  if (events) {
    console.log(`\n  Events on these accounts: ${events.length}`);
    for (const e of events.slice(0, 6)) {
      console.log(`    ${(e.StartDateTime ?? "").slice(0, 10)}  ${e.Subject ?? "(no subject)"}  [${e.Type ?? "no type"}]  ${e.Owner?.Name ?? ""}`);
    }
    console.log(`\n  If meetings live on Event and not Task, our call log should too.`);
  }

  // ---------------------------------------------------------------
  // 3. Contacts and roles
  // ---------------------------------------------------------------
  console.log(`\n${"=".repeat(78)}\n3. CONTACTS: how the buying group is recorded\n${"=".repeat(78)}`);
  const contacts = await q<{ Id: string; Name: string; Title: string | null; Email: string | null; AccountId: string; CreatedDate: string; CreatedBy?: { Name?: string } }>(
    `SELECT Id, Name, Title, Email, AccountId, CreatedDate, CreatedBy.Name FROM Contact ` +
      `WHERE AccountId IN (${inList}) ORDER BY CreatedDate DESC LIMIT 80`,
    "Contact",
  );
  if (contacts) {
    console.log(`  Contacts across these accounts: ${contacts.length}`);
    const withTitle = contacts.filter((c) => (c.Title ?? "").trim().length > 0).length;
    const withEmail = contacts.filter((c) => (c.Email ?? "").trim().length > 0).length;
    console.log(`    with a Title: ${withTitle}   with an Email: ${withEmail}`);
    const perAccount = new Map<string, number>();
    for (const c of contacts) perAccount.set(c.AccountId, (perAccount.get(c.AccountId) ?? 0) + 1);
    const none = accountIds.filter((id) => !perAccount.has(id)).length;
    console.log(`    accounts with no contact at all: ${none} of ${accountIds.length}`);
    console.log(`\n  Most recent:`);
    for (const c of contacts.slice(0, 8)) {
      console.log(`    ${c.CreatedDate.slice(0, 10)}  ${c.Name}  ${c.Title ? `(${c.Title})` : "(no title)"}  by ${c.CreatedBy?.Name ?? "?"}`);
    }
  }

  const ocr = await q<{ Id: string; Role: string | null; IsPrimary: boolean; Contact?: { Name?: string }; Opportunity?: { Name?: string } }>(
    `SELECT Id, Role, IsPrimary, Contact.Name, Opportunity.Name FROM OpportunityContactRole ` +
      `WHERE Opportunity.AccountId IN (${inList}) LIMIT 60`,
    "OpportunityContactRole",
  );
  if (ocr) {
    console.log(`\n  OpportunityContactRole records: ${ocr.length}`);
    if (ocr.length === 0) {
      console.log(`    Reps do not use roles on these accounts. Writing them would be`);
      console.log(`    introducing a convention rather than following one.`);
    } else {
      const byRole = new Map<string, number>();
      for (const r of ocr) byRole.set(r.Role ?? "(blank)", (byRole.get(r.Role ?? "(blank)") ?? 0) + 1);
      for (const [k, v] of [...byRole.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`    ${String(v).padStart(3)}x  ${k}`);
      }
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(`Read the field chart first. It says which of the twenty are worth`);
  console.log(`extracting. Then the activity section: copy the Subject and Type reps`);
  console.log(`already use, so our call log looks like one of theirs rather than a`);
  console.log(`foreign object in the timeline.\n`);
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
