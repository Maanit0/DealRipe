/**
 * Send a DealRipe weekly digest email to a sales leader, through the same
 * Resend sender as the recaps and briefings. Reads the digest HTML from a file
 * so you can eyeball and edit it before it goes.
 *
 * Safe by default: previews unless you pass --send.
 *
 *   npx tsx scripts/send-digest.ts --to mark@example.com                 # preview only
 *   npx tsx scripts/send-digest.ts --to mark@example.com --send          # actually send
 *   npx tsx scripts/send-digest.ts --to mark@example.com --reply-to you@example.com --send
 *
 * Options:
 *   --to        recipient (required)
 *   --html      path to the digest HTML (default ../digest-preview-jul20.html)
 *   --subject   override the subject line
 *   --reply-to  replies go here (recommend your own email)
 *   --send      actually send (otherwise it only previews)
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";

import { sendEmail } from "../lib/mailer";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const to = arg("--to");
  const htmlPath = arg("--html") ?? "../digest-preview-jul20.html";
  const subject = arg("--subject") ?? "DealRipe weekly digest, week of July 20";
  const replyTo = arg("--reply-to");
  const send = process.argv.includes("--send");

  if (!to) {
    console.error("Usage: --to <email> [--html <path>] [--subject <s>] [--reply-to <email>] [--send]");
    process.exit(1);
  }

  const html = readFileSync(htmlPath, "utf8");
  // Plain-text fallback: strip tags, collapse whitespace.
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&middot;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  console.log(`to:        ${to}`);
  console.log(`subject:   ${subject}`);
  console.log(`html:      ${htmlPath} (${html.length} chars)`);
  console.log(`reply-to:  ${replyTo ?? "(none)"}`);

  if (!send) {
    console.log("\nPREVIEW ONLY. Re-run with --send to actually email it.");
    return;
  }

  const res = await sendEmail({ to, subject, html, text, ...(replyTo ? { replyTo } : {}) });
  console.log(`\nSent. Resend id: ${res.id}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
