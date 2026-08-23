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

import { attachFlags, rankForDigest } from "../lib/digest-priority";
import { attachDoThis } from "../lib/digest-synthesis";
import { renderPipelineDigestEmail } from "../lib/emails/weekly-digest";
import { getForecastWhy } from "../lib/forecast-why";
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

  // EXACTLY the cron's sequence, in the cron's order. This preview used to call
  // attachDoThis(pc.deals) and render without a priority, which is the digest as
  // it was BEFORE 2026-08-20: a different ranking, no DealRipe flags and no
  // going-quiet section. A preview that can disagree with production will, and
  // the whole point of opening it on a Sunday is to see what Mark gets Monday.
  // Mirrors app/api/cron/digest/route.ts.
  const why = await getForecastWhy({ tenantId, sinceIso, untilIso }).catch(() => null);
  const priority = rankForDigest(pc.deals);
  await attachFlags(priority, tenantId);
  await attachDoThis(priority.ranked.map((r) => r.deal), priority.ranked.length);
  const h = pc.headline;

  console.log(`\nPipeline changes, last ${days} days\n`);
  console.log(`Pipeline ${money(h.totalPipelineAnnual)} (annualized) · ${h.dealsChanged} changed · ${h.dealsNeedingAttention} to look at · won/lost ${h.closedWon}/${h.closedLost} · ${h.newOpportunities} new`);
  console.log(`Forecast mix: ${h.forecastMix.map((b) => `${b.category} ${b.deals}/${money(b.annual)}`).join(", ") || "—"}`);

  console.log(`\nDEALS MARK WILL READ, in the order he reads them:`);
  const attn = priority.ranked.map((r) => r.deal);
  if (attn.length === 0) console.log("  (none)");
  for (const [i, d] of attn.entries()) {
    console.log(`\n  ${i + 1}. why here: ${priority.ranked[i].because}`);
    console.log(`\n  ${d.account}  [attn ${d.attention}]  ${d.stageName ?? "—"} · ${d.forecastCategory ?? "—"} · closes ${d.closeDate?.slice(0, 10) ?? "—"} · ${d.dealSizeAnnual ? money(d.dealSizeAnnual) + "/yr" : "size —"}${d.score ? ` · score ${d.score}` : ""}${d.isRenewal ? " · RENEWAL" : ""}`);
    console.log(`    moved (${d.movement.direction}): ${d.movement.summary}`);
    for (const w of d.whatChanged) console.log(`      • [${w.tone}] ${w.text}`);
    if (d.agreedNextStep) console.log(`    agreed: ${d.agreedNextStep}`);
    for (const f of d.flags) console.log(`    [${f.severity}] ${f.text}`);
    for (const f of priority.ranked[i].flags.filter((x) => x.severity !== "watch")) {
      console.log(`    DEALRIPE [${f.severity}] ${f.title}`);
      console.log(`             ${f.evidence}`);
      console.log(`             -> ${f.move}`);
    }
    console.log(`    do: ${d.doThis ?? "(FALLBACK TEXT, no model action was written)"}`);
  }

  if (priority.goingDark.length > 0) {
    console.log(`\nGOING QUIET (${priority.goingDark.length}), their own section:`);
    for (const g of priority.goingDark) {
      console.log(`  ${g.daysQuiet === null ? "no record" : `${g.daysQuiet}d`}  ${g.deal.account}  ${g.deal.repName}`);
    }
  }
  console.log(
    `\n${priority.valueUnknown.printed} of the ${priority.ranked.length} printed have no Rolldog value ` +
      `(${priority.valueUnknown.all} across all attention deals). ${priority.belowTheFold} more are below the fold.`,
  );

  const email = renderPipelineDigestEmail({ pc, priority, why, weekLabel: "preview", recipientName: "Mark Buman", baseUrl: process.env.DEALRIPE_APP_URL });

  // The dash rule is enforced on delivery, so a preview that does not check it
  // hides the one lint failure Mark actually notices.
  const dashes = (email.html.match(/[\u2014\u2013]/g) ?? []).length + (email.text.match(/[\u2014\u2013]/g) ?? []).length;
  console.log(`\nem/en dashes in the rendered email: ${dashes}${dashes > 0 ? "   <-- FIX BEFORE MONDAY" : ""}`);
  mkdirSync(".previews", { recursive: true });
  writeFileSync(".previews/pipeline-digest.html", email.html);
  console.log(`\nSubject: ${email.subject}`);
  console.log(`Wrote .previews/pipeline-digest.html — open it in a browser to see the email.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
