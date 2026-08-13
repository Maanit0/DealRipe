/**
 * What can DealRipe actually do in Magaya's Salesforce right now?
 *
 * On 2026-08-03 their Salesforce contractor asked whether to grant read on
 * Contacts, OpportunityContactRole, Lead, Task and Event. Nobody ever answered
 * in the thread, so what we hold is unknown, and asking for permissions we
 * already have wastes a round trip with a third party who takes days.
 *
 * sObject describe reports createable, updateable and queryable as evaluated
 * for the RUNNING user, so this answers the question from the credentials we
 * already hold rather than from anyone's memory of what was granted.
 *
 * Field level security is checked too. Object access is not enough: a field the
 * integration user cannot update will be silently dropped from a PATCH, which
 * looks exactly like a write that worked.
 *
 * READ ONLY. Describes objects, creates nothing.
 *
 *   npx tsx scripts/salesforce-permissions.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSalesforceClient } from "../lib/salesforce";

const API = "v61.0";

/** Objects DealRipe uses today or would use for activity logging and contacts. */
const OBJECTS = [
  { name: "Account", why: "qualification write-back (live today)" },
  { name: "Opportunity", why: "deal context for briefings" },
  { name: "Task", why: "logging each call as a completed activity" },
  { name: "Event", why: "reading meetings reps already logged" },
  { name: "Contact", why: "the buying group" },
  { name: "OpportunityContactRole", why: "who plays which role on a deal" },
  { name: "Lead", why: "early stage records" },
] as const;

/** The Sales Development section, from the validation rule formula. */
const SALES_DEV_FIELDS = [
  "Business_Issues__c", "Software_Purposes__c", "Any_Other_Software__c",
  "Other_Providers_Reached_Out__c", "Desired_Go_Live_Date__c",
  "Compelling_Events__c", "Budget_Confirmed__c", "Executive_Sponsorship__c",
  "Number_of_Users__c", "Are_they_FF_NVOCC_Courier_3PL__c",
  "Does_lead_have_a_warehouse__c", "Accounting_System_Used__c",
  "Annual_Company_Revenue__c", "Less_Than_90_Days__c",
  "Lead_Does_Not_Require_Integrations__c", "Date_of_Software_Acquisition__c",
  "ACE_AES_Filer_Code__c", "Acelynk_Existing_Filer_Code__c",
  "Knows_Magaya_Is_A_Referral__c", "Magaya_lead_NA_SA_Europe__c",
  "Special_Handling_Instructions__c",
] as const;

type FieldDesc = {
  name: string; label: string; type: string;
  createable: boolean; updateable: boolean; length?: number;
  picklistValues?: Array<{ value: string; active: boolean }>;
};
type ObjDesc = {
  name: string; createable: boolean; updateable: boolean;
  queryable: boolean; deletable: boolean; fields: FieldDesc[];
};

async function main(): Promise<void> {
  const { token, instanceUrl } = await getSalesforceClient();
  const auth = { authorization: `Bearer ${token}` };

  async function describe(obj: string): Promise<ObjDesc | { error: string }> {
    const res = await fetch(`${instanceUrl}/services/data/${API}/sobjects/${obj}/describe`, { headers: auth });
    if (!res.ok) {
      return { error: `${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}` };
    }
    return (await res.json()) as ObjDesc;
  }

  const mark = (b: boolean) => (b ? "yes" : "NO ");

  console.log(`\n${"=".repeat(78)}`);
  console.log(`OBJECT ACCESS, as the DealRipe integration user sees it`);
  console.log(`${"=".repeat(78)}`);
  console.log(`  read   create update  object                   why we want it`);

  const missing: string[] = [];
  let accountDesc: ObjDesc | null = null;

  for (const o of OBJECTS) {
    const d = await describe(o.name);
    if ("error" in d) {
      // A describe failure is a refusal to answer, not proof of no access, and
      // the two must not be printed the same way.
      console.log(`  ????   ????  ????   ${o.name.padEnd(24)} DESCRIBE FAILED: ${d.error}`);
      missing.push(`${o.name} (could not describe: ${d.error})`);
      continue;
    }
    if (o.name === "Account") accountDesc = d;
    console.log(
      `  ${mark(d.queryable)}    ${mark(d.createable)}   ${mark(d.updateable)}   ` +
      `${o.name.padEnd(24)} ${o.why}`,
    );
    if (o.name === "Task" && !d.createable) missing.push("Create on Task, to log each call as a completed activity");
    if (o.name === "Task" && !d.queryable) missing.push("Read on Task, to avoid duplicating a rep's own entry");
    if (o.name === "Event" && !d.queryable) missing.push("Read on Event, to see meetings reps already logged");
    if (o.name === "Contact" && !d.queryable) missing.push("Read on Contact, for the buying group");
    if (o.name === "OpportunityContactRole" && !d.queryable) missing.push("Read on OpportunityContactRole");
  }

  // ---------------------------------------------------------------
  // Field level security on the fields we write or want to write.
  // ---------------------------------------------------------------
  if (accountDesc) {
    console.log(`\n${"=".repeat(78)}`);
    console.log(`ACCOUNT FIELD ACCESS  (a field we cannot update is dropped silently)`);
    console.log(`${"=".repeat(78)}`);
    const byName = new Map(accountDesc.fields.map((f) => [f.name, f]));
    for (const name of SALES_DEV_FIELDS) {
      const f = byName.get(name);
      if (!f) {
        console.log(`  NOT VISIBLE  ${name}`);
        missing.push(`Field level read on Account.${name}`);
        continue;
      }
      const type = f.type + (f.length ? `(${f.length})` : "");
      const picks = f.picklistValues?.filter((p) => p.active).map((p) => p.value) ?? [];
      console.log(`  ${f.updateable ? "update  " : "READ ONLY"}  ${name.padEnd(38)} ${type}`);
      if (picks.length) console.log(`             allowed: ${picks.slice(0, 12).join(" | ")}${picks.length > 12 ? " ..." : ""}`);
      if (!f.updateable) missing.push(`Field level edit on Account.${name}`);
    }
  }

  // ---------------------------------------------------------------
  // Task fields, so the activity we create matches what reps see.
  // ---------------------------------------------------------------
  const task = await describe("Task");
  if (!("error" in task)) {
    const want = ["Subject", "Description", "Type", "Status", "ActivityDate", "WhatId", "WhoId", "OwnerId", "CallDisposition"];
    const byName = new Map(task.fields.map((f) => [f.name, f]));
    console.log(`\n${"=".repeat(78)}`);
    console.log(`TASK FIELDS we would set when logging a call`);
    console.log(`${"=".repeat(78)}`);
    for (const w of want) {
      const f = byName.get(w);
      if (!f) { console.log(`  NOT VISIBLE  ${w}`); continue; }
      const picks = f.picklistValues?.filter((p) => p.active).map((p) => p.value) ?? [];
      console.log(`  ${f.createable ? "create  " : "NO CREATE"}  ${w.padEnd(16)} ${f.type}${f.length ? `(${f.length})` : ""}`);
      if (picks.length) console.log(`             allowed: ${picks.slice(0, 14).join(" | ")}`);
    }
  }

  console.log(`\n${"=".repeat(78)}`);
  if (missing.length === 0) {
    console.log(`Nothing missing. Everything DealRipe needs is already granted.`);
  } else {
    console.log(`STILL TO ASK FOR (${missing.length}):`);
    for (const m of missing) console.log(`  - ${m}`);
  }
  console.log(`${"=".repeat(78)}\n`);
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
