/**
 * Recompute outcome_stage_moved from Salesforce field history.
 *
 * outcome_stage_moved answers "did the customer's CRM say this deal moved
 * across this call". Until now it could only be answered by differencing
 * deal_signal_snapshots, which meant two things: a move was located inside a
 * multi-day window rather than at a moment, and any snapshot with no CRM
 * reading produced `unknown` rather than an answer. On 2026-08-20 the column
 * stood at 4 yes, 36 no, 339 unknown across 379 rows.
 *
 * Salesforce has been recording the answer the whole time. Field history
 * tracking on Opportunity.StageName is already enabled and readable with the
 * access we hold: 15,459 transitions going back to 2025-02-19, which covers the
 * entire pilot. An admin request for it was drafted and very nearly sent.
 *
 * Every rule is imported from lib/salesforce-stage-history.ts rather than
 * restated here. Two of the four bad calls in this codebase's history came from
 * a script reimplementing a rule and drifting from it.
 *
 *   npx tsx scripts/backfill-stage-history.ts                  dry run
 *   npx tsx scripts/backfill-stage-history.ts --window 21      change the window
 *   npx tsx scripts/backfill-stage-history.ts --apply          WRITES
 *
 * Dry run by default. --apply writes outcome_stage_moved and outcome_reasons
 * on prescribed_actions, and nothing else, ever. It touches no CRM.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { OUTCOME_REFRESH_DAYS } from "../lib/prescription-scoring";
import {
  HISTORY_BEGINS,
  loadOpportunityCreationForAccounts,
  loadStageHistoryForAccounts,
  stageMovedAfterCall,
} from "../lib/salesforce-stage-history";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Tri = "yes" | "no" | "unknown";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const windowDays = Number(arg("--window") ?? OUTCOME_REFRESH_DAYS);
  if (!Number.isFinite(windowDays) || windowDays <= 0) {
    console.error(`--window must be a positive number`);
    process.exit(1);
  }

  const db = supabaseAdmin();
  const tenantId = await resolveTenantId(TENANT_SLUG);

  console.log(`\n${"=".repeat(76)}`);
  console.log(`${apply ? "APPLYING" : "DRY RUN"}: outcome_stage_moved from Salesforce field history`);
  console.log(`window ${windowDays} days after each call; history begins ${HISTORY_BEGINS}`);
  console.log(`${"=".repeat(76)}\n`);

  // --- rows, calls, deals -------------------------------------------------
  const pres = await db
    .from("prescribed_actions")
    .select("id, call_id, deal_id, outcome_stage_moved, outcome_reasons")
    .eq("tenant_id", tenantId)
    .not("call_id", "is", null);
  if (pres.error) throw new Error(`prescriptions read failed: ${pres.error.message}`);
  const rows = (pres.data ?? []) as Array<{
    id: string;
    call_id: string;
    deal_id: string;
    outcome_stage_moved: Tri;
    outcome_reasons: Record<string, string> | null;
  }>;

  const callIds = [...new Set(rows.map((r) => r.call_id))];
  const calls = await db
    .from("calls")
    .select("id, deal_id, scheduled_start, call_date")
    .in("id", callIds);
  if (calls.error) throw new Error(`calls read failed: ${calls.error.message}`);
  const callById = new Map(
    ((calls.data ?? []) as Array<{
      id: string;
      deal_id: string;
      scheduled_start: string | null;
      call_date: string | null;
    }>).map((c) => [c.id, c]),
  );

  const dealIds = [...new Set(rows.map((r) => r.deal_id))];
  const deals = await db
    .from("deals")
    .select("id, account, salesforce_account_id, salesforce_link_confidence")
    .in("id", dealIds);
  if (deals.error) throw new Error(`deals read failed: ${deals.error.message}`);
  const dealById = new Map(
    ((deals.data ?? []) as Array<{
      id: string;
      account: string;
      salesforce_account_id: string | null;
      salesforce_link_confidence: string | null;
    }>).map((d) => [d.id, d]),
  );

  // Only confirmed links, the same gate every other Salesforce read uses. A
  // weaker link may point at another company, and attributing its stage move
  // to this deal would manufacture the outcome rather than miss it.
  const accountIds = [
    ...new Set(
      [...dealById.values()]
        .filter((d) => d.salesforce_link_confidence === "confirmed" && d.salesforce_account_id)
        .map((d) => d.salesforce_account_id as string),
    ),
  ];
  console.log(`  ${rows.length} rows over ${callIds.length} calls and ${dealIds.length} deals`);
  console.log(`  ${accountIds.length} confirmed-linked Salesforce accounts to read history for\n`);

  // --- Salesforce ---------------------------------------------------------
  const since = `${HISTORY_BEGINS}T00:00:00Z`;
  const [hist, opps] = await Promise.all([
    loadStageHistoryForAccounts(accountIds, since),
    loadOpportunityCreationForAccounts(accountIds),
  ]);
  if (hist.status === "unavailable") {
    console.error(`  history read failed: ${hist.error}\n  Nothing written.\n`);
    process.exit(1);
  }
  if ("error" in opps) {
    console.error(`  opportunity read failed: ${opps.error}\n  Nothing written.\n`);
    process.exit(1);
  }
  const totalTransitions = [...hist.byAccount.values()].reduce((n, l) => n + l.length, 0);
  console.log(`  read ${totalTransitions} stage transitions across those accounts\n`);

  // --- verdict per call ---------------------------------------------------
  const verdictByCall = new Map<string, { value: Tri; reason: string; account: string }>();
  for (const callId of callIds) {
    const call = callById.get(callId);
    const deal = call ? dealById.get(call.deal_id) : undefined;
    const account = deal?.account ?? "(unknown deal)";

    if (!call) {
      verdictByCall.set(callId, { value: "unknown", reason: "call row not found", account });
      continue;
    }
    const at = call.scheduled_start ?? call.call_date;
    if (!at) {
      verdictByCall.set(callId, { value: "unknown", reason: "call has no date", account });
      continue;
    }
    if (!deal) {
      verdictByCall.set(callId, { value: "unknown", reason: "deal row not found", account });
      continue;
    }
    if (deal.salesforce_link_confidence !== "confirmed" || !deal.salesforce_account_id) {
      verdictByCall.set(callId, {
        value: "unknown",
        reason: `Salesforce link confidence is '${deal.salesforce_link_confidence ?? "none"}', so we did not read a stage for this deal`,
        account,
      });
      continue;
    }

    const v = stageMovedAfterCall({
      transitions: hist.byAccount.get(deal.salesforce_account_id) ?? [],
      callAt: String(at),
      windowDays,
      opportunities: opps.get(deal.salesforce_account_id) ?? [],
    });
    verdictByCall.set(callId, { value: v.value, reason: v.reason, account });
  }

  // --- what changes -------------------------------------------------------
  const before = new Map<Tri, number>();
  const after = new Map<Tri, number>();
  const changed: Array<{ account: string; from: Tri; to: Tri; reason: string }> = [];
  const updates: Array<{ id: string; value: Tri; reasons: Record<string, string> }> = [];

  for (const r of rows) {
    const v = verdictByCall.get(r.call_id);
    if (!v) continue;
    before.set(r.outcome_stage_moved, (before.get(r.outcome_stage_moved) ?? 0) + 1);
    after.set(v.value, (after.get(v.value) ?? 0) + 1);
    if (v.value !== r.outcome_stage_moved) {
      changed.push({ account: v.account, from: r.outcome_stage_moved, to: v.value, reason: v.reason });
    }
    updates.push({
      id: r.id,
      value: v.value,
      reasons: { ...(r.outcome_reasons ?? {}), stage_moved: v.reason },
    });
  }

  const show = (label: string, m: Map<Tri, number>) =>
    console.log(
      `  ${label.padEnd(8)} yes ${String(m.get("yes") ?? 0).padStart(4)}   ` +
        `no ${String(m.get("no") ?? 0).padStart(4)}   unknown ${String(m.get("unknown") ?? 0).padStart(4)}`,
    );
  console.log(`  outcome_stage_moved across ${rows.length} rows`);
  show("before", before);
  show("after", after);

  // A sample of the reasoning, since a number nobody can check is a number
  // nobody should trust.
  const sample = changed.slice(0, 8);
  if (sample.length > 0) {
    console.log(`\n  ${changed.length} row(s) change. First ${sample.length}:\n`);
    for (const c of sample) {
      console.log(`    ${c.account.padEnd(24)} ${c.from} -> ${c.to}`);
      console.log(`      ${c.reason}`);
    }
  }

  if (!apply) {
    console.log(`\n${"=".repeat(76)}`);
    console.log(`DRY RUN. Nothing written. Re-run with --apply to write.`);
    console.log(`${"=".repeat(76)}\n`);
    return;
  }

  let written = 0;
  let errors = 0;
  for (const u of updates) {
    const res = await db
      .from("prescribed_actions")
      .update({ outcome_stage_moved: u.value, outcome_reasons: u.reasons })
      .eq("id", u.id);
    if (res.error) {
      errors += 1;
      console.error(`    write failed for ${u.id}: ${res.error.message}`);
    } else {
      written += 1;
    }
  }
  console.log(`\n${"=".repeat(76)}`);
  console.log(`WROTE ${written} row(s), ${errors} error(s).`);
  console.log(`${"=".repeat(76)}\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
