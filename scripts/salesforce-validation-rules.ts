/**
 * Why is Salesforce refusing our Account update?
 *
 * On 2026-08-12 the first real write-back, Black Gold Logistics, came back:
 *
 *   FIELD_CUSTOM_VALIDATION_EXCEPTION
 *   "Have you completed all the fields, including the 'Date of Software
 *    Acquisition,' before submitting?"
 *
 * The error names no field ("fields":[]), which is what a validation rule looks
 * like as opposed to a required-field error. A rule carries a condition, and
 * the condition is the whole question: a rule that fires unconditionally blocks
 * every write we will ever attempt, while a rule scoped to a record type, a
 * stage, or a field actually being changed may not apply to us at all.
 *
 * Guessing which is unnecessary. The rule text is readable through the Tooling
 * API with the credentials we already hold, and reading it is the difference
 * between "ask Magaya's admin to exempt the integration user" and "we trip this
 * ourselves and can stop".
 *
 * READ ONLY. Queries metadata, touches no record.
 *
 *   npx tsx scripts/salesforce-validation-rules.ts
 *   npx tsx scripts/salesforce-validation-rules.ts --object Opportunity
 *
 * 2026-08-13, ANSWERED. Every write still bounced with that message while the
 * Tooling API reported the rule Active=false AND Metadata.active=false. A
 * deactivated rule cannot fire, so the logic had moved:
 *
 *   Flow  Record_Triggered_ACCOUNT_Before_Save   (active, RecordBeforeSave)
 *   decision element  "Is Date of Software Acquisition empty?"
 *   action element    "Show Error Message"
 *
 * The validation rule was migrated into a before-save flow and the old rule
 * deactivated. Same text, same effect, invisible if you only read rules.
 * Ruled out on the way: 3,024 Apex classes, all seven Account triggers, and the
 * other eleven flows. The one other flow that mentions the field,
 * Record_triggered_Account_Process_after_insert_update, only prints it inside a
 * notification email body and blocks nothing.
 *
 * Two lessons worth more than the answer. Trust the write, not the metadata: a
 * refused PATCH is evidence, an "inactive" flag is a claim. And every empty
 * result here was a lie until proven otherwise, because the flow query hit the
 * wrong endpoint, then the wrong column, and the class search stopped at
 * Salesforce's 200-row page. Each printed a confident zero.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSalesforceClient } from "../lib/salesforce";

const TOOLING_VERSION = "v61.0";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type ValidationRuleRow = {
  Id: string;
  ValidationName: string;
  Active: boolean;
  Metadata?: {
    active?: boolean;
    errorConditionFormula?: string;
    errorMessage?: string;
    errorDisplayField?: string | null;
    description?: string | null;
  };
};

async function main(): Promise<void> {
  const object = arg("--object") ?? "Account";
  const { token, instanceUrl } = await getSalesforceClient();
  const auth = { authorization: `Bearer ${token}` };

  async function tooling<T>(soql: string): Promise<T | null> {
    const url = `${instanceUrl}/services/data/${TOOLING_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`;
    const res = await fetch(url, { headers: auth });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.log(`\nTooling API returned ${res.status} for: ${soql.slice(0, 90)}`);
      console.log(body.slice(0, 300));
      // Say which of the two this is. A 403 means the integration user cannot
      // read metadata, which is a permission to request, not evidence that the
      // object has no rules.
      if (res.status === 401 || res.status === 403) {
        console.log(`\nThat is an access refusal, not an empty result. The integration user`);
        console.log(`needs "View Setup and Configuration" to read validation rules.\n`);
      }
      return null;
    }
    return (await res.json()) as T;
  }

  // FlowDefinitionView is a Data API object, not a Tooling one. Querying it on
  // the wrong endpoint returns INVALID_TYPE, which is not the same as "there
  // are no flows" and must never be printed as though it were.
  async function dataApi<T>(soql: string): Promise<T | null> {
    const url = `${instanceUrl}/services/data/${TOOLING_VERSION}/query?q=${encodeURIComponent(soql)}`;
    const res = await fetch(url, { headers: auth });
    if (!res.ok) {
      console.log(`\nData API returned ${res.status} for: ${soql.slice(0, 90)}`);
      console.log((await res.text().catch(() => "")).slice(0, 300));
      return null;
    }
    return (await res.json()) as T;
  }

  // Salesforce pages at 200 records. Following nextRecordsUrl is the difference
  // between "no class contains this" and "no class in the first page does".
  async function allPages<T>(first: { records?: T[]; nextRecordsUrl?: string } | null): Promise<T[] | null> {
    if (!first) return null;
    const out = [...(first.records ?? [])];
    let next = first.nextRecordsUrl;
    while (next) {
      const res = await fetch(`${instanceUrl}${next}`, { headers: auth });
      if (!res.ok) {
        console.log(`\n  Pagination stopped early at ${res.status}. Counts below are partial.`);
        break;
      }
      const page = (await res.json()) as { records?: T[]; nextRecordsUrl?: string };
      out.push(...(page.records ?? []));
      next = page.nextRecordsUrl;
    }
    return out;
  }

  // Two passes, because Salesforce refuses to return Metadata for more than one
  // row at a time. List first, then fetch each rule's formula individually.
  const list = await tooling<{ records?: Array<{ Id: string; ValidationName: string; Active: boolean }> }>(
    `SELECT Id, ValidationName, Active FROM ValidationRule ` +
      `WHERE EntityDefinition.QualifiedApiName = '${object}'`,
  );
  if (!list) process.exit(1);
  const rules = list.records ?? [];
  console.log(`\n${object}: ${rules.length} validation rule(s).\n`);
  if (rules.length === 0) {
    console.log(`No rules on ${object}. A refused write is then a required field, a`);
    console.log(`field-level permission, or a trigger, not a validation rule.\n`);
    return;
  }

  for (const r of rules) {
    const one = await tooling<{ records?: ValidationRuleRow[] }>(
      `SELECT Id, ValidationName, Active, Metadata FROM ValidationRule WHERE Id = '${r.Id}'`,
    );
    const full = one?.records?.[0];
    const md = full?.Metadata;
    // Print both flags rather than collapsing them. They can disagree, and
    // "off" without saying which one said so is the kind of answer that sends
    // you looking in the wrong place.
    const on = r.Active !== false && md?.active !== false;
    console.log(`${on ? "ACTIVE " : "off    "} ${r.ValidationName}   [Active=${r.Active} Metadata.active=${md?.active}]`);
    if (md?.description) console.log(`  note      ${md.description}`);
    if (md?.errorDisplayField) console.log(`  on field  ${md.errorDisplayField}`);
    if (md?.errorMessage) console.log(`  message   ${md.errorMessage.slice(0, 220)}`);
    if (md?.errorConditionFormula) {
      console.log(`  fires when:`);
      for (const line of md.errorConditionFormula.split("\n")) console.log(`      ${line.trim()}`);
    }
    console.log("");
  }

  // Flows, because a deactivated rule cannot be what is refusing the write.
  // FlowDefinitionView's object column has been spelled differently across API
  // versions, so try the known variants and fall back to listing every active
  // flow rather than reporting none.
  type FlowRow = { ApiName: string; Label: string; ProcessType: string; TriggerType: string | null; IsActive: boolean; TriggerObjectOrEventLabel?: string | null };
  const FLOW_QUERIES = [
    `SELECT ApiName, Label, ProcessType, TriggerType, IsActive, TriggerObjectOrEventLabel FROM FlowDefinitionView WHERE TriggerObjectOrEventLabel = '${object}'`,
    `SELECT ApiName, Label, ProcessType, TriggerType, IsActive FROM FlowDefinitionView WHERE IsActive = true`,
  ];
  let flowRows: FlowRow[] | null = null;
  let flowScope = "";
  for (const [i, q] of FLOW_QUERIES.entries()) {
    const r = await dataApi<{ records?: FlowRow[] }>(q);
    if (r) {
      flowRows = r.records ?? [];
      flowScope = i === 0 ? `record-triggered on ${object}` : "ALL active flows in the org, not filtered by object";
      break;
    }
  }
  if (flowRows === null) {
    console.log(`\nFlows: COULD NOT CHECK. That is not zero.`);
  } else {
    console.log(`\nFlows (${flowScope}): ${flowRows.length}`);
    for (const f of flowRows) {
      const obj = f.TriggerObjectOrEventLabel ? `, ${f.TriggerObjectOrEventLabel}` : "";
      console.log(`  ${f.IsActive ? "ACTIVE " : "off    "} ${f.Label}  (${f.ApiName}, ${f.ProcessType}${f.TriggerType ? ", " + f.TriggerType : ""}${obj})`);
    }
  }

  // Read each active flow's metadata and search it for the error text. Flow
  // Metadata, like ValidationRule Metadata, only comes back one row at a time.
  const NEEDLE_FLOW = "Date of Software Acquisition";
  if (flowRows) {
    const active = flowRows.filter((f) => f.IsActive);
    console.log(`\nSearching ${active.length} active flow(s) for the error text.`);
    for (const f of active) {
      const one = await tooling<{ records?: Array<{ MasterLabel: string; VersionNumber: number; Metadata?: unknown }> }>(
        `SELECT Id, MasterLabel, VersionNumber, Metadata FROM Flow ` +
          `WHERE Definition.DeveloperName = '${f.ApiName}' AND Status = 'Active'`,
      );
      const md = one?.records?.[0]?.Metadata;
      if (md === undefined) {
        console.log(`  ?      ${f.Label}: metadata not readable, so not searched`);
        continue;
      }
      const blob = JSON.stringify(md);
      if (blob.includes(NEEDLE_FLOW)) {
        console.log(`  HIT    ${f.Label}  (${f.ApiName})  <-- CONTAINS THE ERROR TEXT`);
        // Print the surrounding slice so the offending element is identifiable.
        const at = blob.indexOf(NEEDLE_FLOW);
        console.log(`         ...${blob.slice(Math.max(0, at - 260), at + 160)}...`);
      } else {
        console.log(`  clean  ${f.Label}`);
      }
    }
  }

  // Read the trigger source and search it for the error text. This is the only
  // way to stop guessing which of seven triggers is the one refusing us.
  const NEEDLE = "Date of Software Acquisition";
  const trigs = await tooling<{ records?: Array<{ Id: string; Name: string; Status: string; Body: string | null }> }>(
    `SELECT Id, Name, Status, Body FROM ApexTrigger WHERE TableEnumOrId = '${object}'`,
  );
  if (trigs === null) {
    console.log(`\nApex triggers on ${object}: COULD NOT CHECK. That is not zero.`);
  } else {
    const tg = trigs.records ?? [];
    console.log(`\nApex triggers on ${object}: ${tg.length}`);
    for (const t of tg) {
      const hit = (t.Body ?? "").includes(NEEDLE);
      console.log(`  ${t.Status === "Active" ? "ACTIVE " : "off    "} ${t.Name}${hit ? "   <-- CONTAINS THE ERROR TEXT" : ""}`);
      if (hit) {
        for (const line of (t.Body ?? "").split("\n")) {
          if (line.includes(NEEDLE)) console.log(`        ${line.trim().slice(0, 200)}`);
        }
      }
    }
    const bodiesRead = tg.filter((t) => t.Body !== null).length;
    if (bodiesRead < tg.length) {
      console.log(`  Note: only ${bodiesRead} of ${tg.length} trigger bodies were readable, so a`);
      console.log(`  trigger with no match here may simply not have been searched.`);
    }
  }

  // Apex classes too: a trigger usually delegates to a handler, and the
  // addError call lives in the class rather than the trigger itself.
  const classesFirst = await tooling<{ records?: Array<{ Name: string; Body: string | null }>; nextRecordsUrl?: string }>(
    `SELECT Name, Body FROM ApexClass`,
  );
  const classes = await allPages<{ Name: string; Body: string | null }>(classesFirst);
  if (classes === null) {
    console.log(`\nApex classes: COULD NOT CHECK.`);
  } else {
    const hits = classes.filter((c) => (c.Body ?? "").includes(NEEDLE));
    console.log(`\nApex classes searched: ${classes.length}. Containing the error text: ${hits.length}`);
    for (const c of hits) console.log(`  ${c.Name}`);
  }

  console.log(`\nIf a rule reads inactive and the write still bounces with its message,`);
  console.log(`the logic has moved. Look at whatever is marked above.\n`);

  console.log(`Read the formula of whichever rule matches the error text.`);
  console.log(`  - references only fields, with no guard on WHO is editing: it fires on`);
  console.log(`    every update and Magaya's admin must exempt the integration user.`);
  console.log(`  - guarded by RecordType, a stage, ISCHANGED() on a field we do not touch,`);
  console.log(`    or $Permission / $User: we may be able to stop tripping it ourselves.\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
