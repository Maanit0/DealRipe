/**
 * Run the real calendar sync once (the same runCalendarSync the deployed cron
 * calls), printing the meaningful decisions. Uses the live pilot config + the
 * local AUTO_JOIN_REP_EMAILS env.
 *
 * NOT a dry run: it creates deals and dispatches real Recall bots for in-window
 * meetings. Idempotent, so re-running is safe (existing deals/bots aren't
 * duplicated; autoCreated only counts NEW deals).
 *
 *   npx tsx scripts/run-calendar-sync.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runCalendarSync, type CalendarSyncDecision } from "../lib/calendar-sync";
import { isAutoJoinRep } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function print(d: CalendarSyncDecision): void {
  switch (d.kind) {
    case "auto-deal":
      console.log(`  [auto-deal]   ${d.dealExternalId} (${d.domain})  "${d.subject ?? ""}"`);
      return;
    case "created":
      console.log(`  [bot-created] ${d.subject ?? ""}  botId=${d.recallBotId}`);
      return;
    case "rescheduled":
      console.log(`  [rescheduled] ${d.subject ?? ""}  ${d.oldBotId ?? "(none)"} -> ${d.newBotId}`);
      return;
    case "cancelled":
      console.log(`  [cancelled]   ${d.subject ?? ""}  oldBot=${d.oldBotId}`);
      return;
    case "vanished":
      console.log(`  [vanished]    pruned call ${d.callId} oldBot=${d.oldBotId ?? "(none)"}`);
      return;
    case "no-deal":
      console.log(`  [no-deal]     '${d.dealExternalId}' has no deal row  "${d.subject ?? ""}"`);
      return;
    case "error":
      console.log(`  [error]       ${d.subject ?? ""}  ${d.phase}: ${d.message}`);
      return;
    default:
      // no-join-url / no-attendees / no-pilot-match / no-change: routine noise.
      return;
  }
}

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const conns = await supabaseAdmin()
    .from("microsoft_connections")
    .select("user_principal_name")
    .eq("tenant_id", tenantId);
  console.log("Auto-join per connection:");
  for (const c of conns.data ?? []) {
    console.log(`  ${c.user_principal_name}: autoJoin=${isAutoJoinRep(c.user_principal_name)}`);
  }

  console.log("\nRunning runCalendarSync() (live: creates deals + dispatches bots)...\n");
  const counts = await runCalendarSync({ onDecision: print });
  console.log("\ncounts:", JSON.stringify(counts, null, 2));
}

main().catch((e) => {
  console.error("Unexpected error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
