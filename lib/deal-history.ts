/**
 * Deal history: which call confirmed each gate, and a per-call timeline of what
 * every meeting moved forward. Read-side, from field_extractions'
 * last_updated_from_call_id joined to calls, so a sales leader can inspect how
 * the deal progressed across meetings, not just its current snapshot.
 */

import type { Framework } from "./framework";
import { supabaseAdmin } from "./supabase";

export type GateAttribution = { callId: string; callDate: string | null };

export type TimelineGate = {
  fieldKey: string;
  label: string;
  answer: string | null;
  evidence: string | null;
};

export type TimelineEntry = {
  callId: string;
  callDate: string | null;
  confirmed: TimelineGate[];
};

export type DealHistory = {
  /** fieldKey -> the call that last confirmed it (for inline attribution). */
  perGate: Record<string, GateAttribution>;
  /** One entry per call, newest first, with the gates it confirmed. */
  timeline: TimelineEntry[];
};

export async function getDealHistory(
  tenantId: string,
  dealId: string,
  framework: Framework,
): Promise<DealHistory> {
  const db = supabaseAdmin();
  const fx = await db
    .from("field_extractions")
    .select("framework_field_key, last_updated_from_call_id, answer, evidence")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId)
    .eq("status", "Yes")
    .not("last_updated_from_call_id", "is", null);
  const rows = fx.data ?? [];
  if (rows.length === 0) return { perGate: {}, timeline: [] };

  const callIds = [
    ...new Set(rows.map((r) => r.last_updated_from_call_id).filter((x): x is string => !!x)),
  ];
  const dateByCall: Record<string, string | null> = {};
  if (callIds.length > 0) {
    const calls = await db
      .from("calls")
      .select("id, call_date, scheduled_start")
      .in("id", callIds);
    for (const c of calls.data ?? []) {
      // Prefer the meeting timestamp (has a time, unambiguous) over a date-only
      // call_date, which is prone to off-by-one when rendered across timezones.
      dateByCall[c.id] = c.scheduled_start ?? c.call_date ?? null;
    }
  }

  const labelByKey = new Map(framework.fields.map((f) => [f.fieldKey, f.label]));
  const perGate: Record<string, GateAttribution> = {};
  const byCall = new Map<string, TimelineGate[]>();
  for (const r of rows) {
    const callId = r.last_updated_from_call_id as string;
    perGate[r.framework_field_key] = { callId, callDate: dateByCall[callId] ?? null };
    const list = byCall.get(callId) ?? [];
    list.push({
      fieldKey: r.framework_field_key,
      label: labelByKey.get(r.framework_field_key) ?? r.framework_field_key,
      answer: r.answer ?? null,
      evidence: r.evidence ?? null,
    });
    byCall.set(callId, list);
  }

  const timeline: TimelineEntry[] = [...byCall.entries()]
    .map(([callId, confirmed]) => ({ callId, callDate: dateByCall[callId] ?? null, confirmed }))
    .sort(
      (a, b) =>
        new Date(b.callDate ?? 0).getTime() - new Date(a.callDate ?? 0).getTime(),
    );

  return { perGate, timeline };
}
