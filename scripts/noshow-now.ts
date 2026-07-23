/**
 * Backfill the no-show handling for a specific past no-show call: log it to the
 * deal's Rolldog opportunity (interactions tab) so the CRM records that the
 * meeting did not happen. Used for no-shows that predate the no-show feature.
 *
 * The Rolldog log is idempotent (it will not double-log) and gated to
 * Rolldog-linked deals. The rep follow-up email is OFF by default, since a
 * "sorry we missed you" note is stale weeks later; pass --followup only if you
 * really want it sent now.
 *
 * Safe by default: previews and writes nothing without --apply.
 *
 *   npx tsx scripts/noshow-now.ts --account "Duty Free Americas"
 *   npx tsx scripts/noshow-now.ts --account "Duty Free Americas" --apply
 *   npx tsx scripts/noshow-now.ts --deal <external_id> --apply --followup
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { sendNoShowFollowup } from "../lib/no-show-followup";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { logNoShowToRolldog } from "../lib/rolldog-writeback";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const NOSHOW_OUTCOMES = ["no_show", "no_conversation"];

async function main(): Promise<void> {
  const ext = arg("--deal");
  const account = arg("--account");
  const apply = process.argv.includes("--apply");
  const followup = process.argv.includes("--followup");
  if (!ext && !account) {
    console.error('Usage: --deal <external_id> | --account "<name>" [--apply] [--followup]');
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const pattern = account ? `%${account.trim().split(/\s+/).join("%")}%` : "";
  let q = db.from("deals").select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence").eq("tenant_id", tenantId);
  q = ext ? q.eq("external_id", ext) : q.ilike("account", pattern);
  const dealRes = await q.limit(5);
  const rows = (dealRes.data ?? []) as Array<{
    id: string;
    account: string;
    external_id: string | null;
    rolldog_opportunity_id: string | null;
    rolldog_link_confidence: string | null;
  }>;
  if (dealRes.error || rows.length === 0) {
    console.error(`Deal not found for ${ext ? `--deal ${ext}` : `--account "${account}"`}.`);
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error(`Ambiguous: ${rows.length} deals match. Re-run with --deal <external_id>:`);
    for (const r of rows) console.error(`  ${r.account}  ->  ${r.external_id}`);
    process.exit(1);
  }
  const deal = rows[0];

  const opp = (deal.external_id ? rolldogOppIdForDeal(deal.external_id) : null) ?? deal.rolldog_opportunity_id;
  const linked = !!opp && (!!rolldogOppIdForDeal(deal.external_id ?? "") || ["confirmed", "high"].includes(deal.rolldog_link_confidence ?? ""));

  // Latest no-show call for the deal.
  const callRes = await db
    .from("calls")
    .select("id, scheduled_start, outcome")
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.id)
    .in("outcome", NOSHOW_OUTCOMES)
    .order("scheduled_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (callRes.error || !callRes.data) {
    console.error(`No no-show call found for '${deal.account}'.`);
    process.exit(1);
  }
  const call = callRes.data;

  console.log(`\nDeal:        ${deal.account} (${deal.external_id})`);
  console.log(`Rolldog:     ${linked ? `linked -> opp ${opp}` : "NOT linked (log would be skipped)"}`);
  console.log(`No-show call:${call.id}  ${call.scheduled_start}  (${call.outcome})`);
  console.log(`Follow-up:   ${followup ? "WILL send to rep" : "skipped (pass --followup to send)"}`);
  console.log(`Mode:        ${apply ? "APPLY" : "DRY (nothing written)"}`);

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to log this no-show to Rolldog.`);
    return;
  }

  const wb = await logNoShowToRolldog("magaya", { callId: call.id });
  console.log(`\nRolldog no-show log: ${wb.written ? `wrote to opp ${wb.opportunityId}` : `skipped (${wb.reason})`}`);

  if (followup) {
    const ns = await sendNoShowFollowup({ tenantId, callId: call.id });
    console.log(`Rep follow-up: ${ns.sent ? `sent to ${ns.to}` : `skipped (${ns.reason})`}`);
  }

  console.log(`\nDone. Reload the coverage view; the Duty Free no-show should now show the Rolldog log.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
