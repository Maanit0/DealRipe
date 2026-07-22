/**
 * Controlled test of the Rolldog interactions-tab (activities) write. Prints the
 * exact payload by default (writes nothing). With --apply, creates ONE activity
 * on the given opportunity and prints the API response, so we can confirm it
 * lands in the interactions tab (or read the 422 that names a missing field).
 *
 *   npx tsx scripts/create-activity-test.ts --opp 82396            # dry: print payload
 *   npx tsx scripts/create-activity-test.ts --opp 82396 --apply    # ONE live create
 *
 * The opp must be in PILOT_OPPORTUNITY_IDS (scope guard). After verifying it in
 * Rolldog, delete the test activity from the interactions tab.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createActivity } from "../lib/rolldog";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const opp = arg("--opp");
  const apply = process.argv.includes("--apply");
  if (!opp) {
    console.error("Usage: --opp <opportunityId> [--apply]");
    process.exit(1);
  }

  const title = "Next step (DealRipe test): confirm the API activity write lands here";
  const notes = "This is a one-off test of DealRipe writing a next-action task to the interactions tab. Safe to delete.";

  console.log(`\nOpportunity: ${opp}`);
  console.log(`Mode:        ${apply ? "APPLY (one live create)" : "DRY (nothing written)"}`);
  console.log(`\nWould create activity:`);
  console.log(`  activities:  [DealRipe] ${title}`);
  console.log(`  notes:       ${notes}`);
  console.log(`  is-complete: false`);
  console.log(`  opportunity: ${opp}`);

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to create it once and inspect the result.`);
    return;
  }

  try {
    const result = await createActivity(opp, { title, notes });
    console.log(`\nCreated. API response:`);
    console.log(JSON.stringify(result, null, 2).slice(0, 2000));
    console.log(`\nCheck the interactions tab on opp ${opp} in Rolldog, then delete the test activity.`);
  } catch (err) {
    const anyErr = err as { status?: number; endpoint?: string; body?: unknown; message?: string };
    console.error(`\nCreate failed.`);
    console.error(`  message: ${anyErr.message}`);
    if (anyErr.status) console.error(`  status:  ${anyErr.status}`);
    if (anyErr.body) console.error(`  body:    ${JSON.stringify(anyErr.body, null, 2).slice(0, 1500)}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
