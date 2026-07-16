/**
 * Backfill calls.duration_minutes for existing calls that have a bot but no
 * recorded duration. Reads the duration from the Recall bot's status_changes
 * timestamps (which persist even after the media is deleted). Read-only unless
 * --apply is passed.
 *
 *   npx tsx scripts/backfill-durations.ts            # dry run
 *   npx tsx scripts/backfill-durations.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getBot, recordingDurationMinutes } from "../lib/recall";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const calls = await db
    .from("calls")
    .select("id, deal_id, recall_bot_id, duration_minutes, scheduled_start")
    .eq("tenant_id", tenantId)
    .not("recall_bot_id", "is", null);
  if (calls.error) {
    console.error(calls.error.message);
    process.exit(1);
  }

  const needing = (calls.data ?? []).filter((c) => !c.duration_minutes || c.duration_minutes === 0);
  if (needing.length === 0) {
    console.log("No calls need a duration backfill.");
    return;
  }

  console.log(`${needing.length} call(s) missing duration:\n`);
  for (const c of needing) {
    if (!c.recall_bot_id) continue;
    let mins: number | null = null;
    try {
      mins = recordingDurationMinutes(await getBot(c.recall_bot_id));
    } catch (err) {
      console.log(`  ${c.scheduled_start ?? c.id}: getBot failed (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (mins === null) {
      console.log(`  ${c.scheduled_start ?? c.id}: no usable timestamps on the bot; skipping.`);
      continue;
    }
    console.log(`  ${c.scheduled_start ?? c.id}: ${mins} min`);
    if (apply) {
      const upd = await db.from("calls").update({ duration_minutes: mins }).eq("id", c.id);
      if (upd.error) console.log(`     update failed: ${upd.error.message}`);
    }
  }

  console.log(apply ? "\nApplied." : "\nDry run. Re-run with --apply to write these durations.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
