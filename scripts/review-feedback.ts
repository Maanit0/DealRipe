/**
 * What the reps said, and what it means.
 *
 *   npx tsx scripts/review-feedback.ts            dry run, marks nothing
 *   npx tsx scripts/review-feedback.ts --apply    marks each vote reviewed
 *
 * Dry run by default so the queue can be inspected before anything consumes it.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { reviewNewFeedback, worthReporting } from "../lib/feedback-watch";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const LABEL: Record<string, string> = {
  actionable: "FIXABLE NOW",
  needs_you: "YOUR CALL",
  not_the_artifact: "NOT THE WRITING",
  no_signal: "nothing to learn",
};

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = await resolveTenantId("magaya");
  const { diagnoses, errors } = await reviewNewFeedback({ tenantId, limit: 20, markReviewed: apply });

  console.log(`\nREP FEEDBACK  ${apply ? "(marking reviewed)" : "(dry run, marks nothing)"}\n`);
  // "None" and "could not look" are different answers and must not print the
  // same line. The read failing and there being nothing to read produce
  // identical empty arrays, which is this codebase's oldest bug.
  if (diagnoses.length === 0) {
    console.log(errors.length > 0 ? "  Could not read the queue. See the errors below.\n" : "  No unreviewed feedback.\n");
  }

  for (const d of diagnoses) {
    console.log(`${LABEL[d.verdict] ?? d.verdict}`);
    console.log(`  ${d.vote === "up" ? "thumbs up" : "thumbs down"} on the ${d.kind}${d.account ? `, ${d.account}` : ""}, by ${d.repEmail}`);
    console.log(`  note: ${d.note ?? "(none)"}`);
    for (const c of d.context) console.log(`  context: ${c}`);
    console.log(`  -> ${d.diagnosis}`);
    if (d.proposedChange) console.log(`  PROPOSED: ${d.proposedChange}`);
    if (d.wherePossibly) console.log(`  likely in: ${d.wherePossibly}`);
    console.log();
  }

  const report = diagnoses.filter(worthReporting);
  console.log(`  ${diagnoses.length} reviewed, ${report.length} worth acting on, ${errors.length} error(s)`);
  for (const e of errors) console.log(`   ! ${e}`);
  if (!apply && diagnoses.length > 0) console.log(`\n  Nothing was marked. Re-run with --apply to consume the queue.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
