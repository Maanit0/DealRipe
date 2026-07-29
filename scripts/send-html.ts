/**
 * Send an HTML file as an email via the Resend sender (lib/mailer).
 *
 *   npx tsx scripts/send-html.ts --file ../pipeline_recap_for_mark.html \
 *       --to mbuman@magaya.com --subject "Recap: net-new pipeline review (July 28)" \
 *       --bcc maanits@berkeley.edu
 *
 * --reply-to defaults to maanits@berkeley.edu so replies come to you, not the
 * no-reply sender. Runs on your Mac with .env.local (needs RESEND_API_KEY + MAIL_FROM).
 *
 * Note: the send.dealripe.com sender is not yet on Magaya's allowlist for Mark's
 * mailbox, so this can land in his junk. For a buyer-facing send you may prefer to
 * paste the HTML from your own email client instead.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sendEmail } from "../lib/mailer";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const file = arg("--file");
  const to = arg("--to");
  const subject = arg("--subject");
  if (!file || !to || !subject) {
    console.error('Usage: --file <path.html> --to <email> --subject "<subject>" [--bcc <email>] [--reply-to <email>]');
    process.exit(1);
  }

  const html = readFileSync(resolve(process.cwd(), file), "utf8");
  const replyTo = arg("--reply-to") ?? "maanits@berkeley.edu";
  const bcc = arg("--bcc");
  const text =
    "This recap is best viewed as HTML. Open it in an email client that renders HTML to see the full layout.";

  const res = await sendEmail({
    to,
    subject,
    html,
    text,
    replyTo,
    ...(bcc ? { bcc } : {}),
  });
  console.log(
    `Sent "${subject}" to ${to} via the Resend sender (id ${res.id}). Reply-to ${replyTo}${bcc ? `, bcc ${bcc}` : ""}.`,
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
