/**
 * Read-only preview of the inverted deal -> Rolldog opportunity matcher. Prints,
 * for each unlinked captured deal, whether it CONFIRMS to a recent rep-owned opp,
 * needs REVIEW (ambiguous / old), or has no match yet. Nothing is linked or written.
 *
 * Run on your Mac:  npx tsx scripts/rolldog-newlink-preview.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { findLinkMatches } from "../lib/rolldog-reconcile";

function d(iso: string | null): string {
  if (!iso) return "?";
  try { return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch { return "?"; }
}

async function main(): Promise<void> {
  const matches = await findLinkMatches("magaya");
  let confirmed = 0, review = 0, none = 0;
  console.log(`\nUnlinked captured deals: ${matches.length}\n`);

  for (const m of matches) {
    if (m.status === "confirmed" && m.opp) {
      confirmed++;
      console.log(`✓ CONFIRMED  ${m.account}  (${m.rep})`);
      console.log(`    -> opp ${m.opp.id}  "${m.opp.accountName}"  stage=${m.opp.stageName ?? "?"}  created=${d(m.opp.createdAt)}`);
    } else if (m.status === "review") {
      review++;
      console.log(`? REVIEW     ${m.account}  (${m.rep})  ${m.note ?? ""}  ${m.candidates?.length ?? 0} candidate(s)`);
      for (const o of m.candidates ?? []) console.log(`    opp ${o.id}  "${o.accountName}"  stage=${o.stageName ?? "?"}  created=${d(o.createdAt)}`);
    } else {
      none++;
      console.log(`·  no match   ${m.account}  (${m.rep})  ${m.note ?? "(no rep-owned opp matches yet)"}`);
    }
    console.log("");
  }
  console.log(`Summary: ${confirmed} confirmed, ${review} review, ${none} no match yet.`);
  console.log(`(Read-only. Nothing linked or written. Run scripts/rolldog-relink.ts --commit to link confirmed ones.)\n`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
