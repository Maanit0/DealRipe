/**
 * Send the DealRipe welcome email to the reps joining the pilot.
 *
 * It must come from MAIL_FROM, the same address the briefings and recaps use.
 * Outlook's Safe Senders list works per address, so a welcome sent from a
 * personal account teaches the filter nothing about the emails that follow,
 * which is the entire reason this email exists.
 *
 * Preview by default. Writes an HTML file you can open, and prints the
 * recipients it would use. Nothing sends without --send.
 *
 *   npx tsx scripts/send-welcome.ts                    # preview to a file
 *   npx tsx scripts/send-welcome.ts --to you@x.com --send   # test on yourself
 *   npx tsx scripts/send-welcome.ts --send             # the real thing
 *
 * Send it 5 to 10 minutes before the onboarding call, not during. Waiting on
 * delivery with six people watching is a bad look, and DealRipe's mail has been
 * delayed into junk before.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";

import { renderWelcomeEmail } from "../lib/emails/welcome";
import { sendEmail } from "../lib/mailer";

/**
 * The four reps joining on Aug 10, plus Mitch.
 *
 * Juan and Eduardo are deliberately absent: they already marked DealRipe as a
 * safe sender, and re-sending would muddy the "did it arrive?" check on the
 * call. Mitch is included even though he is not connecting a calendar, because
 * he receives the Monday digest and needs the same safe-sender entry.
 */
const RECIPIENTS: ReadonlyArray<{ email: string; firstName: string; connects: boolean }> = [
  { email: "arodriguez@magaya.com", firstName: "Ariel", connects: true },
  { email: "dblitstein@magaya.com", firstName: "Daniel", connects: true },
  { email: "sjohnson@magaya.com", firstName: "Steven", connects: true },
  { email: "asuntrup@magaya.com", firstName: "Alexandra", connects: true },
  { email: "mnemmers@magaya.com", firstName: "Mitch", connects: false },
  // A copy for Maanit, so the send can be verified without waiting on someone
  // else to say "yes, got it". Note what this does and does not prove: it
  // confirms the mail left Resend and renders correctly. It says nothing about
  // whether Magaya's filter let the other five through, because berkeley.edu
  // never touches Barracuda. Only the reps can confirm that.
  { email: "maanits@berkeley.edu", firstName: "Maanit", connects: false },
];

const CONNECT_URL = process.env.WELCOME_CONNECT_URL ?? "https://app.dealripe.com/auth/microsoft/connect";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const doSend = process.argv.includes("--send");
  const only = arg("--to");
  const outPath = arg("--out") ?? "welcome-preview.html";

  const from = process.env.MAIL_FROM;
  if (!from) throw new Error('MAIL_FROM is not set. Expected something like "DealRipe <notify@send.dealripe.com>".');

  const fromAddress = from.match(/<([^>]+)>/)?.[1] ?? from;

  if (CONNECT_URL.includes("/callback")) {
    throw new Error("WELCOME_CONNECT_URL points at /callback. It must be /auth/microsoft/connect, the start of the flow.");
  }

  const targets = only
    ? [{ email: only, firstName: arg("--name") ?? "there", connects: true }]
    : RECIPIENTS;

  console.log("");
  console.log(`From:        ${from}`);
  console.log(`Connect URL: ${CONNECT_URL}`);
  console.log(`Recipients:  ${targets.length}`);
  for (const t of targets) console.log(`   ${t.firstName.padEnd(12)}${t.email}${t.connects ? "" : "   (digest only, no calendar)"}`);
  console.log("");

  if (!doSend) {
    const preview = renderWelcomeEmail({
      firstName: targets[0]?.firstName,
      fromAddress,
      connectUrl: CONNECT_URL,
    });
    writeFileSync(outPath, preview.html, "utf8");
    console.log(`Subject: ${preview.subject}`);
    console.log(`Preview written to ${outPath}. Open it, then re-run with --send.`);
    console.log("");
    return;
  }

  let sent = 0;
  for (const t of targets) {
    const email = renderWelcomeEmail({
      firstName: t.firstName,
      fromAddress,
      connectUrl: CONNECT_URL,
    });
    try {
      await sendEmail({
        to: t.email,
        subject: email.subject,
        html: email.html,
        text: email.text,
        replyTo: process.env.WELCOME_REPLY_TO,
      });
      sent += 1;
      console.log(`   sent to ${t.email}`);
    } catch (e) {
      console.error(`   FAILED ${t.email}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log("");
  console.log(`${sent} of ${targets.length} sent.`);
  console.log("On the call, confirm each person found it. Inbox, then Junk, then their");
  console.log("Barracuda quarantine digest. Anyone who finds it nowhere is the case that");
  console.log("needs Ernesto, and you want to know that while everyone is still on the line.");
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
