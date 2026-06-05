/**
 * End-to-end Recall.ai lifecycle proof.
 *
 *   dispatch -> join -> transcribe -> pull -> delete
 *
 * Sends a real bot to a real meeting URL, polls it through the call,
 * pulls the normalized transcript, prints the first 500 chars, then
 * deletes the source media and verifies the media is gone.
 *
 * This is the script the team runs to prove the integration before
 * wiring it into the ingest pipeline.
 *
 * Usage:
 *   npm run test:recall-bot -- <meeting-url>
 *      Full lifecycle: dispatch -> join -> transcribe -> pull -> delete.
 *
 *   npm run test:recall-bot -- --bot-id <bot-id>
 *      Resume mode. Skips dispatch and meeting polling, runs only
 *      [3/5] pull transcript -> [4/5] delete -> [5/5] verify against an
 *      existing bot. Useful when the meeting already ended but the
 *      previous test run was interrupted before delete-and-verify.
 *
 * Prereqs:
 *   - RECALL_API_KEY set in .env.local (Recall workspace token).
 *   - The meeting URL must be a live meeting room the bot can join (Zoom,
 *     Google Meet, or Teams URL per Recall's supported platforms).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  RecallApiError,
  RecallConfigError,
  RecallTimeoutError,
  createBot,
  deleteBotMedia,
  getBot,
  getTranscript,
  type BotStatus,
} from "../lib/recall";

const LINE = "=".repeat(80);
const STATUS_POLL_INTERVAL_MS = 15_000;
const STATUS_POLL_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours
const DELETE_VERIFY_INTERVAL_MS = 5_000;
const DELETE_VERIFY_MAX_ATTEMPTS = 12; // ~60s total

type Args =
  | { mode: "full"; meetingUrl: string }
  | { mode: "resume"; botId: string };

function parseArgs(argv: string[]): Args {
  const idx = argv.indexOf("--bot-id");
  if (idx !== -1) {
    const value = argv[idx + 1];
    if (!value) {
      console.error("Missing value for --bot-id");
      process.exit(1);
    }
    return { mode: "resume", botId: value };
  }
  const positional = argv.find((a) => !a.startsWith("--"));
  if (!positional) {
    console.error(
      "Usage:\n  npm run test:recall-bot -- <meeting-url>\n  npm run test:recall-bot -- --bot-id <bot-id>",
    );
    process.exit(1);
  }
  return { mode: "full", meetingUrl: positional };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.RECALL_API_KEY) {
    console.error("RECALL_API_KEY is not set in .env.local. Add it and re-run.");
    process.exit(1);
  }

  console.log("");
  console.log(LINE);
  console.log("Recall.ai end-to-end lifecycle proof");
  console.log(LINE);

  let botId: string;
  if (args.mode === "full") {
    console.log(`Meeting URL: ${args.meetingUrl}`);
    console.log("");

    // ----- 1. Dispatch the bot. -----
    console.log("[1/5] Dispatching bot...");
    const bot = await createBot({ meetingUrl: args.meetingUrl });
    console.log(`      botId: ${bot.id}`);
    console.log("");

    // ----- 2. Poll the bot through the meeting. -----
    console.log("[2/5] Polling bot status until call ends...");
    const finalStatus = await pollBotUntilDone(bot.id);
    console.log(`      terminal status: ${finalStatus}`);
    console.log("");

    if (finalStatus !== "done") {
      console.error(`Bot terminated in non-done state: ${finalStatus}. Aborting.`);
      process.exit(1);
    }
    botId = bot.id;
  } else {
    console.log(`Resume mode: skipping dispatch + meeting polling.`);
    console.log(`Existing botId: ${args.botId}`);
    console.log("");
    console.log("[1/5] (skipped) Dispatching bot");
    console.log("[2/5] (skipped) Polling bot status until call ends");
    console.log("");
    botId = args.botId;
  }

  // ----- 3. Pull the transcript. -----

  console.log("[3/5] Pulling normalized transcript (may kick off async transcription)...");
  let transcript: string;
  try {
    transcript = await getTranscript(botId);
  } catch (err) {
    printError("getTranscript failed", err);
    process.exit(1);
  }

  console.log(`      transcript length: ${transcript.length} chars`);
  console.log("");
  console.log(LINE);
  console.log("First 500 characters of normalized transcript:");
  console.log(LINE);
  console.log(transcript.slice(0, 500) || "(empty)");
  if (transcript.length > 500) console.log("... (truncated)");
  console.log("");

  // ----- 4. Delete the source media. -----

  console.log("[4/5] Calling deleteBotMedia (DPA delete-after-pull)...");
  try {
    await deleteBotMedia(botId);
    console.log("      deleteBotMedia returned 2xx");
  } catch (err) {
    printError("deleteBotMedia failed", err);
    process.exit(1);
  }
  console.log("");

  // ----- 5. Verify the media is gone. -----

  console.log("[5/5] Verifying media is gone via getBot refetch...");
  const verified = await verifyMediaDeleted(botId);
  if (verified) {
    console.log("      VERIFIED: bot resource reports no remaining media.");
  } else {
    console.error(
      `      NOT VERIFIED: bot resource still reports media after ${DELETE_VERIFY_MAX_ATTEMPTS} attempts. Inspect the bot in the Recall dashboard.`,
    );
    process.exit(1);
  }
  console.log("");

  console.log(LINE);
  if (args.mode === "full") {
    console.log("Lifecycle complete: dispatch -> join -> transcribe -> pull -> delete");
  } else {
    console.log("Resume complete: transcribe -> pull -> delete");
  }
  console.log(LINE);
}

async function pollBotUntilDone(botId: string): Promise<BotStatus> {
  let lastSeen: string | null = null;
  const deadline = Date.now() + STATUS_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const bot = await getBot(botId);
    if (bot.rawStatusCode !== lastSeen) {
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      console.log(`      [${ts}] status: ${bot.rawStatusCode}`);
      lastSeen = bot.rawStatusCode;
    }
    if (bot.status === "done") return "done";
    if (bot.status === "fatal") return "fatal";
    await sleep(STATUS_POLL_INTERVAL_MS);
  }
  throw new Error(
    `bot ${botId} did not reach a terminal status within ${STATUS_POLL_TIMEOUT_MS}ms`,
  );
}

async function verifyMediaDeleted(botId: string): Promise<boolean> {
  for (let attempt = 1; attempt <= DELETE_VERIFY_MAX_ATTEMPTS; attempt++) {
    const bot = await getBot(botId);
    if (!bot.hasMedia) return true;
    if (attempt < DELETE_VERIFY_MAX_ATTEMPTS) {
      console.log(
        `      attempt ${attempt}/${DELETE_VERIFY_MAX_ATTEMPTS}: media still present, waiting ${DELETE_VERIFY_INTERVAL_MS}ms...`,
      );
      await sleep(DELETE_VERIFY_INTERVAL_MS);
    }
  }
  return false;
}

function printError(label: string, err: unknown): void {
  if (err instanceof RecallApiError) {
    console.error(`${label}: HTTP ${err.status} ${err.endpoint}`);
    console.error(`         ${err.bodyExcerpt}`);
  } else if (err instanceof RecallTimeoutError) {
    console.error(`${label}: ${err.message}`);
  } else if (err instanceof RecallConfigError) {
    console.error(`${label}: ${err.message}`);
  } else if (err instanceof Error) {
    console.error(`${label}: ${err.message}`);
  } else {
    console.error(`${label}: ${String(err)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  printError("Unexpected error", err);
  process.exit(1);
});
