/**
 * Forward-compat seam for the calibration / closed-loop pipeline.
 *
 * Two tables are addressed:
 *   - deal_signal_snapshots: a daily projection of the deal's qualification
 *     signals + (optional) DealRipe forecast + (optional) rep commit; the
 *     outcome_label is backfilled at deal close so the model can learn
 *     calibration against ground truth.
 *   - prescribed_actions: per-call gap-closing prescriptions emitted by
 *     pre-call briefing. Tracked here so we can later answer "was the rep
 *     asked to address this, and did they?"
 *
 * No cron, no business logic yet. This module exists so briefing code +
 * future sync code can write rows with typed, validated payloads instead
 * of constructing inserts by hand.
 *
 * Both inserts are idempotent against their natural keys:
 *   - deal_signal_snapshots is keyed (deal_id, snapshot_date); a second
 *     call for the same day updates the row.
 *   - prescribed_actions has no uniqueness — duplicate calls produce
 *     duplicate rows, which is the desired behavior (each briefing run
 *     is a distinct event).
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

export type RecordPrescriptionArgs = {
  tenantId: string;
  dealId: string;
  /** Microsoft Graph event id of the upcoming call. Null when not yet scheduled. */
  callExternalId?: string | null;
  /** The framework field this prescription targets. */
  frameworkFieldKey: string;
  /** Human-readable prescription text the rep is meant to address. */
  prescription: string;
};

/**
 * Insert a prescribed action row. No deduplication: every briefing run
 * that surfaces a gap produces a new row, even for the same field. The
 * calibration job downstream pairs these against the next call's
 * extraction to populate asked_on_next_call.
 */
export async function recordPrescription(
  args: RecordPrescriptionArgs,
): Promise<void> {
  const db = supabaseAdmin();
  const { error } = await db.from("prescribed_actions").insert({
    tenant_id: args.tenantId,
    deal_id: args.dealId,
    call_external_id: args.callExternalId ?? null,
    framework_field_key: args.frameworkFieldKey,
    prescription: args.prescription,
  });
  if (error) {
    throw new Error(
      `prescribed_actions insert failed for deal=${args.dealId} field=${args.frameworkFieldKey}: ${error.message}`,
    );
  }
}
