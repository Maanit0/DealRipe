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
 *   npx tsx scripts/test-send-report.ts --to mark@...,mitch@... --bcc you@... --live
 *   npx tsx scripts/test-send-report.ts --to mark@... --bcc you@... --live --at 06:05
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
  // COMMA-SEPARATED, because the real recipients are a group. Sending to one
  // person and hiding the rest in bcc is a different message: it tells Mark he
  // is the only reader, and it stops Mitch and Eduardo replying to each other.
  const to = list(arg("--to"));
  if (to.length === 0 || to.some((a) => !a.includes("@"))) {
    console.error("\nUsage: --to a@example.com,b@example.com\nNo default recipient: this sends real mail.\n");
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

  // --at 06:05 schedules for the NEXT occurrence of that Central time, so the
  // report can be built tonight and land in the morning. Central because that is
  // where Magaya works and where the digest is timed; see lib/graph-time.ts for
  // why no time here is ever left to the sender's own locale.
  const at = arg("--at");
  let scheduledAt: string | undefined;
  if (at) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
    if (!m) {
      console.error(`\n  --at must look like 06:05 (Central). Got "${at}".\n`);
      process.exit(1);
    }
    const [, hh, mm] = m;
    // Build the instant by asking what UTC offset Central is on right now, so
    // this stays correct across the November DST change rather than assuming -5.
    const probe = new Date();
    const offsetMin =
      (Date.parse(`${probe.toLocaleString("sv-SE", { timeZone: "America/Chicago" })}Z`) - probe.setMilliseconds(0)) /
      60000;
    const target = new Date();
    target.setUTCHours(Number(hh) - offsetMin / 60, Number(mm), 0, 0);
    if (target.getTime() <= Date.now()) target.setUTCDate(target.getUTCDate() + 1);
    scheduledAt = target.toISOString();
    console.log(`  Scheduled for ${target.toLocaleString("en-US", { timeZone: "America/Chicago" })} Central.`);
  }
  const res = await sendEmail({
    to,
    ...(bcc.length > 0 ? { bcc } : {}),
    // --live drops the [TEST] prefix. Off by default so a rehearsal send can
    // never be mistaken for the real Monday report by whoever receives it.
    subject: live ? report.subject : `[TEST] ${report.subject}`,
    ...(scheduledAt ? { scheduledAt } : {}),
    html: report.html,
    text: `${report.subject}. ${report.counts.silent} gone silent, ${report.counts.moving} moving. The PDF is attached.`,
    attachments: [{ filename: "DealRipe-pipeline-review.pdf", content: pdf.toString("base64") }],
  });

  // Deliberately NOT recorded in sent_messages. That table is the audit trail of
  // what customers and reps were actually sent, and a test to your own inbox is
  // not that. Polluting it would make the coverage views lie.
  console.log(
    `\n  Sent to ${to.join(", ")}${bcc.length ? ` (bcc ${bcc.join(", ")})` : ""} (resend id ${res.id}), PDF attached.` +
      ` Not recorded in sent_messages.\n`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
