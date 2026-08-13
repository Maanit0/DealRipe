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

  const soql =
    `SELECT Id, ValidationName, Active, Metadata FROM ValidationRule ` +
    `WHERE EntityDefinition.QualifiedApiName = '${object}'`;
  const url = `${instanceUrl}/services/data/${TOOLING_VERSION}/tooling/query?q=${encodeURIComponent(soql)}`;

  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.log(`\nTooling API returned ${res.status}.`);
    console.log(body.slice(0, 400));
    // Say which of the two this is. A 403 means the integration user cannot
    // read metadata, which is a permission to request, not evidence that the
    // object has no rules.
    if (res.status === 401 || res.status === 403) {
      console.log(`\nThat is an access refusal, not an empty result. The integration user`);
      console.log(`needs "View Setup and Configuration" to read validation rules. Nothing`);
      console.log(`here says whether ${object} has any.\n`);
    }
    process.exit(1);
  }

  const data = (await res.json()) as { records?: ValidationRuleRow[] };
  const rules = data.records ?? [];
  const active = rules.filter((r) => r.Active !== false && r.Metadata?.active !== false);

  console.log(`\n${object}: ${rules.length} validation rule(s), ${active.length} active.\n`);
  if (rules.length === 0) {
    console.log(`No rules on ${object}. If a write is still refused, it is a required`);
    console.log(`field, a field-level permission, or a trigger, not a validation rule.\n`);
    return;
  }

  for (const r of rules) {
    const on = r.Active !== false && r.Metadata?.active !== false;
    console.log(`${on ? "ACTIVE " : "off    "} ${r.ValidationName}`);
    if (r.Metadata?.description) console.log(`  note      ${r.Metadata.description}`);
    if (r.Metadata?.errorDisplayField) console.log(`  on field  ${r.Metadata.errorDisplayField}`);
    if (r.Metadata?.errorMessage) console.log(`  message   ${r.Metadata.errorMessage.slice(0, 200)}`);
    if (r.Metadata?.errorConditionFormula) {
      console.log(`  fires when:`);
      for (const line of r.Metadata.errorConditionFormula.split("\n")) {
        console.log(`      ${line.trim()}`);
      }
    }
    console.log("");
  }

  console.log(`Read the formula of whichever rule matches the error text.`);
  console.log(`  - references only fields we do not touch, with no guard on WHO is editing:`);
  console.log(`    it fires on every update and Magaya's admin must exempt the integration`);
  console.log(`    user. That is the ask, and no code change avoids it.`);
  console.log(`  - guarded by RecordType, a stage, ISCHANGED() on a specific field, or`);
  console.log(`    $Permission / $User: we may be able to stop tripping it ourselves.\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
