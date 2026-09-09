/**
 * Sweep the Rolldog stage-requirement checklists and record what moved.
 *
 *   npx tsx scripts/stage-gate-log.ts                    # dry run, whole tenant
 *   npx tsx scripts/stage-gate-log.ts --deal <uuid>      # dry run, one deal
 *   npx tsx scripts/stage-gate-log.ts --apply            # WRITES
 *   npx tsx scripts/stage-gate-log.ts --deal <uuid> --now --apply   # ignore the 12h gate
 *
 * Imports lib/stage-gate-log.ts rather than restating the diff, so this cannot
 * disagree with what the cron writes. A checker that can disagree with the code
 * it checks will, and it will do so confidently.
 *
 * VERIFYING A RUN. Two queries, and the second is the one that matters:
 *
 *   select count(*) from rolldog_gate_events;
 *     Must NOT grow across two runs 24h apart with no ticks in between. An
 *     event log that fires on every read is a read log.
 *
 *   select count(*) from crm_access_log where allowed = false and at > '<start>';
 *     Must be 0. Zero refused reads over a run is the only proof the scope
 *     wrapper is actually on the path, which is how all five unwrapped reads
 *     were verified on 2026-08-16.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { sweepAllChecklists } from "../lib/stage-gate-log";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const now = process.argv.includes("--now");
  const deal = arg("--deal");
  const tenantId = await resolveTenantId("magaya");
  const startedAt = new Date().toISOString();

  const results = await sweepAllChecklists({
    tenantId,
    apply,
    dealIds: deal ? [deal] : undefined,
    respectRateGate: !now,
  });

  const by = (s: string) => results.filter((r) => r.status === s).length;
  const skipped = results.filter((r) => r.skippedRecentlyRead).length;
  const changed = results.filter((r) => r.changes.length > 0);
  const seeds = changed.filter((r) => r.changes.every((c) => c.fromTicked === null));

  console.log(`\n  deals considered:        ${results.length}`);
  console.log(`  present:                 ${by("present") - skipped}`);
  console.log(`  skipped (read <12h ago): ${skipped}`);
  console.log(`  no_opportunity:          ${by("no_opportunity")}`);
  console.log(`  no_checklist:            ${by("no_checklist")}`);
  console.log(`  unavailable:             ${by("unavailable")}   <- could NOT read, not "empty"`);
  console.log(`  deals with changes:      ${changed.length}`);
  console.log(`  ...of which first sight: ${seeds.length}   <- from_ticked null, the honest floor`);

  for (const r of changed.slice(0, 25)) {
    console.log(`\n  deal ${r.dealId}  opp ${r.opportunityId}  ${r.tickedCount}/${r.totalCount} ticked`);
    for (const c of r.changes) {
      const from = c.fromTicked === null ? "first seen" : c.fromTicked ? "ticked" : "unset";
      console.log(`    [${c.stageKey ?? "?"}] #${c.rolldogId} ${from} -> ${c.toTicked ? "ticked" : "unset"}  ${c.itemName}`);
    }
  }
  if (changed.length > 25) console.log(`\n  ...and ${changed.length - 25} more deal(s) with changes, not printed`);

  for (const r of results.filter((r) => r.status === "unavailable")) {
    console.log(`\n  UNAVAILABLE deal ${r.dealId} opp ${r.opportunityId}: ${r.error}`);
  }

  if (apply) {
    // The verification that matters, run automatically rather than left to a
    // human to remember.
    const refused = await supabaseAdmin()
      .from("crm_access_log")
      .select("id", { count: "exact", head: true })
      .eq("allowed", false)
      .gte("at", startedAt);
    const n = refused.count ?? 0;
    console.log(`\n  refused reads during this run: ${n}${n === 0 ? "  (wrapper is on the path)" : "  <- INVESTIGATE"}`);
  } else {
    console.log("\n  Dry run. Re-run with --apply to write.\n");
  }
  console.log("");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
