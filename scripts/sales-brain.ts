/**
 * What the book actually says about each qualification gate.
 *
 *   npx tsx scripts/sales-brain.ts
 *
 * READ ONLY. Imports lib/sales-brain.ts rather than restating the arithmetic,
 * so this cannot disagree with what a briefing would be told.
 *
 * Expect most gates to report "insufficient". That is the correct output at
 * this sample size and it is the point: a brain that only ever produces
 * encouraging findings is a marketing asset, not a learning system.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { computeGatePriors, priorLine, MIN_N } from "../lib/sales-brain";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const priors = await computeGatePriors(tenantId);

  console.log(`\n  OUR EXTRACTOR (tautology risk)          |  NEXT MEETING BOOKED (independent)`);
  console.log(`  gate                            n   followed  adv|ask adv|not  lift  |  mtg|ask mtg|not  lift`);
  console.log("  " + "-".repeat(94));
  const pct = (x: number | null) => (x === null ? "   -" : `${String(Math.round(x * 100)).padStart(3)}%`);
  for (const p of priors) {
    console.log(
      `  ${p.gate.padEnd(30)} ${String(p.n).padStart(3)}  ${String(p.followed).padStart(7)}` +
        `   ${pct(p.advancedWhenFollowed)}   ${pct(p.advancedWhenNot)} ${p.lift === null ? "    -" : `${p.lift >= 0 ? "+" : ""}${Math.round(p.lift * 100)}%`.padStart(5)}  |  ${pct(p.meetingWhenFollowed)}   ${pct(p.meetingWhenNot)}  ${p.meetingLift === null ? "    -" : `${p.meetingLift >= 0 ? "+" : ""}${Math.round(p.meetingLift * 100)}%`.padStart(5)}`,
    );
  }

  const usable = priors.filter((p) => p.verdict !== "insufficient");
  console.log(`\n  gates with enough evidence to say anything (n >= ${MIN_N}, both arms): ${usable.length} of ${priors.length}`);
  console.log("\n  WHAT A BRIEFING WOULD BE TOLD:\n");
  for (const p of usable) {
    const line = priorLine(p);
    if (line) console.log(`    ${p.gate}\n      ${line}\n`);
  }
  if (usable.length === 0) console.log("    Nothing. That is an honest answer, not a failure.\n");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
