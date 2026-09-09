/**
 * Capture the rep-logged activity DealRipe reads and discards.
 *
 *   npx tsx scripts/backfill-crm-activities.ts               # dry run
 *   npx tsx scripts/backfill-crm-activities.ts --apply       # WRITES
 *   npx tsx scripts/backfill-crm-activities.ts --since 2026-06-01 --apply
 *
 * Salesforce Task and Event, plus Rolldog's interactions tab. All three already
 * have readers in this codebase and none of them keeps a row.
 *
 * Idempotent on (source_system, source_object, external_id): these are records
 * the CRM already owns, so a re-run writes nothing.
 *
 * OUR OWN WRITES ARE MARKED, NOT DROPPED. logCallToSalesforce writes Tasks and
 * createActivity writes Rolldog activities, so is_ours is set at ingest.
 * Reading our own output back as the rep's work is exactly how deal_messages
 * came to hold 31 of our own drafts as rep outbound.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { backfillActivities } from "../lib/crm-activities";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const since = arg("--since");
  const tenantId = await resolveTenantId("magaya");

  const r = await backfillActivities({
    tenantId,
    sinceIso: since ? `${since}T00:00:00Z` : undefined,
    dryRun: !apply,
  });

  console.log(`\n  Salesforce Task + Event`);
  console.log(`    read:            ${r.salesforce.read}`);
  console.log(`    linked to a deal:${String(r.salesforce.linked).padStart(6)}`);
  console.log(`    written by US:   ${String(r.salesforce.ours).padStart(6)}   <- marked is_ours, consumers must filter`);
  console.log(`\n  Rolldog activities`);
  console.log(`    read:            ${r.rolldog.read}`);
  console.log(`    written by US:   ${String(r.rolldog.ours).padStart(6)}`);
  console.log(`    opportunities unreadable: ${r.rolldog.opportunitiesUnavailable}   <- NOT "no activity"`);
  console.log(`\n  by source:`, r.bySource);
  console.log(`  span: ${(r.oldest ?? "?").slice(0, 10)} -> ${(r.newest ?? "?").slice(0, 10)}`);
  for (const e of r.errors) console.log(`  ERROR ${e}`);

  if (apply) console.log(`\n  wrote ${r.written} new row(s). A re-run should write 0.\n`);
  else console.log("\n  Dry run. Re-run with --apply to write.\n");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
