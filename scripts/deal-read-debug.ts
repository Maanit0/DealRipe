/**
 * Prints, per deal, exactly what DealRipe has captured vs what's still open, so
 * you can verify whether "the economic buyer" really is the only gap on a deal
 * or whether more context exists that the read should surface.
 *
 * Reads live Rolldog/Supabase (runs on your Mac, not the sandbox). Sends nothing.
 *
 *   npx tsx scripts/deal-read-debug.ts            # this week
 *   npx tsx scripts/deal-read-debug.ts --days 90  # wider window
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getPipelineChanges } from "../lib/pipeline-changes";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? "7");
  const tenantId = await resolveTenantId("magaya");
  const untilIso = new Date().toISOString();
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const pc = await getPipelineChanges(tenantId, { sinceIso, untilIso });

  const master = pc.deals
    .filter((d) => d.inRolldog || d.blockers.length > 0 || d.whatChanged.length > 0 || d.isNoShow)
    .sort((a, b) => (b.dealSizeMonthly ?? 0) - (a.dealSizeMonthly ?? 0));

  console.log(`\nDeal read debug, last ${days} days — ${master.length} deals\n`);
  for (const d of master) {
    console.log(`\n=== ${d.account}  [${d.dealHealth}]  ${d.stageName ?? "—"} · rep ${d.forecastCategory ?? "—"} / DealRipe ${d.dealRipeCategory ?? "—"}`);
    console.log(`  captured (full current state): ${d.captured.length ? "" : "(none)"}`);
    for (const c of d.captured) console.log(`    - ${c.label}: ${c.value}`);
    console.log(`  missing: ${d.missing.join(", ") || "(none)"}`);
    console.log(`  blockers: ${d.blockers.length ? "" : "(none)"}`);
    for (const b of d.blockers) console.log(`    - ${b}`);
    console.log(`  whatChanged this window: ${d.whatChanged.length ? "" : "(none)"}`);
    for (const w of d.whatChanged) console.log(`    - ${w.label ? w.label + ": " : ""}${w.text} [${w.tone}]`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
