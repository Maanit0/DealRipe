/**
 * Recreate the DFA no-show call record that the reconcile bug deleted before
 * the fix shipped. The bot did join that 6:30 call (bot 0b160428...), recorded
 * ~23 seconds, and everyone left, a no-show / placeholder. This re-inserts a
 * single call row marked no_conversation so the deal reflects what happened.
 * Idempotent: skips if a call with that bot id already exists.
 *
 *   npx tsx scripts/recreate-dfa-call.ts            # dry run
 *   npx tsx scripts/recreate-dfa-call.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getBot, recordingDurationMinutes } from "../lib/recall";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const DEAL_EXTERNAL_ID = "dutyfreeamericas";
const BOT_ID = "0b160428-6d3a-4190-902f-d95578eda97f";
const SCHEDULED_START = "2026-07-16T13:30:00+00:00";
const CALL_DATE = "2026-07-16";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const deal = await db
    .from("deals")
    .select("id, account")
    .eq("tenant_id", tenantId)
    .eq("external_id", DEAL_EXTERNAL_ID)
    .maybeSingle();
  if (deal.error || !deal.data) {
    console.error(`Deal '${DEAL_EXTERNAL_ID}' not found.`);
    process.exit(1);
  }

  const existing = await db
    .from("calls")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("recall_bot_id", BOT_ID)
    .maybeSingle();
  if (existing.data) {
    console.log(`A call for bot ${BOT_ID} already exists (${existing.data.id}). Nothing to do.`);
    return;
  }

  // Best-effort duration from the bot's surviving timestamps.
  let duration: number | null = null;
  try {
    duration = recordingDurationMinutes(await getBot(BOT_ID));
  } catch {
    /* bot may be gone; duration stays null */
  }

  const row = {
    tenant_id: tenantId,
    deal_id: deal.data.id,
    external_id: null as string | null,
    call_date: CALL_DATE,
    scheduled_start: SCHEDULED_START,
    duration_minutes: duration,
    source: "recall_ai" as const,
    recall_bot_id: BOT_ID,
    has_been_extracted: true,
    outcome: "no_conversation",
  };

  console.log(`\nWould insert into calls for ${deal.data.account}:`);
  console.log(row);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to insert.");
    return;
  }

  const ins = await db.from("calls").insert(row);
  if (ins.error) {
    console.error(`Insert failed: ${ins.error.message}`);
    process.exit(1);
  }
  console.log("\nInserted. DFA now shows the no-show call (rep can classify it on the deal page).");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
