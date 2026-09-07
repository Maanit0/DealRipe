/**
 * Render exactly what the Tuesday 6am digest cron will send, and write it to a
 * file for review.
 *
 * Why this exists alongside scripts/generate-digest.ts: that script calls
 * renderWeeklyDigestEmail, an older and much thinner template, while the cron
 * calls renderPipelineDigestEmail. Previewing one and shipping the other means
 * the preview is worse than useless, because it looks like a regression that
 * has not actually happened. This script mirrors app/api/cron/digest/route.ts
 * step for step: same snapshot refresh, same 7-day window, same doThis
 * synthesis, same renderer, same arguments.
 *
 *   npx tsx scripts/preview-digest.ts
 *   npx tsx scripts/preview-digest.ts --days 14 --out ../digest-preview.html
 *   npx tsx scripts/preview-digest.ts --no-snapshot   # skip the snapshot write
 *
 * Sends nothing, ever. The only write it performs is the snapshot refresh the
 * cron also does, and --no-snapshot turns that off if you want it fully inert.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";

import { buildWeeklyDigest } from "../lib/digest-build";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 7);
  const outPath = arg("--out") ?? "digest-preview.html";
  const skipSnapshot = process.argv.includes("--no-snapshot");

  const tenantId = await resolveTenantId(TENANT_SLUG);

  // Identical sequence to app/api/cron/digest/route.ts, because it is the same
  // function. Ranking, flags, narratives, forecast-why and the doThis synthesis
  // all happen inside it.
  const { email, pc, why, priority, snapshot } = await buildWeeklyDigest({
    tenantId,
    days,
    recipientName: process.env.DIGEST_TO_NAME ?? "Mark Buman",
    baseUrl: process.env.DEALRIPE_APP_URL,
    refreshSnapshots: !skipSnapshot,
  });

  writeFileSync(outPath, email.html, "utf8");

  const to = (process.env.DIGEST_TO ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const bcc = (process.env.DIGEST_BCC ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);

  console.log("");
  console.log(`Subject:   ${email.subject}`);
  console.log(`Window:    last ${days} days`);
  console.log(`To:        ${to.join(", ") || "(DIGEST_TO not set, the cron would send nothing)"}`);
  console.log(`Bcc:       ${bcc.join(", ") || "(none)"}`);
  console.log(`Snapshot:  ${JSON.stringify(snapshot)}`);
  console.log("");
  console.log(`Deals:             ${pc.deals.length}`);
  console.log(`Needing attention: ${pc.headline.dealsNeedingAttention}`);
  console.log(`Changed:           ${pc.headline.dealsChanged}`);
  console.log(`Closed out:        ${pc.closedOut?.length ?? 0}`);
  console.log(`Printed (ranked):  ${priority.ranked.length}`);
  console.log(`Forecast changes:  ${why ? why.changes.length : "section unavailable"}`);
  console.log("");
  for (const r of priority.ranked) {
    const f = (r.flags ?? []).map((x) => `${x.id}(${x.severity})`).join(", ");
    console.log(`  ${(r.deal.account ?? "?").padEnd(24)} ${f || "(no flags)"}`);
  }
  console.log("");
  console.log(`Written to ${outPath}. Same builder the cron calls.`);
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
