/**
 * Check whether a deal's most recent call recording is recoverable or lost, by
 * looking up its Recall bot and reporting the bot status, whether media still
 * exists, and the recording length. Read-only.
 *
 *   npx tsx scripts/check-recall-bot.ts --deal iff
 *   npx tsx scripts/check-recall-bot.ts --bot 5f9d5be0-cb5c-4f33-aed4-13206e30e5ea
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getBot, recordingDurationMinutes } from "../lib/recall";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dealExt = arg("--deal");
  let botId = arg("--bot");
  let callInfo = "";

  if (!botId) {
    if (!dealExt) {
      console.error("Usage: --deal <external_id> | --bot <botId>");
      process.exit(1);
    }
    const tenantId = await resolveTenantId("magaya");
    const db = supabaseAdmin();
    const deal = await db
      .from("deals")
      .select("id, account")
      .eq("tenant_id", tenantId)
      .eq("external_id", dealExt)
      .maybeSingle();
    if (deal.error || !deal.data) {
      console.error(`Deal '${dealExt}' not found.`);
      process.exit(1);
    }
    const call = await db
      .from("calls")
      .select("id, recall_bot_id, scheduled_start, outcome, has_been_extracted")
      .eq("tenant_id", tenantId)
      .eq("deal_id", deal.data.id)
      .order("scheduled_start", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (call.error || !call.data) {
      console.error(`No call for '${dealExt}'.`);
      process.exit(1);
    }
    if (!call.data.recall_bot_id) {
      console.error(`Latest ${deal.data.account} call has no recall_bot_id (no bot was created).`);
      process.exit(1);
    }
    botId = call.data.recall_bot_id;
    callInfo = `${deal.data.account}  call ${call.data.scheduled_start}  outcome=${call.data.outcome}`;
  }

  console.log(`\n${callInfo}`);
  console.log(`Recall bot: ${botId}\n`);

  const bot = await getBot(botId);
  const dur = recordingDurationMinutes(bot);
  console.log(`  status:       ${bot.status} (${bot.rawStatusCode})`);
  console.log(`  hasMedia:     ${bot.hasMedia}`);
  console.log(`  recordingId:  ${bot.recordingId ?? "(none)"}`);
  console.log(`  duration:     ${dur == null ? "unknown" : `${dur} min`}`);

  console.log("");
  if (bot.status === "fatal") {
    console.log("VERDICT: LOST. The bot went fatal (e.g. insufficient credit) and never recorded. Not recoverable.");
  } else if (!bot.hasMedia || !bot.recordingId) {
    console.log("VERDICT: LOST. No media is attached (recording expired or never captured). Not recoverable.");
  } else {
    console.log("VERDICT: RECOVERABLE. Media still exists. Re-run transcript-sync --retry-ingest to pull it now that credits are restored.");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
