/**
 * Preview the pipeline digest exactly as tomorrow's cron will render it, WITHOUT
 * sending it. Builds the same email (getPipelineChanges + renderPipelineDigestEmail)
 * and writes it to digest-preview.html so you can open it in a browser first.
 *
 *   npx tsx scripts/preview-digest.ts            # read-only: current data
 *   npx tsx scripts/preview-digest.ts --snapshot # refresh snapshots first, like the real send
 *
 * Read-only by default (no writes). Pass --snapshot to run the same
 * snapshot-before-digest step the cron does, so the preview reflects the live
 * Rolldog state and any rep category move shows the "moved from X to Y" line.
 *
 * Runs on your Mac with .env.local (needs Rolldog + Supabase access).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { attachDoThis } from "../lib/digest-synthesis";
import { renderPipelineDigestEmail } from "../lib/emails/weekly-digest";
import { getPipelineChanges } from "../lib/pipeline-changes";
import { recordAllDealSnapshots } from "../lib/snapshot";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const withSnapshot = process.argv.includes("--snapshot");
  const tenantId = await resolveTenantId("magaya");

  if (withSnapshot) {
    const n = await recordAllDealSnapshots(tenantId);
    console.log(`Refreshed ${n} snapshots (matches the real send).`);
  }

  // Same window the cron uses: trailing 7 days.
  const untilIso = new Date().toISOString();
  const sinceIso = new Date(Date.now() - 7 * 86_400_000).toISOString();
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

  const out = resolve(process.cwd(), "digest-preview.html");
  writeFileSync(out, email.html);

  const moves = pc.deals.filter((d) =>
    d.changes.some((c) => c.kind === "forecast" && c.from && c.to && c.from !== c.to),
  );
  const toList = (process.env.DIGEST_TO ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const bccList = (process.env.DIGEST_BCC ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  console.log(`\nSubject: ${email.subject}`);
  console.log(`To (env DIGEST_TO): ${toList.length ? toList.join(", ") : "(unset — real send would skip)"}`);
  console.log(`Bcc (env DIGEST_BCC): ${bccList.length ? bccList.join(", ") : "(none)"}`);
  console.log(`Deals to look at: ${pc.headline.dealsNeedingAttention}  |  changed: ${pc.headline.dealsChanged}`);
  if (moves.length) {
    console.log("Rep category moves this week:");
    for (const d of moves) {
      const m = d.changes.find((c) => c.kind === "forecast" && c.from && c.to && c.from !== c.to)!;
      console.log(`  - ${d.account}: ${d.repName} moved ${m.from} -> ${m.to}`);
    }
  } else {
    console.log("Rep category moves this week: none in the window.");
  }
  console.log(`\nWrote ${out}\nOpen it in a browser to preview the exact email.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
