/**
 * Local recap for the internal pipeline review, from a standalone bot.
 *
 * After the DealRipe Notetaker bot (see scripts/join-meeting.ts) has sat in the
 * pipeline review and the meeting has ended, this pulls that bot's transcript,
 * generates the internal-meeting recap (summary, key takeaways, next steps, NOT
 * qualification extraction and NOT any Rolldog write-back), renders the email,
 * writes an HTML preview, and emails it to YOU so you can review it and forward
 * it to Mark yourself.
 *
 * This is the human-gated test of the internal-join-and-recap flow on the real
 * meeting: nothing reaches Mark automatically, and nothing touches a deal.
 *
 *   npx tsx scripts/pipeline-recap.ts --bot <botId>
 *   npx tsx scripts/pipeline-recap.ts --bot <botId> --to you@email.com
 *   npx tsx scripts/pipeline-recap.ts --bot <botId> --no-send   # just write the HTML, don't email
 *
 * Run it AFTER the meeting ends (the bot needs a finished recording).
 * Runs on your Mac with .env.local (needs RECALL_API_KEY, ANTHROPIC_API_KEY;
 * emailing also needs RESEND_API_KEY + MAIL_FROM).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { exec } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderGeneralRecapEmail } from "../lib/emails/general-recap";
import { MailerConfigError, sendEmail } from "../lib/mailer";
import { generateGeneralRecap } from "../lib/meeting-classify";
import { getTranscript, RecallConfigError } from "../lib/recall";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Open a file in the OS default app (browser for .html). Best-effort. */
function openInBrowser(path: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${path}"`, (err) => {
    if (err) console.warn(`Could not auto-open ${path}: ${err.message}`);
  });
}

async function main(): Promise<void> {
  const botId = arg("--bot");
  if (!botId) {
    console.error("Missing --bot <botId> (the id printed by scripts/join-meeting.ts).");
    process.exit(1);
  }
  const account = arg("--account") ?? "Net-new pipeline review";
  const to = arg("--to") ?? "maanits@berkeley.edu";
  const noSend = process.argv.includes("--no-send");
  const noOpen = process.argv.includes("--no-open");

  // 1. Pull the transcript from the standalone bot.
  console.log(`Pulling transcript for bot ${botId} (transcription can take a minute)...`);
  let transcript: string;
  try {
    transcript = await getTranscript(botId);
  } catch (err) {
    if (err instanceof RecallConfigError) {
      console.error(
        `\nNo finished recording yet. Run this AFTER the meeting has ended and the recording has uploaded.\n(${err.message})`,
      );
      process.exit(1);
    }
    throw err;
  }
  if (transcript.trim().length < 50) {
    console.error("Transcript is empty or too short. Nothing to recap.");
    process.exit(1);
  }

  // 2. Internal recap only: summary, takeaways, next steps. No qualification
  //    extraction, no deal write-back.
  const recap = await generateGeneralRecap({ account, transcript });
  if (!recap) {
    console.error("Recap generation failed (check ANTHROPIC_API_KEY).");
    process.exit(1);
  }

  const email = renderGeneralRecapEmail({ account, recap, meetingType: "internal" });

  // 3. Write the HTML preview and open it in the browser.
  const out = resolve(process.cwd(), "pipeline-recap.html");
  writeFileSync(out, email.html);
  if (!noOpen) openInBrowser(out);

  // 4. Print the text version so you can read it in the terminal too.
  console.log("\n================= RECAP (text) =================");
  console.log(`Subject: ${email.subject}\n`);
  console.log(email.text);
  console.log("===============================================\n");
  console.log(`HTML preview written to: ${out}`);

  // 5. Email it to you (not Mark), unless --no-send.
  if (noSend) {
    console.log(`\n--no-send: not emailing. Open the HTML above, review, and forward to Mark yourself.`);
    return;
  }
  try {
    const res = await sendEmail({
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    console.log(`\nEmailed the recap to ${to} (resend id ${res.id}). Review it, then forward to Mark.`);
  } catch (err) {
    if (err instanceof MailerConfigError) {
      console.error(
        `\nMailer not configured (${err.message}). The HTML preview is written above; open it, review, and send to Mark yourself, or re-run with mail env set.`,
      );
      return;
    }
    throw err;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
