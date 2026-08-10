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

import { attachDoThis } from "../lib/digest-synthesis";
import { renderPipelineDigestEmail } from "../lib/emails/weekly-digest";
import { getPipelineChanges } from "../lib/pipeline-changes";
import { recordAllDealSnapshots } from "../lib/snapshot";
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

  if (!skipSnapshot) {
    try {
      const snapped = await recordAllDealSnapshots(tenantId);
      console.log(`refreshed ${snapped} snapshots (the cron does this too)`);
    } catch (e) {
      console.error(`snapshot refresh failed, continuing: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const untilIso = new Date().toISOString();
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const pc = await getPipelineChanges(tenantId, { sinceIso, untilIso });
  await attachDoThis(pc.deals);

  const weekLabel = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "America/Chicago",
  });

  const email = renderPipelineDigestEmail({
    pc,
    weekLabel,
    recipientName: process.env.DIGEST_TO_NAME ?? "Mark Buman",
    baseUrl: process.env.DEALRIPE_APP_URL,
  });

  writeFileSync(outPath, email.html, "utf8");

  const to = (process.env.DIGEST_TO ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const bcc = (process.env.DIGEST_BCC ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);

  console.log("");
  console.log(`Subject:   ${email.subject}`);
  console.log(`Window:    last ${days} days`);
  console.log(`To:        ${to.join(", ") || "(DIGEST_TO not set, the cron would send nothing)"}`);
  console.log(`Bcc:       ${bcc.join(", ") || "(none)"}`);
  console.log("");
  console.log(`Deals:            ${pc.deals.length}`);
  console.log(`Needing attention:${String(pc.headline.dealsNeedingAttention).padStart(4)}`);
  console.log(`Changed:          ${String(pc.headline.dealsChanged).padStart(4)}`);
  console.log("");
  console.log(`Written to ${outPath}. This is byte-for-byte what the cron renders.`);
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
