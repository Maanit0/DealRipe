/**
 * Send the DealRipe Notetaker bot to a single meeting URL, standalone.
 *
 * This is the minimal "just be in the room" path: it schedules a Recall bot to
 * join a meeting so everyone sees "DealRipe Notetaker" in the participant list.
 * It creates NO calls row, so the transcript-sync pipeline never picks it up:
 * no extraction, no Rolldog write-back, no recap, nothing to deploy. It only
 * joins and records (24h Recall retention). Use it for the internal pipeline
 * review for presence, before the real recognize-and-recap feature is built.
 *
 *   npx tsx scripts/join-meeting.ts --url "<teams link>" --at 2026-07-28T15:00:00Z
 *   npx tsx scripts/join-meeting.ts --url "<teams link>"           # join now
 *   npx tsx scripts/join-meeting.ts --cancel <botId>               # cancel a scheduled bot
 *
 * Runs on your Mac with .env.local (needs RECALL_API_KEY).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createBot, deleteBot } from "../lib/recall";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const cancel = arg("--cancel");
  if (cancel) {
    await deleteBot(cancel);
    console.log(`Cancelled bot ${cancel}. It will not join.`);
    return;
  }

  const url = arg("--url");
  if (!url) {
    console.error('Missing --url "<meeting link>".');
    process.exit(1);
  }
  const at = arg("--at"); // ISO 8601; omit to join immediately
  if (at && Number.isNaN(Date.parse(at))) {
    console.error(`--at "${at}" is not a valid ISO 8601 timestamp (e.g. 2026-07-28T15:00:00Z).`);
    process.exit(1);
  }

  const { id } = await createBot({ meetingUrl: url, joinAt: at });
  console.log(`\nDealRipe Notetaker scheduled.`);
  console.log(`  bot id : ${id}`);
  console.log(`  joins  : ${at ? new Date(at).toISOString() : "now"}`);
  console.log(`  meeting: ${url}`);
  console.log(
    `\nIt shows as "DealRipe Notetaker" in the room. The host may need to admit it from the lobby.`,
  );
  console.log(
    `It only joins and records (24h Recall retention); it does not extract, write to Rolldog, or send a recap.`,
  );
  console.log(`\nTo cancel before it joins:  npx tsx scripts/join-meeting.ts --cancel ${id}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
