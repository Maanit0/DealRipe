/**
 * Drive recap-sync by hand.
 *
 * The recap and the follow-up draft moved out of transcript-sync into their own
 * cron (see the header of lib/recap-sync.ts for the measurements that forced
 * it). Until that cron is deployed, NOTHING produces recaps: transcript-sync no
 * longer does it and the schedule does not exist yet. This is the stopgap, and
 * it is also the right tool to have permanently, because a cron you cannot run
 * by hand is a cron you cannot debug.
 *
 * Dry run by default. It lists what it would recap and sends nothing.
 *
 *   npx tsx scripts/run-recap-sync.ts                 # dry run
 *   npx tsx scripts/run-recap-sync.ts --apply         # SENDS email + drafts
 *   npx tsx scripts/run-recap-sync.ts --apply --limit 1
 *
 * --limit matters more than it looks. One Dunavant-sized recap takes about
 * three and a half minutes, so a backlog of six is a twenty minute run. Start
 * with --limit 1 and read what the rep actually received before letting it
 * work through the rest.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runRecapSync } from "../lib/recap-sync";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const limitRaw = arg("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  console.log(
    `\n${apply ? "APPLY: this emails reps and writes drafts into their Outlook." : "Dry run. Nothing is sent. Pass --apply to send."}`,
  );
  if (limit) console.log(`Limit: ${limit} call(s).`);
  console.log("");

  const counts = await runRecapSync({ dryRun: !apply, limit });

  console.log("\nSUMMARY");
  console.log(`   considered   ${counts.considered}`);
  console.log(`   recapped     ${counts.recapped}`);
  console.log(`   drafted      ${counts.drafted}`);
  console.log(`   skipped      ${counts.skipped}`);
  console.log(`   failed       ${counts.failed}`);
  console.log(`   deferred     ${counts.deferred}`);
  if (counts.deferred > 0) {
    console.log(
      `\n${counts.deferred} left for the next run because there was not enough time to finish them` +
        `\nsafely. They are untouched. Run again to continue.`,
    );
  }
  if (!apply && counts.recapped > 0) {
    console.log(`\nRe-run with --apply --limit 1 to send the first one and check it before the rest.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
