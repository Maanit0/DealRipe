/**
 * What moved the forecast this week, who moved it, and whether the calls agree.
 *
 *   npx tsx scripts/forecast-why.ts                last 7 days
 *   npx tsx scripts/forecast-why.ts --days 14
 *   npx tsx scripts/forecast-why.ts --weakening    only what took the number down
 *
 * Read-only. Imports lib/forecast-why.ts, which the page will use, so this
 * cannot disagree with what a leader sees on screen.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getForecastWhy } from "../lib/forecast-why";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const MARK = { supports: "agrees", contradicts: "DISAGREES", no_evidence: "no evidence" } as const;

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 7);
  const onlyWeakening = process.argv.includes("--weakening");
  const tenantId = await resolveTenantId("magaya");

  const why = await getForecastWhy({
    tenantId,
    sinceIso: new Date(Date.now() - days * 86_400_000).toISOString(),
  });

  console.log(`\n${"=".repeat(84)}`);
  console.log(`WHY THE FORECAST MOVED, last ${days} days`);
  console.log(`${"=".repeat(84)}`);

  if (why.unavailable) {
    console.log(`\n  Salesforce could not be read: ${why.unavailable}`);
    console.log(`  This is "we did not look", not "nothing changed".\n`);
    return;
  }

  const rows = onlyWeakening ? why.changes.filter((c) => c.direction === "weakens") : why.changes;
  const weak = why.changes.filter((c) => c.direction === "weakens").length;
  console.log(`\n  ${why.changes.length} change(s) on tracked deals. ${weak} took the number down.`);
  if (why.unattributed > 0) {
    console.log(`  ${why.unattributed} more happened on Salesforce accounts no DealRipe deal is linked to.`);
  }

  let lastAccount = "";
  for (const c of rows) {
    if (c.account !== lastAccount) {
      console.log(`\n${"-".repeat(84)}`);
      console.log(`${c.account}`);
      lastAccount = c.account;
    }
    const arrow = c.direction === "weakens" ? "DOWN" : c.direction === "strengthens" ? "UP  " : "--  ";
    console.log(`  ${arrow} ${c.at.slice(0, 10)}  ${c.headline}`);
    console.log(`         DealRipe ${MARK[c.evidence.verdict]}: ${c.evidence.text}`);
  }

  console.log(`\n${"=".repeat(84)}\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
