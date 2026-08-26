/**
 * Preview the Monday activity report exactly as it will be emailed.
 *
 * Renders through lib/activity-report.ts, the same function the cron calls, so
 * what you review here is what Mark receives.
 *
 *   npx tsx scripts/deal-activity-report.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

import { buildActivityReport } from "../lib/activity-report";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

(async () => {
  const tenantId = await resolveTenantId("magaya");
  const report = await buildActivityReport({
    tenantId,
    windowDays: Number(arg("--days") ?? 14),
    limit: arg("--limit") ? Number(arg("--limit")) : undefined,
    readOnly: process.argv.includes("--no-generate"),
  });
  mkdirSync(".previews", { recursive: true });
  const out = ".previews/monday-activity.html";
  writeFileSync(out, report.html, "utf8");
  console.log(`\n  subject: ${report.subject}`);
  console.log(
    `  ${report.counts.total} deals: ${report.counts.silent} quiet, ${report.counts.active} moving, ${report.counts.unknown} cannot tell`,
  );
  console.log(`  wrote ${out}\n`);
  execFile("open", [out], () => {});
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
