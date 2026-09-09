/**
 * Copy Salesforce's field history into the ledger.
 *
 *   npx tsx scripts/backfill-crm-field-events.ts                # dry run
 *   npx tsx scripts/backfill-crm-field-events.ts --apply        # WRITES
 *   npx tsx scripts/backfill-crm-field-events.ts --since 2026-07-01 --apply
 *
 * THIS IS THE BIGGEST SINGLE PIECE OF RECOVERABLE HISTORY DealRipe has. The
 * qualification gates, the Rolldog checklist and the RSVP trail all start from
 * today because their sources keep no history. Salesforce kept fifteen months
 * of it: 15,459 StageName transitions back to 2025-02-19, plus Amount,
 * CloseDate and ForecastCategoryName, each with an exact timestamp and the
 * name of whoever made the change.
 *
 * It is also the only part of the trajectory with a DEADLINE. Salesforce field
 * history retention is finite and org-configurable, and the pre-pilot baseline
 * is the first thing to expire. Once it does, the 26 closed pilot deals lose
 * the only comparison that makes them interpretable.
 *
 * Idempotent: the unique index on
 * (source_system, opportunity_id, field, changed_at) means a re-run writes
 * nothing. These are immutable facts Salesforce already decided.
 *
 * UNLINKED ROWS ARE KEPT. A change on an account with no DealRipe deal is
 * stored with deal_id null, because Magaya's history predates the pilot and
 * that is precisely the baseline worth having. Dropping it would leave a
 * dataset that can describe the pilot and cannot compare it to anything.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { backfillFieldEvents, HISTORY_BEGINS } from "../lib/crm-field-events";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const since = arg("--since");
  const sinceIso = since ? `${since}T00:00:00Z` : HISTORY_BEGINS;
  const tenantId = await resolveTenantId("magaya");

  console.log(`\n  Reading Salesforce field history since ${sinceIso.slice(0, 10)}.`);
  const r = await backfillFieldEvents({ tenantId, sinceIso, dryRun: !apply });

  console.log(`\n  accounts asked:     ${r.accountsAsked}`);
  console.log(`  changes read:       ${r.rowsRead}`);
  console.log(`    linked to a deal: ${r.rowsLinked}`);
  // NOT evidence of anything. Only accounts that already carry a DealRipe deal
  // are queried, so this is 0 by construction and an earlier version of this
  // line called it "the pre-pilot baseline", which it is not. The real baseline
  // is changes that predate our FIRST CAPTURED CALL on the deal, which is a
  // different quantity and lives in scripts/trajectory-coverage.ts.
  console.log(`    unlinked:         ${r.rowsUnlinked}   (always 0: only linked accounts are queried)`);
  console.log(`  span:               ${(r.oldest ?? "?").slice(0, 10)} -> ${(r.newest ?? "?").slice(0, 10)}`);
  console.log(`  by field:`);
  for (const [f, n] of Object.entries(r.byField).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${f.padEnd(22)} ${n}`);
  }

  if (apply) {
    console.log(`\n  wrote ${r.written} new row(s). A re-run should write 0.\n`);
  } else {
    console.log("\n  Dry run. Re-run with --apply to write.\n");
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
