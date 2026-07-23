/**
 * Preview Mark's pipeline-changes digest + dashboard data without sending or
 * deploying. Runs the same engine the /review page and the Monday cron use, over
 * a trailing window, prints the headline and every flagged deal, and writes the
 * digest email HTML to .previews/ so you can open it in a browser.
 *
 * Reads live Rolldog (runs on your Mac, not the sandbox). Sends nothing.
 *
 *   npx tsx scripts/preview-pipeline-digest.ts            # last 7 days
 *   npx tsx scripts/preview-pipeline-digest.ts --days 14
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";

import { attachDoThis } from "../lib/digest-synthesis";
import { renderPipelineDigestEmail } from "../lib/emails/weekly-digest";
import { getPipelineChanges } from "../lib/pipeline-changes";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? "7");
  const tenantId = await resolveTenantId("magaya");
  const untilIso = new Date().toISOString();
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const pc = await getPipelineChanges(tenantId, { sinceIso, untilIso });
  await attachDoThis(pc.deals);
  const h = pc.headline;

  console.log(`\nPipeline changes, last ${days} days\n`);
  console.log(`Pipeline ${money(h.totalPipelineAnnual)} (annualized) · ${h.dealsChanged} changed · ${h.dealsNeedingAttention} to look at · won/lost ${h.closedWon}/${h.closedLost} · ${h.newOpportunities} new`);
  console.log(`Forecast mix: ${h.forecastMix.map((b) => `${b.category} ${b.deals}/${money(b.annual)}`).join(", ") || "—"}`);

  console.log(`\nDEALS TO LOOK AT:`);
  const attn = pc.deals.filter((d) => d.needsAttention);
  if (attn.length === 0) console.log("  (none)");
  for (const d of attn) {
    console.log(`\n  ${d.account}  [attn ${d.attention}]  ${d.stageName ?? "—"} · ${d.forecastCategory ?? "—"} · closes ${d.closeDate?.slice(0, 10) ?? "—"} · ${d.dealSizeAnnual ? money(d.dealSizeAnnual) + "/yr" : "size —"}${d.score ? ` · score ${d.score}` : ""}${d.isRenewal ? " · RENEWAL" : ""}`);
    console.log(`    moved (${d.movement.direction}): ${d.movement.summary}`);
    for (const w of d.whatChanged) console.log(`      • [${w.tone}] ${w.text}`);
    if (d.agreedNextStep) console.log(`    agreed: ${d.agreedNextStep}`);
    for (const f of d.flags) console.log(`    [${f.severity}] ${f.text}`);
    if (d.doThis) console.log(`    do: ${d.doThis}`);
  }

  const email = renderPipelineDigestEmail({ pc, weekLabel: "preview", recipientName: "Mark Buman", baseUrl: process.env.DEALRIPE_APP_URL });
  mkdirSync(".previews", { recursive: true });
  writeFileSync(".previews/pipeline-digest.html", email.html);
  console.log(`\nSubject: ${email.subject}`);
  console.log(`Wrote .previews/pipeline-digest.html — open it in a browser to see the email.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
