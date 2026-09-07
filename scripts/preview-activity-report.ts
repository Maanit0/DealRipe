/**
 * Render the Monday pipeline review to .previews/ and print what it contains.
 *
 * The same builder the cron calls, and the same Chrome print the PDF comes
 * from, with NO send path anywhere in this file. scripts/test-send-report.ts
 * can do this too, but it requires --to and sends real mail, so it is the wrong
 * tool for "let me read Monday's report before it goes out" and reaching for it
 * on a Sunday night is how a rehearsal reaches a customer's CRO.
 *
 *   npx tsx scripts/preview-activity-report.ts
 *   npx tsx scripts/preview-activity-report.ts --no-pdf
 *
 * Read only. buildActivityReport is called with readOnly, so nothing is
 * recorded as sent and no snapshot is written.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { buildActivityReport } from "../lib/activity-report";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  console.log("\n  Building the pipeline review. Same builder as the cron.\n");
  const generate = process.argv.includes("--generate");
  const report = await buildActivityReport({ tenantId, readOnly: !generate });

  mkdirSync(".previews", { recursive: true });
  const htmlPath = resolve(".previews/monday-activity.html");
  writeFileSync(htmlPath, report.html, "utf8");
  console.log(`  Subject:  ${report.subject}`);
  console.log(`  HTML:     ${htmlPath}`);

  if (!process.argv.includes("--no-pdf")) {
    const pdfPath = resolve(".previews/monday-activity.pdf");
    await new Promise<void>((done, fail) => {
      execFile(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ["--headless", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`],
        (err) => (err ? fail(err) : done()),
      );
    });
    console.log(`  PDF:      ${pdfPath} (${Math.round(statSync(pdfPath).size / 1024)}KB)`);
  }

  // Whatever counts the builder chose to expose. Printed rather than assumed,
  // so a section that came back empty is visible here instead of in the inbox.
  const counts = (report as unknown as { counts?: Record<string, unknown> }).counts;
  if (counts) {
    console.log("");
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(22)} ${String(v)}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
