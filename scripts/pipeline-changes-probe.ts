/**
 * Feasibility probe for Mark's "what's changed" pipeline dashboard (the Kent /
 * Salesforce-in-Snowflake view, but for Rolldog).
 *
 * The important architecture fact: Rolldog (like Salesforce) exposes CURRENT
 * state, not a change history. Kent's dashboard computes changes by diffing
 * snapshots over time. DealRipe already snapshots every deal daily in
 * deal_signal_snapshots, so it can produce the same change events by diffing its
 * own snapshots, and those snapshots are call-derived, so they reflect what was
 * actually said on calls even when the rep has not updated Rolldog.
 *
 * This probe confirms, per Rolldog-linked deal:
 *   1. how many DealRipe snapshots exist (can we diff a window?)
 *   2. the change events DealRipe would show (stage / amount / close / forecast)
 *   3. what Rolldog currently returns (stage / close_date / amount / next_step)
 *   4. where DealRipe's call-truth stage diverges from Rolldog's rep-entered stage
 *      (the "rep hasn't logged this" signal that is DealRipe's differentiator)
 *
 * Read-only. The Rolldog read is live (runs on your Mac, not the sandbox).
 *
 *   npx tsx scripts/pipeline-changes-probe.ts                 # last 14 days, no live Rolldog read
 *   npx tsx scripts/pipeline-changes-probe.ts --days 30 --rolldog
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { getDealRoom } from "../lib/rolldog";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Snap = { date: string; stage: string; amount: number; closeDate: string; prob: number };

function changeEvents(snaps: Snap[]): string[] {
  const out: string[] = [];
  const track = (label: string, get: (s: Snap) => string | number) => {
    let last: string | number | null = null;
    for (const s of snaps) {
      const v = get(s);
      if (last !== null && String(v) !== String(last)) out.push(`  ${label}: ${last} -> ${v}  (on ${s.date})`);
      last = v;
    }
  };
  track("stage", (s) => s.stage);
  track("amount", (s) => s.amount);
  track("closeDate", (s) => s.closeDate);
  track("forecast prob", (s) => s.prob);
  return out;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? "14");
  const withRolldog = process.argv.includes("--rolldog");
  let dumpedKeys = false; // dump the full Rolldog attribute set once, for discovery
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const sinceDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, outcome_label, created_at")
    .eq("tenant_id", tenantId);
  const deals = (dealsRes.data ?? []) as Array<{
    id: string;
    account: string;
    external_id: string | null;
    rolldog_opportunity_id: string | null;
    outcome_label: string | null;
    created_at: string;
  }>;

  console.log(`\nPipeline-changes probe (last ${days} days, since ${sinceDate})\n`);

  for (const d of deals) {
    const opp = (d.external_id ? rolldogOppIdForDeal(d.external_id) : null) ?? d.rolldog_opportunity_id;
    if (!opp) continue; // only Rolldog-linked deals feed the write-back / mismatch view

    const snapRes = await db
      .from("deal_signal_snapshots")
      .select("snapshot_date, signals, dealripe_forecast")
      .eq("deal_id", d.id)
      .gte("snapshot_date", sinceDate)
      .order("snapshot_date", { ascending: true });
    const snaps: Snap[] = ((snapRes.data ?? []) as Array<Record<string, unknown>>).map((r) => {
      const sig = (r.signals ?? {}) as Record<string, unknown>;
      const fc = (r.dealripe_forecast ?? {}) as Record<string, unknown>;
      return {
        date: String(r.snapshot_date),
        stage: String(sig.stage ?? "—"),
        amount: Number(sig.amount ?? 0),
        closeDate: String(sig.closeDate ?? "—"),
        prob: Number(fc.probability ?? 0),
      };
    });

    console.log(`=== ${d.account} (opp ${opp}) ===`);
    console.log(`  Snapshots in window: ${snaps.length}${snaps.length ? ` (${snaps[0].date} .. ${snaps[snaps.length - 1].date})` : ""}`);
    if (d.outcome_label) console.log(`  DealRipe outcome_label: ${d.outcome_label} (our field, not Rolldog)`);

    const events = changeEvents(snaps);
    if (events.length) {
      console.log(`  DealRipe change events:`);
      for (const e of events) console.log(e);
    } else {
      console.log(`  DealRipe change events: none in window`);
    }

    if (withRolldog) {
      try {
        const room = await getDealRoom(String(opp));
        const a = room.core as Record<string, unknown>;
        const attrs = (a.attributes ?? a) as Record<string, unknown>;
        const pick = (k: string) => attrs[k] ?? attrs[k.replace(/_/g, "-")] ?? "—";
        // Discovery: show the full attribute set once so we can confirm exactly
        // which fields exist for won/lost, created date, age, etc.
        if (!dumpedKeys) {
          console.log(`  [Rolldog attribute keys] ${Object.keys(attrs).join(", ")}`);
          dumpedKeys = true;
        }
        // Correct Rolldog field names (from the attribute-key dump).
        const created = String(pick("created-at")).slice(0, 10);
        const isNewInWindow = created !== "—" && created >= sinceDate;
        console.log(`  Rolldog (rep-entered):`);
        console.log(`    stage=${pick("stage-name")} (id ${pick("stage")})  forecast=${pick("forecast-category")}  %=${pick("percentage")}`);
        console.log(`    deal_size=${pick("deal-size")}  close_date=${pick("close-date")}`);
        console.log(`    status=${pick("status")}  status_reason=${pick("status-reason")}  archived=${pick("archived")}  score=${pick("score")}`);
        console.log(`    created_at=${created}${isNewInWindow ? "  <-- NEW opp in window" : ""}  current_stage_date=${String(pick("current-stage-date")).slice(0, 10)}  updated_at=${String(pick("updated-at")).slice(0, 10)}`);
        const dealripeStage = snaps.length ? snaps[snaps.length - 1].stage : "—";
        console.log(`  DealRipe (calls): ${dealripeStage}   |   Rolldog (rep): ${pick("stage-name")}   [need SQL<->Rolldog stage map to judge divergence]`);
      } catch (err) {
        console.log(`  Rolldog read failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log("");
  }

  console.log(`Legend: change events come from diffing DealRipe's daily snapshots (call-derived).`);
  console.log(`Run with --rolldog to compare against Rolldog's current rep-entered values.`);
  if (!withRolldog) console.log(`(Skipped the live Rolldog read; add --rolldog to include it.)`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
