/**
 * Delete a Salesforce record DealRipe created in error.
 *
 * We have no access to Magaya's Salesforce UI, so a record we should not have
 * written can only be removed from here. That makes this the one script in the
 * repo that destroys customer data, and it is built accordingly:
 *
 *   - it reads the record and PRINTS IT before doing anything
 *   - dry run by default, so the default outcome is that you see it and stop
 *   - it refuses any object other than Task or Contact, because those are the
 *     only two DealRipe creates and a typo should not be able to reach an
 *     Account or an Opportunity
 *   - it refuses a record it cannot read first, since deleting something you
 *     could not verify is exactly how one bad row becomes two
 *
 * First use, 2026-08-13: Task 00TRN00000wwfEp2AI, a call activity logged
 * against Korea for a meeting whose outcome was no_show. The backfill filtered
 * on has_been_extracted, which transcript-sync sets true on no-show and
 * capture_failed rows to stop retries, so a meeting nobody attended produced a
 * call record in a customer's CRM. The filter is fixed; the row it already
 * wrote is not.
 *
 *   npx tsx scripts/delete-salesforce-record.ts --id 00TRN00000wwfEp2AI
 *   npx tsx scripts/delete-salesforce-record.ts --id 00TRN00000wwfEp2AI --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSalesforceClient } from "../lib/salesforce";

const API = "v61.0";

/** Only what DealRipe creates. Nothing here can touch an Account. */
const DELETABLE: Record<string, { sobject: string; fields: string }> = {
  "00T": { sobject: "Task", fields: "Id, Subject, Status, Type, ActivityDate, WhatId, WhoId, Owner.Name, CreatedDate, Description" },
  "003": { sobject: "Contact", fields: "Id, Name, Email, Title, AccountId, CreatedDate, CreatedBy.Name" },
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const id = arg("--id");
  const apply = process.argv.includes("--apply");
  if (!id) {
    console.log("\nPass --id <salesforce record id>.\n");
    process.exit(1);
  }

  const prefix = id.slice(0, 3);
  const kind = DELETABLE[prefix];
  if (!kind) {
    console.log(`\nId prefix '${prefix}' is not a Task or a Contact.`);
    console.log(`This script only deletes records DealRipe creates. Refusing.\n`);
    process.exit(1);
  }

  const { token, instanceUrl } = await getSalesforceClient();
  const auth = { authorization: `Bearer ${token}` };

  // Read it first, always. A delete you cannot describe is a delete you should
  // not be making.
  const soql = `SELECT ${kind.fields} FROM ${kind.sobject} WHERE Id = '${id}'`;
  const r = await fetch(`${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`, { headers: auth });
  if (!r.ok) {
    console.log(`\nCould not read ${kind.sobject} ${id}: ${r.status}`);
    console.log(`${(await r.text().catch(() => "")).slice(0, 300)}`);
    console.log(`\nThat is a failure to look, not proof the record is gone. Nothing deleted.\n`);
    process.exit(1);
  }
  const rows = ((await r.json()) as { records?: Array<Record<string, unknown>> }).records ?? [];
  if (rows.length === 0) {
    console.log(`\n${kind.sobject} ${id} does not exist. Nothing to delete.\n`);
    return;
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`${kind.sobject} ${id}`);
  console.log(`${"=".repeat(70)}`);
  for (const [k, v] of Object.entries(rows[0])) {
    if (k === "attributes") continue;
    const shown = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
    console.log(`  ${k.padEnd(14)} ${shown.length > 300 ? `${shown.slice(0, 300)}...` : shown}`);
  }
  console.log(`${"=".repeat(70)}`);

  if (!apply) {
    console.log(`\nDry run. Read the record above, then re-run with --apply to delete it.\n`);
    return;
  }

  const del = await fetch(`${instanceUrl}/services/data/${API}/sobjects/${kind.sobject}/${id}`, {
    method: "DELETE",
    headers: auth,
  });
  if (del.status === 204) {
    console.log(`\nDELETED ${kind.sobject} ${id}.\n`);
    return;
  }
  console.log(`\nDelete refused: ${del.status}`);
  console.log(`${(await del.text().catch(() => "")).slice(0, 400)}`);
  console.log(`\nThe integration user may not hold Delete on ${kind.sobject}. The record is unchanged.\n`);
  process.exit(1);
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
