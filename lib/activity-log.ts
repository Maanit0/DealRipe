/**
 * Activity log: a time-ordered record of everything DealRipe itself did, briefings
 * and recaps and drafts it sent to reps, weekly digests, and what it wrote back to
 * Rolldog. Pure aggregation of data that already exists (sent_messages +
 * crm_access_log), so the operator can see DealRipe's output at a glance and filter
 * it. Distinct from the Actions tab, which is the tasks reps execute.
 */

import { rolldogOppIdForDeal } from "./pilot-config";
import { supabaseAdmin } from "./supabase";

export type ActivityKind = "briefing" | "recap" | "no_show_draft" | "digest" | "rolldog_write";

export type ActivityEntry = {
  id: string;
  at: string;
  kind: ActivityKind;
  dealId: string | null;
  account: string | null;
  title: string;
  detail: string | null;
  /** The exact email HTML that was sent (recap / briefing / draft / digest). */
  bodyHtml: string | null;
  /** For a Rolldog write: the fields that were updated. */
  fields: string | null;
  /** The call this activity relates to (nearest in time on the deal), for
   *  showing when the call was and linking to the meeting. */
  callId: string | null;
  callDate: string | null;
};

const KIND_TITLE: Record<Exclude<ActivityKind, "rolldog_write">, string> = {
  briefing: "Pre-call briefing sent",
  recap: "Post-call recap sent",
  no_show_draft: "No-show follow-up drafted",
  digest: "Weekly digest sent",
};

const DISPLAY: Record<string, string> = {
  Corelogistics: "Core Logistics",
  Airamericas: "Air Americas",
  Cargocleared: "Cargo Cleared",
  Successchb: "Success CHB",
  Cbxglobal: "CBX Global",
  Fmgloballogistics: "FM Global Logistics",
  Mastercargoinc: "Master Cargo",
  Acecustomsinc: "Ace Customs",
  Cargoservicesgroup: "Cargo Services Group",
};
function pretty(a: string): string {
  return DISPLAY[a] ?? a;
}

export async function getActivityLog(tenantId: string): Promise<ActivityEntry[]> {
  const db = supabaseAdmin();
  const [dealsRes, sentRes, crmRes, callsRes] = await Promise.all([
    db.from("deals").select("id, account, external_id, rolldog_opportunity_id").eq("tenant_id", tenantId),
    db
      .from("sent_messages")
      .select("id, deal_id, call_id, kind, subject, to_email, sent_at, body_html")
      .eq("tenant_id", tenantId)
      .order("sent_at", { ascending: false }),
    db
      .from("crm_access_log")
      .select("id, opportunity_external_id, fields, allowed, operation, call_id, created_at")
      .eq("tenant_id", tenantId)
      .eq("operation", "write")
      .eq("allowed", true)
      .order("created_at", { ascending: false }),
    db.from("calls").select("id, deal_id, scheduled_start, call_date").eq("tenant_id", tenantId),
  ]);

  // Calls per deal, for tying each activity to the call it relates to (nearest
  // in time on that deal): a recap follows a call, a briefing precedes one.
  // callDateById lets us resolve a stored call_id (the bulletproof path) to its
  // date without a second query.
  const callsByDeal = new Map<string, Array<{ id: string; date: string }>>();
  const callDateById = new Map<string, string>();
  for (const c of (callsRes.data ?? []) as Array<{
    id: string;
    deal_id: string | null;
    scheduled_start: string | null;
    call_date: string | null;
  }>) {
    const date = c.scheduled_start ?? c.call_date;
    if (date) callDateById.set(c.id, date);
    if (!c.deal_id || !date) continue;
    const list = callsByDeal.get(c.deal_id) ?? [];
    list.push({ id: c.id, date });
    callsByDeal.set(c.deal_id, list);
  }
  const nearestCall = (dealId: string | null, at: string): { id: string; date: string } | null => {
    if (!dealId) return null;
    const calls = callsByDeal.get(dealId);
    if (!calls || calls.length === 0) return null;
    const t = Date.parse(at);
    let best: { id: string; date: string } | null = null;
    let bestDiff = Infinity;
    for (const c of calls) {
      const ct = Date.parse(c.date);
      if (!Number.isFinite(ct)) continue;
      const d = Math.abs(ct - t);
      if (d < bestDiff) {
        bestDiff = d;
        best = c;
      }
    }
    return best;
  };

  const deals = (dealsRes.data ?? []) as Array<{
    id: string;
    account: string;
    external_id: string | null;
    rolldog_opportunity_id: string | null;
  }>;
  const dealById = new Map(deals.map((d) => [d.id, pretty(d.account)] as const));
  // opportunity id -> deal (account, id), for resolving write-backs.
  const oppToDeal = new Map<string, { account: string; id: string }>();
  for (const d of deals) {
    const opp = (d.external_id ? rolldogOppIdForDeal(d.external_id) : null) ?? d.rolldog_opportunity_id;
    if (opp) oppToDeal.set(String(opp), { account: pretty(d.account), id: d.id });
  }

  const out: ActivityEntry[] = [];

  for (const m of (sentRes.data ?? []) as Array<{
    id: string;
    deal_id: string | null;
    call_id: string | null;
    kind: string;
    subject: string | null;
    to_email: string | null;
    sent_at: string;
    body_html: string | null;
  }>) {
    const kind = (["briefing", "recap", "no_show_draft", "digest"].includes(m.kind) ? m.kind : "recap") as Exclude<ActivityKind, "rolldog_write">;
    // Prefer the call_id stored on the message (hard link, set on every recap /
    // briefing / no-show draft going forward). Fall back to nearest-in-time only
    // for legacy rows written before call_id was stored.
    const stored = m.call_id ? { id: m.call_id, date: callDateById.get(m.call_id) ?? m.sent_at } : null;
    const call = kind === "digest" ? null : stored ?? nearestCall(m.deal_id, m.sent_at);
    out.push({
      id: `sm-${m.id}`,
      at: m.sent_at,
      kind,
      dealId: m.deal_id,
      account: m.deal_id ? dealById.get(m.deal_id) ?? null : null,
      title: KIND_TITLE[kind],
      detail: m.to_email ? `To ${m.to_email}` : m.subject,
      bodyHtml: m.body_html,
      fields: null,
      callId: call?.id ?? null,
      callDate: call?.date ?? null,
    });
  }

  for (const c of (crmRes.data ?? []) as Array<{
    id: string;
    opportunity_external_id: string;
    fields: unknown;
    call_id: string | null;
    created_at: string;
  }>) {
    const resolved = oppToDeal.get(String(c.opportunity_external_id));
    const fields = Array.isArray(c.fields) ? (c.fields as string[]).join(", ") : "";
    // Prefer the call_id stamped on the write (bulletproof); fall back to
    // nearest-in-time only for legacy rows written before call_id existed.
    const stored = c.call_id ? { id: c.call_id, date: callDateById.get(c.call_id) ?? c.created_at } : null;
    const call = stored ?? nearestCall(resolved?.id ?? null, c.created_at);
    out.push({
      id: `crm-${c.id}`,
      at: c.created_at,
      kind: "rolldog_write",
      dealId: resolved?.id ?? null,
      account: resolved?.account ?? `Opp ${c.opportunity_external_id}`,
      title: "Wrote to Rolldog",
      detail: fields ? `Updated ${fields}` : null,
      bodyHtml: null,
      fields: fields || null,
      callId: call?.id ?? null,
      callDate: call?.date ?? null,
    });
  }

  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return out;
}
