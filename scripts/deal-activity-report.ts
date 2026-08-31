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
import { resolve } from "node:path";

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

  // THE PDF IS THE DELIVERABLE, so it is produced here rather than by someone
  // remembering to hit Cmd-P. Mark receives this as a PDF every Monday, and a
  // report that only looks right in a browser is not the artifact he gets.
  // Headless Chrome, the same engine the manual print used, so what is checked
  // is what ships.
  const pdf = resolve(".previews/monday-activity.pdf");
  await new Promise<void>((done) => {
    execFile(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      [
        "--headless",
        "--disable-gpu",
        "--no-pdf-header-footer",
        `--print-to-pdf=${pdf}`,
        `file://${resolve(out)}`,
      ],
      (err) => {
        if (err) console.error(`  PDF generation failed: ${err.message}`);
        else console.log(`  wrote ${pdf}`);
        done();
      },
    );
  });
  console.log(`\n  subject: ${report.subject}`);
  console.log(
    `  ${report.counts.total} deals: ${report.counts.moving} moving, ${report.counts.notMoving} active not moving, ${report.counts.stalled} stalled, ${report.counts.silent} gone silent, ${report.counts.never} never engaged`,
  );
  console.log(`  wrote ${out}\n`);
  execFile("open", [out], () => {});
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
