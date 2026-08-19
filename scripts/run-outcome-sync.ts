/**
 * Drive outcome-sync by hand. DRY RUN BY DEFAULT: pass --apply to write.
 *
 *   npx tsx scripts/run-outcome-sync.ts
 *   npx tsx scripts/run-outcome-sync.ts --apply
 *
 * Imports lib/outcome-sync.ts rather than restating its rules, per the standing
 * rule that a diagnostic which can disagree with production will.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { refillOutcomeDetail, syncOutcomes } from "../lib/outcome-sync";
import { describeOutcome } from "../lib/salesforce-outcome";

async function main() {
  const apply = process.argv.includes("--apply");

  if (process.argv.includes("--refill-detail")) {
    const r = await refillOutcomeDetail("magaya");
    if (r.columnsMissing) {
      console.log("Detail columns still missing. Run supabase/add-outcome-detail.sql first.");
      process.exitCode = 1;
      return;
    }
    console.log(`candidates ${r.candidates}, filled ${r.filled}, errors ${r.errors}`);
    for (const d of r.disagreed) {
      console.log(`  DISAGREES, left alone: ${d.account} stored=${d.stored} now=${d.resolved}`);
    }
    if (r.candidates === 0) console.log("Nothing to refill.");
    return;
  }

  const tenant = "magaya";
  console.log(`outcome-sync tenant=${tenant} mode=${apply ? "APPLY (writes)" : "dry run"}\n`);

  const written: string[] = [];
  const failed: string[] = [];
  const pending: string[] = [];
  const other = new Map<string, number>();
  const counts = await syncOutcomes(tenant, {
    apply,
    onDeal: ({ account, outcome, write }) => {
      if (outcome.status !== "won" && outcome.status !== "lost") {
        other.set(outcome.status, (other.get(outcome.status) ?? 0) + 1);
        return;
      }
      const line = `  ${account.padEnd(22)} ${describeOutcome(outcome)}`;
      if (write === "written") written.push(line);
      else if (write === "failed") failed.push(line);
      else pending.push(line);
    },
  });

  // Report what the DATABASE did, never what the verdict was. The first version
  // printed "(written)" off the outcome alone and said six deals were labelled
  // on a run where every write had failed.
  const show = (title: string, rows: string[]) => {
    if (!rows.length) return;
    console.log(title);
    console.log(rows.sort().join("\n") + "\n");
  };
  show("Labelled and WRITTEN:", written);
  show("Resolved but the write FAILED (nothing recorded):", failed);
  show("Would be labelled (dry run, nothing written):", pending);
  if (!written.length && !failed.length && !pending.length) {
    console.log("No deal resolved to a won/lost outcome.\n");
  }
  console.log("Everything else:", [...other].map(([k, v]) => `${k}=${v}`).join("  ") || "none");
  console.log("\ncounts:", JSON.stringify(counts, null, 2));
  if (!apply) console.log("\nDry run. Nothing was written. Re-run with --apply.");
  if (counts.detailColumnsMissing) {
    console.log(
      "\nLabels were written WITHOUT opportunity id, close date, loss reason or amount." +
      "\nRun supabase/add-outcome-detail.sql, then:" +
      "\n  npx tsx scripts/run-outcome-sync.ts --refill-detail",
    );
  }
  if (counts.errors > 0) {
    console.log(`\n${counts.errors} write(s) failed. Nothing was recorded for those deals.`);
    process.exitCode = 1;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
