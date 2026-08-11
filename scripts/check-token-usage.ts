/**
 * How many access tokens do we actually ask Rolldog for?
 *
 * Jeff Bowden flagged 125 token requests in a day on August 11 and said Rolldog
 * will start enforcing a limit. Their tokens live 24 hours, so the right number
 * is about one a day, and it was not.
 *
 * Two causes, both fixed, both checked here:
 *
 *   1. briefing-sync warmed a token at the top of every run. It fires every five
 *      minutes and the large majority of runs have no meeting to brief, so that
 *      was ~288 requests a day for work that never happened. The warm now
 *      happens once a meeting is genuinely inside the briefing window.
 *   2. The token cache was a module-level variable, so it could not survive a
 *      cold start. Every cron invocation, every cold render of /pipeline or
 *      /deals/[id], and every one-shot script minted its own. There is now a
 *      shared row in crm_token_cache.
 *
 * This imports the real getAccessToken path and reads the mint counter that
 * increments inside it, so it cannot drift from what production does. A checker
 * that restates the rule will eventually disagree with the code and be confident
 * about it.
 *
 * Run it TWICE. The first run may mint one (if the shared row is absent or
 * stale). The second, in a fresh process, must mint zero, which is the whole
 * point of the fix.
 *
 *   npx tsx scripts/check-token-usage.ts
 *   npx tsx scripts/check-token-usage.ts
 *
 * Reads Rolldog and writes only crm_token_cache. Touches no customer data.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { prewarmRolldogToken, rolldogTokenMintCount } from "../lib/rolldog";

async function main(): Promise<void> {
  console.log("");

  // Five warms in one process. A process should never need more than one token.
  for (let i = 0; i < 5; i++) {
    await prewarmRolldogToken();
  }
  const minted = rolldogTokenMintCount();

  console.log(`Five token requests in this process minted ${minted} token(s) from Rolldog.`);
  console.log("");

  if (minted === 0) {
    console.log("  0 means the shared cache in crm_token_cache served every one.");
    console.log("  This is the steady state. A cold Vercel invocation costs Rolldog nothing.");
  } else if (minted === 1) {
    console.log("  1 means the in-process cache worked, and the shared row was absent or");
    console.log("  near expiry so this run refreshed it. Expected on the first run after");
    console.log("  deploying, or once every 24 hours.");
    console.log("");
    console.log("  Run this script once more. The second run must print 0. If it prints 1");
    console.log("  again, the shared write is failing and the warning above says why.");
  } else {
    console.log(`  ${minted} is a bug. One process asked for more than one token, which means`);
    console.log("  the in-memory cache is not being consulted at all. Check that");
    console.log("  getAccessToken still returns early on a live _tokenCache.");
  }

  console.log("");
  console.log("Where tokens get requested from, for reference:");
  console.log("  briefing-sync    every 5 min, but now only warms when a meeting is in window");
  console.log("  transcript-sync  every 5 min, on write-back");
  console.log("  rolldog-relink   every 2h");
  console.log("  snapshot         every 4h");
  console.log("  outcome-sync     daily      audit  daily");
  console.log("  /pipeline and /deals/[id]   on a cold render");
  console.log("  every npx tsx scripts/...   one process, one token");
  console.log("");
  console.log("All of them now share one row, so the daily total is roughly one.");
  console.log("");

  if (minted > 1) process.exit(1);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
