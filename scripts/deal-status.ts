/**
 * Print the write-back readiness of every deal: external_id, account, whether a
 * Rolldog opp is linked (write-back ON) and at what confidence, and whether a
 * Recall bot is armed for an upcoming call. Read-only. Use to confirm what the
 * next calls will do.
 *
 *   npx tsx scripts/deal-status.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { rolldogOppIdForDeal } from "../lib/pilot-config";

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const rows = await db
    .from("deals")
    .select("id, external_id, account, rep_email, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId);
  if (rows.error) {
    console.error(rows.error.message);
    process.exit(1);
  }

  // Upcoming armed bots, keyed by deal_id.
  const calls = await db
    .from("calls")
    .select("deal_id, recall_bot_id, scheduled_start")
    .eq("tenant_id", tenantId)
    .not("recall_bot_id", "is", null);
  const botByDeal = new Map<string, string>();
  for (const c of calls.data ?? []) {
    if (c.recall_bot_id) botByDeal.set(c.deal_id, c.scheduled_start ?? "scheduled");
  }

  // Write-back is on if EITHER the static pilot map has an opp for this deal,
  // OR the DB column is set at confirmed/high. Mirror rolldog-writeback.ts.
  const writeStatus = (extId: string | null, c: string | null, dbOpp: string | null) => {
    const staticOpp = extId ? rolldogOppIdForDeal(extId) : null;
    if (staticOpp) return { opp: staticOpp, label: "WRITE-BACK ON (pilot)" };
    if (dbOpp && (c === "confirmed" || c === "high")) return { opp: dbOpp, label: `WRITE-BACK ON (${c})` };
    return { opp: "-", label: "write-back OFF" };
  };

  for (const r of (rows.data ?? []).sort((a, b) => (String(a.external_id) > String(b.external_id) ? 1 : -1))) {
    const bot = botByDeal.has(r.id) ? `bot @ ${botByDeal.get(r.id)}` : "no bot";
    const w = writeStatus(r.external_id, r.rolldog_link_confidence, r.rolldog_opportunity_id);
    console.log(
      `${String(r.external_id).padEnd(28)} ${String(r.account ?? "").padEnd(22)} opp=${w.opp.padEnd(8)} ${w.label.padEnd(24)} ${bot.padEnd(30)} [${r.rep_email ?? "?"}]`,
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
