/**
 * Cancel a scheduled bot and remove the call row, so nothing joins a meeting
 * DealRipe should never have been in.
 *
 * The join gate prevents new mistakes. It does nothing about bots already
 * created before it existed, and deleting a deal does not cancel them either:
 * the bot lives at Recall, keyed by its own id, and will dial into the meeting
 * whether or not our database still has a row for it.
 *
 * That is not a theoretical gap. Two bots were scheduled to join Magaya's
 * all-leaders meeting and their team dinner, both created by the ungated
 * auto-join this replaces.
 *
 *   npx tsx scripts/cancel-call.ts --match "Leaders Mtg"
 *   npx tsx scripts/cancel-call.ts --match "Dinner with all leaders" --apply
 *   npx tsx scripts/cancel-call.ts --call <uuid> --apply
 *
 * Preview by default. --apply cancels the bot first, then deletes the row:
 * that order matters, because a deleted row you cannot find is a bot you
 * cannot cancel.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { deleteBot } from "../lib/recall";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { formatMeetingTime } from "../lib/graph-time";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Rendered in the rep's timezone, not the reader's. See lib/graph-time.ts. */
const when = formatMeetingTime;

async function main(): Promise<void> {
  const match = arg("--match");
  const callId = arg("--call");
  const apply = process.argv.includes("--apply");
  if (!match && !callId) {
    console.error('Usage: --match "<title fragment>" | --call <uuid>   [--apply]');
    process.exit(1);
  }

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  let q = db
    .from("calls")
    .select("id, title, scheduled_start, recall_bot_id, deal_id, deals(account)")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", new Date().toISOString());
  if (callId) q = q.eq("id", callId);
  else if (match) q = q.ilike("title", `%${match}%`);

  const res = await q;
  if (res.error) throw new Error(res.error.message);
  const rows = res.data ?? [];

  console.log("");
  if (rows.length === 0) {
    console.log("No upcoming calls matched. Nothing to cancel.");
    console.log("");
    return;
  }

  for (const r of rows) {
    const deal = (r.deals as unknown as { account?: string } | null)?.account ?? "(no deal)";
    console.log(`  ${when(r.scheduled_start)}  ${deal}  "${r.title ?? ""}"`);
    console.log(`     call ${r.id}   bot ${r.recall_bot_id ?? "none scheduled"}`);
  }
  console.log("");

  if (!apply) {
    console.log(`${rows.length} call(s) would be cancelled and deleted. Re-run with --apply.`);
    console.log("");
    return;
  }

  let cancelled = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.recall_bot_id) {
      try {
        await deleteBot(r.recall_bot_id);
        cancelled += 1;
        console.log(`   cancelled bot ${r.recall_bot_id}`);
      } catch (e) {
        // Do NOT delete the row if the bot could not be cancelled. Losing the
        // row means losing the only record of which bot to stop.
        console.error(`   FAILED to cancel bot ${r.recall_bot_id}: ${e instanceof Error ? e.message : String(e)}`);
        console.error(`   leaving call ${r.id} in place so it can be retried`);
        continue;
      }
    }
    await db.from("transcripts").delete().eq("call_id", r.id);
    const del = await db.from("calls").delete().eq("id", r.id);
    if (del.error) {
      console.error(`   call delete failed for ${r.id}: ${del.error.message}`);
      continue;
    }
    removed += 1;
    console.log(`   removed call ${r.id}`);
  }

  console.log("");
  console.log(`${cancelled} bot(s) cancelled, ${removed} call row(s) removed.`);
  console.log("Re-run scripts/check-call-dupes.ts to confirm nothing is left scheduled.");
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
