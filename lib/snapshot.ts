/**
 * Deal signal snapshots: the time-series that powers the digest, the
 * "what changed this week" view, and the commit-reality mismatch.
 *
 * A snapshot captures the deal's state at a point in time as JSON in
 * deal_signal_snapshots.signals. The digest is a diff of two snapshots
 * (this week vs last), so snapshots must be written from the day a deal
 * goes live, or the first digest has nothing to compare against.
 *
 * Two gate truths are stored separately and never collapsed:
 *   gatesDealripe = what the calls prove (from extraction)
 *   gatesRolldog  = what the rep ticked (from the live Rolldog read; null
 *                   until that read is wired). Their divergence is the
 *                   commit-reality mismatch.
 */

import type { Json } from "./database.types";
import { inferStageKey } from "./deal-state";
import { getFrameworkForDeal } from "./framework";
import type { Framework } from "./framework";
import {
  frameworkProgress,
  frameworkStages,
  stageGateStatus,
} from "./framework-stages";
import { runWithAuthorizedOpportunities } from "./crm-scope";
import { rolldogOppIdForDeal } from "./pilot-config";
import { readRolldogSummary, stageKeyFromSummary } from "./rolldog-summary";
import type { Deal } from "./seed-data";
import { supabaseAdmin } from "./supabase";
import { getDealsForTenant } from "./supabase-queries";

export type StageGateSnapshot = {
  met: number;
  total: number;
  open: string[];
};

/**
 * Rolldog's OWN state for the deal on the snapshot day, captured verbatim. This
 * is what makes "did this deal move since last week" real: the digest diffs this
 * block across the window (stage advanced, forecast raised, close pulled in),
 * instead of inferring stage from calls (which overshoots). Null on snapshots
 * written before this was wired, or when the Rolldog read failed that day.
 */
export type RolldogSnapshot = {
  stageName: string | null;
  stageKey: string | null;
  forecastCategory: string | null;
  dealSizeMonthly: number | null;
  closeDate: string | null;
  status: string | null;
  score: string | null;
};

/**
 * WHY the rolldog block is absent, which the block itself cannot say.
 *
 *   read             Rolldog answered. `rolldog` holds what it said.
 *   no_opportunity   This deal has no Rolldog opportunity. Nothing to read.
 *                    Salesforce-only deals live here.
 *   unavailable      The read failed. We know nothing, including whether the
 *                    deal has an opportunity at all.
 *
 * These were collapsed into one null, and the deals lookup dropped its error
 * on the floor besides. Anything asking "did this deal's CRM stage move"
 * across two snapshots has to answer "unknown" for the last two cases and
 * would otherwise answer "no", which is the exact substitution of absence of
 * evidence for evidence of absence this codebase keeps paying for.
 *
 * Absent on snapshots written before this was wired, which callers must also
 * treat as unknown rather than assuming `read`.
 */
export type RolldogReadStatus = "read" | "no_opportunity" | "unavailable";

export type RolldogRead =
  | { status: "read"; snapshot: RolldogSnapshot }
  | { status: "no_opportunity"; snapshot: null }
  | { status: "unavailable"; snapshot: null; error: string };

export type DealSignals = {
  stage: string;
  amount: number;
  closeDate: string;
  daysInStage: number;
  // Per-stage gate completion from the call evidence (DealRipe's view).
  gatesDealripe: Record<string, StageGateSnapshot>;
  // Rep-ticked gate state from Rolldog. Null until the live read is wired.
  gatesRolldog: Record<string, StageGateSnapshot> | null;
  // Rolldog's own current state this day (for real week-over-week movement).
  rolldog?: RolldogSnapshot | null;
  // Why `rolldog` is what it is. Additive: every existing consumer of
  // `rolldog` (lib/pipeline-changes.ts, scripts/deal-category-check.ts) is
  // unaffected, and anything that needs to tell "no opportunity" from "the
  // read failed" now can.
  rolldogRead?: RolldogReadStatus;
  // Per-field answered state (Yes only; for diffing what newly answered).
  answered: string[];
  // Coarse risk flags computed from the signals.
  risks: string[];
  capturedAt: string;
};

/**
 * Resolve each deal's live Rolldog state for the day's snapshot. One core read
 * per Rolldog-linked deal, best-effort. Opp resolution mirrors the digest
 * engine: the static pilot map wins, else the stored column (statically-mapped
 * pilot deals don't carry the column).
 *
 * Returns WHY there is no snapshot, never a bare null. Three things used to
 * produce the same null here: a deal with no Rolldog opportunity, a Rolldog
 * read that failed, and a deals lookup that failed (its error was discarded by
 * `const { data }`, so a broken query returned an empty map and every deal
 * silently lost its rolldog block for the day). Only the first is a fact about
 * the deal.
 *
 * A FOURTH thing was producing it, and it was us. The read below was the only
 * one on this path not wrapped in runWithAuthorizedOpportunities, so the scope
 * guard refused every opportunity outside the static allowlist and the refusal
 * arrived as a failed read. Between 2026-07-17 and 2026-08-16 that was 5,464
 * refusals, and 21 live deals (Dunavant, Milsped, Gezairi, Unitedchb,
 * Cargoservicesgroup and the rest) recorded a month of snapshots carrying no
 * CRM stage at all. Everything downstream of those snapshots, the digest's
 * movement detection, readStageMoved in the prescription ledger, and the
 * per-rep calibration those snapshots exist to make possible, was reading our
 * own refusal as a deal that had not moved.
 *
 * lib/deal-context.ts made the identical call on the identical opportunity
 * wrapped, which is why a briefing for one of those deals showed its CRM stage
 * on the same day its snapshot showed none.
 */
export async function resolveRolldogSnapshots(
  tenantId: string,
  dealIds: string[],
): Promise<Map<string, RolldogRead>> {
  const out = new Map<string, RolldogRead>();
  if (dealIds.length === 0) return out;
  const db = supabaseAdmin();
  const res = await db
    .from("deals")
    .select("id, external_id, rolldog_opportunity_id")
    .eq("tenant_id", tenantId)
    .in("id", dealIds);
  if (res.error) {
    // Say it, for every deal asked about. Returning an empty map would have
    // each caller conclude "no Rolldog opportunity" for deals that have one.
    const error = `deals lookup failed: ${res.error.message}`;
    console.error(`[snapshot] ${error}; no deal can be read from Rolldog this run`);
    for (const id of dealIds) out.set(id, { status: "unavailable", snapshot: null, error });
    return out;
  }
  const rows = (res.data ?? []) as Array<{ id: string; external_id: string | null; rolldog_opportunity_id: string | null }>;
  const seen = new Set(rows.map((r) => r.id));
  for (const id of dealIds) {
    // Asked about, not returned. That is a missing deal row, not a deal
    // without an opportunity.
    if (!seen.has(id)) {
      out.set(id, { status: "unavailable", snapshot: null, error: "deal not found in tenant" });
    }
  }
  await Promise.all(
    rows.map(async (r) => {
      const opp = (r.external_id ? rolldogOppIdForDeal(r.external_id) : null) ?? r.rolldog_opportunity_id;
      if (!opp) {
        out.set(r.id, { status: "no_opportunity", snapshot: null });
        return;
      }
      // readRolldogSummary rather than getRolldogSummary: the latter maps a
      // failed read to null, which is the distinction this function exists to
      // preserve.
      //
      // Authorize this one opportunity for the duration of this one read, the
      // same wrapper and for the same reason as lib/deal-context.ts. The scope
      // guard is fail-closed and only the static pilot ids pass by default, so
      // without this every opportunity the reconciler linked throws and the
      // deal snapshots as though it has no CRM record. Per-call and per-
      // opportunity: PILOT_OPPORTUNITY_IDS is not widened, nothing else
      // becomes readable, and a deal with no linked opportunity still reaches
      // nothing at all because the `if (!opp)` above returned already.
      const oppId = String(opp);
      const read = await runWithAuthorizedOpportunities([oppId], () =>
        readRolldogSummary(oppId),
      );
      if (read.status !== "ok") {
        out.set(r.id, { status: "unavailable", snapshot: null, error: read.error });
        return;
      }
      const s = read.summary;
      out.set(r.id, {
        status: "read",
        snapshot: {
          stageName: s.stageName,
          stageKey: stageKeyFromSummary(s),
          forecastCategory: s.forecastCategory,
          dealSizeMonthly: s.dealSize,
          closeDate: s.closeDate,
          status: s.status,
          score: s.score,
        },
      });
    }),
  );
  return out;
}

function computeRisks(deal: Deal, framework: Framework): string[] {
  const risks: string[] = [];
  const ex = deal.extraction;
  const answered = (k: string) => ex[k]?.status === "Yes";

  // Economic buyer / exec involvement not engaged.
  if (framework.fields.some((f) => f.fieldKey === "sql4_exec_involvement") && !answered("sql4_exec_involvement")) {
    risks.push("economic_buyer_not_engaged");
  }
  // No competitor identified yet.
  if (framework.fields.some((f) => f.fieldKey === "competition_notes") && !answered("competition_notes")) {
    risks.push("competitor_unknown");
  }
  // Close date not validated.
  if (framework.fields.some((f) => f.fieldKey === "close_date_validated") && !answered("close_date_validated")) {
    risks.push("close_date_unvalidated");
  }
  // Stalled in stage.
  if (deal.daysInStage > 30) risks.push("stalled_in_stage");
  return risks;
}

export function buildSignals(
  deal: Deal,
  framework: Framework,
  rolldog?: RolldogRead | null,
): DealSignals {
  const stages = frameworkStages(framework);
  const gatesDealripe: Record<string, StageGateSnapshot> = {};
  for (const s of stages) {
    const g = stageGateStatus(s, deal.extraction);
    gatesDealripe[s.key] = { met: g.met, total: g.total, open: g.openKeys };
  }
  const answered = framework.fields
    .filter((f) => deal.extraction[f.fieldKey]?.status === "Yes")
    .map((f) => f.fieldKey);

  return {
    // Calls-first stage: what the extraction proves, not the (possibly stale or
    // absent) CRM stage. Keeps the snapshot, digest, and forecast on the same
    // truth as the briefing and deal page.
    stage: inferStageKey(framework, deal.extraction, deal.stageKey),
    amount: deal.arr,
    closeDate: deal.repForecastCloseDate,
    daysInStage: deal.daysInStage,
    gatesDealripe,
    gatesRolldog: null,
    rolldog: rolldog?.snapshot ?? null,
    // A snapshot with no read at all is recorded as unavailable, not as a deal
    // without an opportunity. Callers cannot tell the difference from the
    // rolldog block alone, and guessing the generous answer is how "no CRM
    // movement" gets reported for a deal nobody managed to read.
    rolldogRead: rolldog?.status ?? "unavailable",
    answered,
    risks: computeRisks(deal, framework),
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Write one snapshot for a deal. snapshot_date is the calendar date so a
 * re-run on the same day overwrites (one snapshot per deal per day).
 */
export async function recordDealSnapshot(
  tenantId: string,
  deal: Deal,
  framework: Framework,
  rolldog?: RolldogRead | null,
): Promise<void> {
  const db = supabaseAdmin();
  const { confirmed, total } = frameworkProgress(framework, deal.extraction);
  const completion = total > 0 ? confirmed / total : 0;
  const signals = buildSignals(deal, framework, rolldog);
  const snapshotDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const res = await db.from("deal_signal_snapshots").upsert(
    {
      tenant_id: tenantId,
      deal_id: deal.id,
      snapshot_date: snapshotDate,
      signals: signals as unknown as Json,
      dealripe_forecast: {
        // Directional read, not false precision: rep probability tempered
        // by how much of the framework the calls actually confirm.
        probability: Math.round(deal.repForecastProbability * completion * 100) / 100,
        closeDate: deal.repForecastCloseDate,
        confirmed,
        total,
      } as unknown as Json,
      rep_commit: `${Math.round(deal.repForecastProbability * 100)}%`,
    },
    { onConflict: "deal_id,snapshot_date" },
  );
  if (res.error) {
    throw new Error(`snapshot write failed for deal ${deal.id}: ${res.error.message}`);
  }
}

/**
 * Record a snapshot for every deal in the tenant: read each deal's live Rolldog
 * state and write today's snapshot row (upsert on deal_id,snapshot_date, so a
 * re-run inside the same day just refreshes today's values). Shared by the daily
 * snapshot cron and by the digest cron, which runs this first so the digest and
 * everything reading the latest snapshot reflect current Rolldog, not yesterday's.
 * Returns the number of deals written.
 */
export async function recordAllDealSnapshots(tenantId: string): Promise<number> {
  const all = await getDealsForTenant(tenantId);

  // A resolved deal has no more moves to record.
  //
  // Eleven deals whose Salesforce account carried only closed opportunities
  // accrued 213 four-hourly snapshots after they had already been won or lost,
  // and the digest's movement detection read every one of them as a live deal
  // that had not moved. The existing snapshots are kept: outcome-sync backfills
  // outcome_label onto them and they are the calibration substrate. It is only
  // the new ones that are pointless.
  const db = supabaseAdmin();
  const resolved = await db
    .from("deals")
    .select("id")
    .eq("tenant_id", tenantId)
    .not("outcome_label", "is", null);
  let deals = all;
  if (resolved.error) {
    // Snapshot everything rather than nothing. Skipping the whole run on a
    // failed read would lose a day of history to protect against a few extra
    // rows, and a missing snapshot is far more expensive than a spare one.
    console.warn(
      `[snapshot] could not read outcome labels, snapshotting every deal: ${resolved.error.message}`,
    );
  } else {
    const done = new Set((resolved.data ?? []).map((r) => (r as { id: string }).id));
    deals = all.filter((d) => !done.has(d.id));
    if (done.size > 0) {
      console.log(`[snapshot] skipping ${all.length - deals.length} resolved deal(s)`);
    }
  }

  const rolldogByDeal = await resolveRolldogSnapshots(
    tenantId,
    deals.map((d) => d.id),
  );
  let written = 0;
  for (const deal of deals) {
    const framework = await getFrameworkForDeal(deal.id);
    if (!framework) continue;
    await recordDealSnapshot(tenantId, deal, framework, rolldogByDeal.get(deal.id) ?? null);
    written += 1;
  }
  return written;
}
