/**
 * Forward-compat seam for the calibration / closed-loop pipeline.
 *
 * Two tables are addressed:
 *   - deal_signal_snapshots: a daily projection of the deal's qualification
 *     signals + (optional) DealRipe forecast + (optional) rep commit; the
 *     outcome_label is backfilled at deal close so the model can learn
 *     calibration against ground truth.
 *   - prescribed_actions: MOVED. The prescription ledger now lives in
 *     lib/prescription-ledger.ts (writing) and lib/prescription-scoring.ts
 *     (scoring). recordPrescription used to live here and nothing ever
 *     called it, which is how the table stayed empty while
 *     lib/briefing-history.ts read it and lib/outcome-sync.ts backfilled
 *     it. Do not add a second writer here.
 *
 * This module exists so snapshot code can write rows with typed, validated
 * payloads instead of constructing inserts by hand.
 *
 * deal_signal_snapshots is keyed (deal_id, snapshot_date); a second call
 * for the same day updates the row.
 */

import type { Json } from "./database.types";
import { supabaseAdmin } from "./supabase";

export type RecordSnapshotArgs = {
  tenantId: string;
  dealId: string;
  /** ISO date (YYYY-MM-DD). Uniqueness key with deal_id. */
  snapshotDate: string;
  /** Framework field states + evidence ages + any timeline/attendance flags. */
  signals: Json;
  /** Optional DealRipe forecast snapshot (probability, close date, confidence). */
  dealripeForecast?: Json | null;
  /** Optional rep-submitted commit ("commit", "best case", "pipeline", etc.). */
  repCommit?: string | null;
};

/**
 * Upsert a deal signal snapshot for the given date. Idempotent on
 * (deal_id, snapshot_date) — a same-day re-run updates the row in place.
 *
 * The outcome_label is intentionally NOT settable here; it gets
 * backfilled by a separate calibration job at deal close.
 */
export async function recordSnapshot(args: RecordSnapshotArgs): Promise<void> {
  const db = supabaseAdmin();
  const { error } = await db.from("deal_signal_snapshots").upsert(
    {
      tenant_id: args.tenantId,
      deal_id: args.dealId,
      snapshot_date: args.snapshotDate,
      signals: args.signals,
      dealripe_forecast: args.dealripeForecast ?? null,
      rep_commit: args.repCommit ?? null,
    },
    { onConflict: "deal_id,snapshot_date" },
  );
  if (error) {
    throw new Error(
      `deal_signal_snapshots upsert failed for deal=${args.dealId} date=${args.snapshotDate}: ${error.message}`,
    );
  }
}

// recordPrescription was here. See lib/prescription-ledger.ts.
