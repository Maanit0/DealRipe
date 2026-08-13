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
  let scheduledStartIso: string | null = null;

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
    scheduledStartIso = call.data.scheduled_start ?? null;
    callInfo = `${deal.data.account}  call ${call.data.scheduled_start}  outcome=${call.data.outcome}`;
  }

  console.log(`\n${callInfo}`);
  console.log(`Recall bot: ${botId}\n`);

  const bot = await getBot(botId);
  const dur = recordingDurationMinutes(bot);
  console.log(`  status:       ${bot.status} (${bot.rawStatusCode})`);
  console.log(`  sub_code:     ${bot.statusSubCode ?? "(Recall gave none)"}`);
  console.log(`  message:      ${bot.statusMessage ?? "(Recall gave none)"}`);
  console.log(`  hasMedia:     ${bot.hasMedia}`);
  console.log(`  recordingId:  ${bot.recordingId ?? "(none)"}`);
  console.log(`  duration:     ${dur == null ? "unknown" : `${dur} min`}`);

  // The status history is the only thing that separates "joined and recorded,
  // then lost the file" from "sat in a waiting room and was never admitted".
  // Both end at done with no media, and they are opposite problems: the first
  // is Recall's, the second is a human who did not click Admit and could have
  // been told at the time.
  const raw = bot.raw as { status_changes?: unknown };
  const changes = Array.isArray(raw?.status_changes) ? raw.status_changes : [];
  console.log(`\n  status history (${changes.length}):`);
  if (changes.length === 0) {
    console.log(`    (none returned, so the history is unknown rather than empty)`);
  }
  // Print the full timestamp, not just the clock time, and say what it is
  // relative to the scheduled start. A bot that behaved perfectly at the wrong
  // hour looks identical to one that behaved badly at the right hour when only
  // the time of day is shown, and those have nothing in common as problems.
  const startMs = scheduledStartIso === null ? null : Date.parse(scheduledStartIso);
  for (const c of changes) {
    if (typeof c !== "object" || c === null) continue;
    const e = c as { code?: unknown; sub_code?: unknown; message?: unknown; created_at?: unknown };
    const iso = typeof e.created_at === "string" ? e.created_at : null;
    const at = iso ? iso.replace("T", " ").slice(0, 19) + "Z" : "(no timestamp)";
    let rel = "";
    if (iso && startMs !== null && !Number.isNaN(startMs)) {
      const mins = Math.round((Date.parse(iso) - startMs) / 60_000);
      rel = Number.isNaN(mins) ? "" : `  [${mins >= 0 ? "+" : ""}${mins} min vs scheduled start]`;
    }
    const sub = typeof e.sub_code === "string" && e.sub_code ? `  sub_code=${e.sub_code}` : "";
    const msg = typeof e.message === "string" && e.message ? `  "${e.message}"` : "";
    console.log(`    ${at}  ${String(e.code ?? "?")}${sub}${msg}${rel}`);
  }
  if (scheduledStartIso !== null) {
    console.log(`    scheduled start was ${scheduledStartIso}`);
  }
  const reached = changes.some(
    (c) => typeof c === "object" && c !== null && (c as { code?: unknown }).code === "in_call_recording",
  );

  console.log("");
  // A meeting that has not happened yet has no recording because there was
  // nothing to record. Calling that LOST reports a healthy scheduled bot as a
  // failure, which is the same mistake as reading an empty checklist box as a
  // recorded "no".
  const startMsNow = scheduledStartIso === null ? null : Date.parse(scheduledStartIso);
  if (startMsNow !== null && !Number.isNaN(startMsNow) && startMsNow > Date.now()) {
    const mins = Math.round((startMsNow - Date.now()) / 60_000);
    const when = mins > 90 ? `${Math.round(mins / 60)} h` : `${mins} min`;
    console.log(`VERDICT: NOT YET. This meeting starts in ${when}. A bot is booked and has not run.`);
    console.log(`  Nothing is wrong. Re-run this after the call to judge the capture.`);
    return;
  }
  if (bot.status === "fatal") {
    console.log("VERDICT: LOST. The bot went fatal (e.g. insufficient credit) and never recorded. Not recoverable.");
  } else if (!bot.hasMedia || !bot.recordingId) {
    console.log("VERDICT: LOST. No media is attached. Not recoverable.");
    if (changes.length === 0) {
      console.log("  WHY: unknown. Recall returned no status history, so this is a gap in what we can see,");
      console.log("       not evidence that the bot did nothing.");
    } else if (reached) {
      console.log("  WHY: the bot DID reach in_call_recording, so it joined and recorded and the file was");
      console.log("       lost afterwards. That is Recall's side. Worth raising with them, with this bot id.");
    } else {
      console.log("  WHY: the bot NEVER reached in_call_recording. It was in the meeting but never recording,");
      console.log("       which is almost always a waiting room it was not admitted from, or a host who");
      console.log("       never granted recording permission. A human could have fixed this during the call.");
    }
  } else {
    console.log("VERDICT: RECOVERABLE. Media still exists. Re-run transcript-sync --retry-ingest to pull it now that credits are restored.");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
