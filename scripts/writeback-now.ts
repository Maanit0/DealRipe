/**
 * Trigger the production Rolldog write-back for a deal NOW, pushing its stored
 * extractions to its linked opportunity. Uses the exact same gated path as the
 * automatic pipeline (scope-guarded, fail-closed, confirmed-link only), so it
 * cannot write to an unauthorized opp.
 *
 * This LIVE-WRITES to the customer's Rolldog, so it requires --apply. Preview
 * the exact payload first with:
 *   npx tsx scripts/preview-writeback.ts --deal <ext> --real
 *
 *   npx tsx scripts/writeback-now.ts --deal auto:corelogistics.net           # explain, no write
 *   npx tsx scripts/writeback-now.ts --deal auto:corelogistics.net --apply   # LIVE write
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { writeBackDealToRolldog } from "../lib/rolldog-writeback";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ext = arg("--deal");
  const apply = process.argv.includes("--apply");
  if (!ext) {
    console.error("Usage: --deal <external_id> [--apply]");
    process.exit(1);
  }

  if (!apply) {
    console.log(`This will LIVE-WRITE ${ext}'s stored extractions to its linked Rolldog opportunity.`);
    console.log(`Preview the exact payload first:`);
    console.log(`  npx tsx scripts/preview-writeback.ts --deal ${ext} --real`);
    console.log(`Then re-run with --apply to write.`);
    return;
  }

  const res = await writeBackDealToRolldog("magaya", ext);
  if (res.written) {
    console.log(`WROTE to Rolldog opp ${res.opportunityId}:`);
    for (const r of res.results ?? []) {
      if (r.status === "skipped") continue;
      console.log(`  ${r.method}  [${r.status}]  fields: ${r.fieldsWritten.join(", ")}`);
      if (r.status === "error" && r.error) {
        console.log(`      error: ${r.error}`);
      }
    }
    console.log(`\nCheck the opp in Rolldog to confirm the values landed.`);
  } else {
    console.log(`Not written: ${res.reason}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
