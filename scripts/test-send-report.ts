/**
 * Send the pipeline review to ONE address, with the PDF attached, to see what
 * it looks like in a real inbox.
 *
 * This is the artifact Mark receives on a Monday: the HTML in the body and the
 * PDF attached. Reviewing it in Chrome is not the same test, which is the whole
 * reason the PDF exists.
 *
 * REQUIRES --to. There is no default recipient on purpose: a test-send script
 * that quietly emails the pilot's CRO because someone forgot a flag is a
 * mistake you only get to make once.
 *
 *   npx tsx scripts/test-send-report.ts --to you@example.com
 *   npx tsx scripts/test-send-report.ts --to mark@... --bcc you@... --live
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildActivityReport } from "../lib/activity-report";
import { sendEmail } from "../lib/mailer";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function list(v: string | undefined): string[] {
  return (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const to = (arg("--to") ?? "").trim();
  if (!to || !to.includes("@")) {
    console.error("\nUsage: --to you@example.com\nNo default recipient: this sends real mail.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  console.log(`\n  Building the report. This runs the same builder the cron does.`);
  const report = await buildActivityReport({ tenantId, readOnly: true });

  mkdirSync(".previews", { recursive: true });
  const htmlPath = resolve(".previews/monday-activity.html");
  const pdfPath = resolve(".previews/monday-activity.pdf");
  writeFileSync(htmlPath, report.html, "utf8");

  await new Promise<void>((done, fail) => {
    execFile(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ["--headless", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`, `file://${htmlPath}`],
      (err) => (err ? fail(err) : done()),
    );
  });

  const pdf = readFileSync(pdfPath);
  console.log(`  PDF is ${Math.round(pdf.length / 1024)}KB.`);

  const bcc = list(arg("--bcc"));
  const live = process.argv.includes("--live");
  const res = await sendEmail({
    to: [to],
    ...(bcc.length > 0 ? { bcc } : {}),
    // --live drops the [TEST] prefix. Off by default so a rehearsal send can
    // never be mistaken for the real Monday report by whoever receives it.
    subject: live ? report.subject : `[TEST] ${report.subject}`,
    html: report.html,
    text: `${report.subject}. ${report.counts.silent} gone silent, ${report.counts.moving} moving. The PDF is attached.`,
    attachments: [{ filename: "DealRipe-pipeline-review.pdf", content: pdf.toString("base64") }],
  });

  // Deliberately NOT recorded in sent_messages. That table is the audit trail of
  // what customers and reps were actually sent, and a test to your own inbox is
  // not that. Polluting it would make the coverage views lie.
  console.log(
    `\n  Sent to ${to}${bcc.length ? ` (bcc ${bcc.join(", ")})` : ""} (resend id ${res.id}), PDF attached.` +
      ` Not recorded in sent_messages.\n`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
