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
import type { Framework } from "./framework";
import {
  frameworkProgress,
  frameworkStages,
  stageGateStatus,
} from "./framework-stages";
import type { Deal } from "./seed-data";
import { supabaseAdmin } from "./supabase";

export type StageGateSnapshot = {
  met: number;
  total: number;
  open: string[];
};

export type DealSignals = {
  stage: string;
  amount: number;
  closeDate: string;
  daysInStage: number;
  // Per-stage gate completion from the call evidence (DealRipe's view).
  gatesDealripe: Record<string, StageGateSnapshot>;
  // Rep-ticked gate state from Rolldog. Null until the live read is wired.
  gatesRolldog: Record<string, StageGateSnapshot> | null;
  // Per-field answered state (Yes only; for diffing what newly answered).
  answered: string[];
  // Coarse risk flags computed from the signals.
  risks: string[];
  capturedAt: string;
};

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

export function buildSignals(deal: Deal, framework: Framework): DealSignals {
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
    stage: deal.stageKey,
    amount: deal.arr,
    closeDate: deal.repForecastCloseDate,
    daysInStage: deal.daysInStage,
    gatesDealripe,
    gatesRolldog: null,
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
): Promise<void> {
  const db = supabaseAdmin();
  const { confirmed, total } = frameworkProgress(framework, deal.extraction);
  const completion = total > 0 ? confirmed / total : 0;
  const signals = buildSignals(deal, framework);
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
