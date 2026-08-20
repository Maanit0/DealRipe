/**
 * Run the prescription scorer by hand.
 *
 *   npx tsx scripts/score-prescriptions.ts --dry-run
 *   npx tsx scripts/score-prescriptions.ts
 *   npx tsx scripts/score-prescriptions.ts --rep ebencomo@magaya.com
 *   npx tsx scripts/score-prescriptions.ts --rescore     # overwrites verdicts
 *   npx tsx scripts/score-prescriptions.ts --refresh-days 60
 *
 * --refresh-days widens the window in which an already-scored row has its
 * DETERMINISTIC outcomes recomputed. It defaults to OUTCOME_REFRESH_DAYS (21),
 * which is right for the cron: past that, a next meeting that has not been
 * booked is not going to be. It is the wrong default after the reader itself
 * changes. When outcome_qualification_advanced was added on 2026-08-20 the
 * pilot was 35 days old, so two thirds of the ledger sat outside the window
 * holding 'unknown' for rows whose answer was already in deal_signal_snapshots.
 *
 * It does NOT touch `followed`, which is the model's verdict on the rep. Only
 * the deterministic reads are recomputed, so widening it cannot change what a
 * rep is recorded as having done. Use --rescore for that, deliberately.
 *
 * Same entry point the cron route uses, so this cannot drift from production.
 *
 * --rescore re-decides rows that already carry a verdict. The only honest
 * reason to use it is that the scorer itself changed, and it should be run
 * deliberately: a verdict silently changing under a rep is as bad as a wrong
 * one. Set PRESCRIPTION_DEBUG=1 alongside it to see every quote the model
 * offered that could not be found in the transcript.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runPrescriptionScoring } from "../lib/prescription-scoring";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const dryRun = flag("--dry-run");
  const rescore = flag("--rescore");
  const rep = arg("--rep");
  const refreshRaw = arg("--refresh-days");
  const refreshDays = refreshRaw === undefined ? undefined : Number(refreshRaw);
  if (refreshDays !== undefined && (!Number.isFinite(refreshDays) || refreshDays <= 0)) {
    console.error(`--refresh-days must be a positive number, got "${refreshRaw}"`);
    process.exit(1);
  }

  console.log(
    `\n${dryRun ? "DRY RUN" : "SCORING"}${rescore ? ", rescoring rows that already have a verdict" : ""}` +
      `${refreshDays !== undefined ? `, refreshing outcomes back ${refreshDays} days` : ""}\n`,
  );

  const counts = await runPrescriptionScoring({
    tenantSlug: TENANT_SLUG,
    dryRun,
    rescore,
    // ScoringOptions takes an ISO floor, not a day count. The flag is in days
    // because that is how the window is reasoned about everywhere else
    // (OUTCOME_REFRESH_DAYS, OUTCOME_SETTLE_DAYS).
    since:
      refreshDays === undefined
        ? undefined
        : new Date(Date.now() - refreshDays * 86_400_000).toISOString(),
    repEmails: rep ? [rep] : undefined,
    onDecision: (d) => {
      if (d.kind === "scored") {
        console.log(
          `  scored    ${d.account.padEnd(24)} ${d.rows} row(s), ${d.followed} done, ${d.notFollowed} not`,
        );
      } else if (d.kind === "no-transcript") {
        console.log(
          `  ${d.retry ? "retry   " : "retired "}  ${d.account.padEnd(24)} ${d.rows} row(s): ${d.detail}`,
        );
      } else if (d.kind === "outcomes-only") {
        console.log(`  outcomes  ${d.account.padEnd(24)} ${d.detail}`);
      } else if (d.kind === "error") {
        console.log(`  ERROR     ${d.account.padEnd(24)} ${d.message}`);
      }
    },
  });

  console.log(`\n${JSON.stringify(counts, null, 2)}\n`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
