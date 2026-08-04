/**
 * List a rep's Rolldog opportunities created around a date, so a proposed
 * deal-to-opportunity link can be checked rather than assumed.
 *
 * Reconciliation auto-links on account-name match, which means naming a
 * DealRipe deal after a Rolldog opportunity FORCES that link. If the guess is
 * wrong, one customer's budget, timeline and stakeholders get written onto a
 * different customer's opportunity, and there is no undo. So the name should be
 * verified, not reverse-engineered from a three-letter prefix.
 *
 * This shows every candidate in a date window, which answers two questions:
 * whether the opportunity you have in mind is even the only one created that
 * day, and whether its account-name reads like the company on the call.
 *
 *   npx tsx scripts/rolldog-opps-around.ts --uid 82 --date 2026-07-22
 *   npx tsx scripts/rolldog-opps-around.ts --uid 82 --date 2026-07-22 --window 5
 *   npx tsx scripts/rolldog-opps-around.ts --uid 82 --grep guy
 *
 * READ ONLY: lists opportunity metadata, never reads a sub-resource and never
 * writes. Run on your Mac.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { listOpportunities, type OppSummary } from "../lib/rolldog";
import { REP_UID } from "../lib/rolldog-reconcile";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const uid = arg("--uid");
  const date = arg("--date");
  const grep = (arg("--grep") ?? "").toLowerCase();
  const windowDays = Number(arg("--window") ?? 3);

  if (!uid) {
    console.error(`Usage: --uid <rolldog-user-id> [--date YYYY-MM-DD] [--window 3] [--grep text]`);
    console.error(`Known: ${Object.entries(REP_UID).map(([e, i]) => `${e}=${i}`).join(", ")}`);
    process.exit(1);
  }

  const all: OppSummary[] = [];
  for (let page = 1; page <= 5; page++) {
    const rows = await listOpportunities(
      `filter[user-id]=${uid}&sort=-created-at&page[size]=200&page[number]=${page}`,
    );
    if (rows.length === 0) break;
    all.push(...rows);
    if (rows.length < 200) break;
  }

  let rows = all;
  if (date) {
    const centre = Date.parse(`${date}T00:00:00Z`);
    const span = windowDays * 86_400_000;
    rows = rows.filter((o) => {
      if (!o.createdAt) return false;
      return Math.abs(Date.parse(o.createdAt) - centre) <= span;
    });
  }
  if (grep) {
    rows = rows.filter(
      (o) => o.name.toLowerCase().includes(grep) || o.accountName.toLowerCase().includes(grep),
    );
  }

  console.log(`\nuser-id ${uid}  ยท  ${all.length} opportunities scanned  ยท  ${rows.length} match\n`);
  if (rows.length === 0) {
    console.log("Nothing matched. Widen --window, or drop --date and use --grep.\n");
    return;
  }

  for (const o of rows.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))) {
    console.log(`${(o.createdAt ?? "").slice(0, 10)}  opp ${o.id}`);
    console.log(`    name:     ${o.name}`);
    console.log(`    account:  ${o.accountName}`);
    console.log(`    stage:    ${o.stageName ?? "(none)"}${o.archived ? "   [ARCHIVED]" : ""}`);
    console.log("");
  }

  if (date && rows.length > 1) {
    console.log(`${rows.length} opportunities were created within ${windowDays} day(s) of ${date}.`);
    console.log(`A date match alone does not identify one. Confirm with the rep or the BDR`);
    console.log(`who created it before naming a DealRipe deal to match.\n`);
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
