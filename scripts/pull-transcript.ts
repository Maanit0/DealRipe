/**
 * Watch a dispatched Recall bot until the call ends, then pull and SAVE the
 * full transcript to disk. Start it right after dispatching the bot and
 * leave it running; it polls until the meeting is over and pulls
 * automatically. Also works if the call already ended (pulls immediately).
 *
 *   npx tsx scripts/pull-transcript.ts <botId>
 *   npx tsx scripts/pull-transcript.ts <botId> --out ../Magaya-Pilot/calls/aquagulf.txt
 *   npx tsx scripts/pull-transcript.ts <botId> --keep-media   (skip DPA delete)
 *
 * By default, after saving the transcript it deletes the source media from
 * Recall (DPA delete-after-pull). The saved transcript text is kept.
 *
 * Output defaults to ./.transcripts/<botId>-<timestamp>.txt (gitignored).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  RecallApiError,
  deleteBotMedia,
  getBot,
  getTranscript,
} from "../lib/recall";

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3 hours

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const botId = argv.find((a) => !a.startsWith("--"));
  const outIdx = argv.indexOf("--out");
  const keepMedia = argv.includes("--keep-media");
  if (!botId) {
    console.error("Usage: npx tsx scripts/pull-transcript.ts <botId> [--out <path>] [--keep-media]");
    process.exit(1);
  }
  if (!process.env.RECALL_API_KEY) {
    console.error("RECALL_API_KEY is not set in .env.local.");
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = outIdx !== -1 ? argv[outIdx + 1] : `./.transcripts/${botId}-${stamp}.txt`;

  console.log("");
  console.log(`Watching bot ${botId} until the call ends...`);
  console.log(`Transcript will be saved to: ${outPath}`);
  console.log("");

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastSeen: string | null = null;
  let done = false;

  while (Date.now() < deadline) {
    const bot = await getBot(botId);
    if (bot.rawStatusCode !== lastSeen) {
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      console.log(`  [${ts}] status: ${bot.rawStatusCode}`);
      lastSeen = bot.rawStatusCode;
    }
    if (bot.status === "done") { done = true; break; }
    if (bot.status === "fatal") {
      console.error(`  Bot ended in a fatal state (${bot.rawStatusCode}). No transcript to pull.`);
      process.exit(1);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!done) {
    console.error("  Timed out waiting for the call to end.");
    process.exit(1);
  }

  console.log("");
  console.log("  Call ended. Pulling transcript...");
  let transcript: string;
  try {
    transcript = await getTranscript(botId);
  } catch (err) {
    if (err instanceof RecallApiError) console.error(`  getTranscript failed: HTTP ${err.status} ${err.endpoint}`);
    else console.error(`  getTranscript failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, transcript, "utf8");
  console.log(`  Saved ${transcript.length} chars to ${outPath}`);
  console.log("");

  if (keepMedia) {
    console.log("  --keep-media set: skipping Recall media deletion.");
  } else {
    try {
      await deleteBotMedia(botId);
      console.log("  Deleted source media from Recall (DPA delete-after-pull). Transcript text kept.");
    } catch (err) {
      console.error(`  WARNING: media delete failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error("  The transcript is saved, but delete the media from the Recall dashboard to stay DPA-compliant.");
    }
  }

  console.log("");
  console.log("  Done. Next: run extraction on the saved transcript to see the fields fill.");
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
