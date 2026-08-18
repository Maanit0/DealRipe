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
import { syncOutcomes } from "../lib/outcome-sync";
import { describeOutcome } from "../lib/salesforce-outcome";

async function main() {
  const apply = process.argv.includes("--apply");
  const tenant = "magaya";
  console.log(`outcome-sync tenant=${tenant} mode=${apply ? "APPLY (writes)" : "dry run"}\n`);

  const labelled: string[] = [];
  const other = new Map<string, number>();
  const counts = await syncOutcomes(tenant, {
    apply,
    onDeal: ({ account, outcome }) => {
      if (outcome.status === "won" || outcome.status === "lost") {
        labelled.push(`  ${account.padEnd(22)} ${describeOutcome(outcome)}`);
      } else {
        other.set(outcome.status, (other.get(outcome.status) ?? 0) + 1);
      }
    },
  });

  if (labelled.length) {
    console.log("Deals that would be labelled:" + (apply ? " (written)" : ""));
    console.log(labelled.sort().join("\n") + "\n");
  } else {
    console.log("No deal resolved to a won/lost outcome.\n");
  }
  console.log("Everything else:", [...other].map(([k, v]) => `${k}=${v}`).join("  ") || "none");
  console.log("\ncounts:", JSON.stringify(counts, null, 2));
  if (!apply) console.log("\nDry run. Nothing was written. Re-run with --apply.");
}
main().catch((e) => { console.error(e); process.exit(1); });
