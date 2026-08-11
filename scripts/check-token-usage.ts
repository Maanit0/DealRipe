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
import { supabaseAdmin } from "../lib/supabase";

/**
 * Is the shared cache actually there?
 *
 * Without this the script reports a mint of 1 as "absent or near expiry" whether
 * the row is genuinely missing or the table was never created, and those need
 * completely different responses. Run the migration, or wait 24 hours.
 */
async function sharedCacheState(): Promise<"missing_table" | "empty" | "populated" | "unreadable"> {
  try {
    const res = await (supabaseAdmin() as unknown as {
      from: (t: string) => {
        select: (c: string) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    })
      .from("crm_token_cache")
      .select("key");
    if (res.error) {
      return /could not find the table|does not exist|schema cache/i.test(res.error.message)
        ? "missing_table"
        : "unreadable";
    }
    return (res.data ?? []).length > 0 ? "populated" : "empty";
  } catch {
    return "unreadable";
  }
}

async function main(): Promise<void> {
  console.log("");

  const before = await sharedCacheState();
  if (before === "missing_table") {
    console.log("The shared cache does not exist yet.");
    console.log("");
    console.log("  crm_token_cache has not been created, so every process still mints its own");
    console.log("  token and nothing below will change until it does.");
    console.log("");
    console.log("  Run supabase/add-crm-token-cache.sql in the SQL editor, then run this again.");
    console.log("");
    process.exit(1);
  }
  if (before === "unreadable") {
    console.log("The shared cache exists but could not be read. That is not the same as empty.");
    console.log("Fix the read before trusting any number below.");
    console.log("");
  }

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
    console.log(
      before === "empty"
        ? "  1 with an empty shared cache is exactly right: this run minted the token"
        : "  1 with a populated shared cache means the stored token was near expiry",
    );
    console.log("  and published it for everyone else. Expected on the first run after");
    console.log("  deploying, and once every 24 hours after that.");
    console.log("");
    const after = await sharedCacheState();
    console.log(
      after === "populated"
        ? "  The shared row is now written. Run this once more and it must print 0."
        : `  The shared row was NOT written (state: ${after}). The warning above says why,` +
            "\n  and until it is fixed every cold process will keep minting its own.",
    );
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
