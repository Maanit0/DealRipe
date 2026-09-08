/**
 * Record WHEN a qualification gate moved, and what moved it.
 *
 * field_extractions holds current state and is upserted, so it cannot answer
 * "which call first answered this gate". last_updated_from_call_id looks like
 * it should, and does not: it is refreshed by every later call that touches the
 * field even when the payload is unchanged, so on a deal with six calls every
 * gate points at the most recent one.
 *
 * This writes the transition beside the row rather than changing the row's
 * shape, because field_extractions has more than ten readers that assume one
 * record per (deal, field).
 *
 * WHAT IT DELIBERATELY DOES NOT LOG. A re-observation that changes nothing.
 * The snapshot table is the cautionary tale: deal_signal_snapshots writes a
 * capturedAt into its own payload, so a byte comparison of consecutive days
 * differs always and 47 "changes" over 48 days were really 8. An event log that
 * fires on every call is a call log, not a trajectory.
 *
 * Nothing reads this yet, and that is stated rather than hidden. It exists so
 * the trajectory starts accumulating now: the similarity and next-best-action
 * work needs gate transitions that no amount of later data can reconstruct.
 */

import type { ExtractionResult } from "./scotsman";
import { supabaseAdmin } from "./supabase";

export type GateTransition = {
  fieldKey: string;
  /** null on the first observation of a field, which is different from No -> Yes. */
  fromStatus: string | null;
  toStatus: string;
  fromAnswer: string | null;
  toAnswer: string | null;
  evidence: string | null;
  confidence: number | null;
};

/**
 * Build the events from the flip list PRODUCTION already computed.
 *
 * mergeExtraction returns changedIds, which tracks status flips only and
 * deliberately excludes a Yes being re-observed with different wording. That is
 * precisely the transition worth recording, so this reads its answer rather
 * than computing a second one: a diff that can disagree with the writer will,
 * and this codebase has the scars.
 */
export function transitionsFrom(args: {
  changedIds: ReadonlyArray<string>;
  prior: ExtractionResult;
  merged: ExtractionResult;
}): GateTransition[] {
  const out: GateTransition[] = [];
  for (const fieldKey of args.changedIds) {
    const next = args.merged[fieldKey];
    if (!next) continue;
    const before = args.prior[fieldKey];
    out.push({
      fieldKey,
      fromStatus: before?.status ?? null,
      toStatus: next.status,
      fromAnswer: (before as { answer?: string | null } | undefined)?.answer ?? null,
      toAnswer: (next as { answer?: string | null }).answer ?? null,
      evidence: (next as { evidence?: string | null }).evidence ?? null,
      confidence: (next as { confidence?: number | null }).confidence ?? null,
    });
  }
  return out;
}

/**
 * Persist the transitions. Best effort by design: a failure here must never
 * fail an ingest, because the extraction itself is the thing the pilot runs on
 * and this is instrumentation beside it.
 *
 * Idempotent on (deal, field, call) at the database level, so a re-ingest of
 * the same call is a no-op rather than a duplicate flip.
 */
export async function recordGateTransitions(args: {
  tenantId: string;
  dealId: string;
  frameworkId: string | null;
  callId: string | null;
  transitions: GateTransition[];
}): Promise<number> {
  if (args.transitions.length === 0) return 0;
  // The call's own date, so a trajectory reads correctly when a transcript is
  // ingested days late. Looked up here rather than threaded through
  // writeAuditTrail's callers, and only when there is something to write.
  let occurredAt: string | null = null;
  if (args.callId) {
    const c = await supabaseAdmin()
      .from("calls")
      .select("call_date, scheduled_start")
      .eq("id", args.callId)
      .maybeSingle();
    occurredAt = c.data?.call_date ?? c.data?.scheduled_start ?? null;
  }
  const rows = args.transitions.map((t) => ({
    tenant_id: args.tenantId,
    deal_id: args.dealId,
    framework_field_key: t.fieldKey,
    framework_id: args.frameworkId,
    from_status: t.fromStatus,
    to_status: t.toStatus,
    from_answer: t.fromAnswer,
    to_answer: t.toAnswer,
    evidence: t.evidence,
    confidence: t.confidence,
    source_call_id: args.callId,
    occurred_at: occurredAt,
  }));
  try {
    const res = await supabaseAdmin()
      .from("field_extraction_events")
      .upsert(rows, { onConflict: "deal_id,framework_field_key,source_call_id", ignoreDuplicates: true })
      .select("id");
    if (res.error) {
      console.error(`[gate-events] write failed (${rows.length} rows, deal=${args.dealId}): ${res.error.message}`);
      return 0;
    }
    return res.data?.length ?? 0;
  } catch (err) {
    console.error("[gate-events] write threw, continuing:", err);
    return 0;
  }
}
