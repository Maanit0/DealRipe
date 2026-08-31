/**
 * Activity log: a time-ordered record of everything DealRipe itself did, briefings
 * and recaps and drafts it sent to reps, weekly digests, and what it wrote back to
 * Rolldog. Pure aggregation of data that already exists (sent_messages +
 * crm_access_log), so the operator can see DealRipe's output at a glance and filter
 * it. Distinct from the Actions tab, which is the tasks reps execute.
 */

import { rolldogOppIdForDeal } from "./pilot-config";
import { supabaseAdmin } from "./supabase";

export type ActivityKind =
  | "briefing"
  | "recap"
  | "no_show_draft"
  | "followup_draft"
  | "digest"
  | "link_escalation"
  | "reengage_draft"
  | "draft_ready"
  | "unknown"
  | "rolldog_write"
  | "salesforce_write";

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
  /**
   * What was actually written, label and value, recorded at write time.
   *
   * Null for everything except a permitted CRM write, and for writes that
   * predate crm_access_log.field_values. Null is "we did not record it", never
   * "nothing was written": the field names in `fields` still apply.
   */
  values: Array<{ label: string; value: string; mode?: string }> | null;
  /** The call this activity relates to (nearest in time on the deal), for
   *  showing when the call was and linking to the meeting. */
  callId: string | null;
  callDate: string | null;
};

const KIND_TITLE: Record<Exclude<ActivityKind, "rolldog_write" | "salesforce_write">, string> = {
  briefing: "Pre-call briefing sent",
  recap: "Post-call recap sent",
  no_show_draft: "No-show follow-up drafted",
  followup_draft: "Follow-up email drafted",
  digest: "Weekly digest sent",
  link_escalation: "Link escalation sent",
  // DRAFTED, not sent. "Message sent . Transportnstore / To
  // yaremi@transportnstore.com" read as DealRipe having emailed the customer,
  // which it has never done and cannot do: Mail.Send is deliberately not
  // granted. It wrote a draft in the rep's mailbox.
  reengage_draft: "Re-engagement email drafted",
  draft_ready: "Draft ready notice sent",
  unknown: "Message sent",
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
    db
      .from("deals")
      .select("id, account, external_id, rolldog_opportunity_id, salesforce_account_id")
      .eq("tenant_id", tenantId),
    db
      .from("sent_messages")
      .select("id, deal_id, call_id, kind, subject, to_email, sent_at, body_html")
      .eq("tenant_id", tenantId)
      .order("sent_at", { ascending: false }),
    db
      .from("crm_access_log")
      .select(
        "id, opportunity_external_id, fields, allowed, operation, call_id, created_at, system, field_values, violation_reason",
      )
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
  /**
   * The call an activity relates to, when the row does not carry a call_id.
   *
   * Direction matters and used not to be considered. Picking the nearest call
   * in either direction attributed a CRM write made on August 10 to meetings on
   * the 12th, 13th and 14th, so the Activity view showed content as coming from
   * calls that had not happened yet. A recap or a write-back can only describe a
   * call that already occurred; a briefing can only precede one.
   *
   *   "before"  the most recent call at or before this moment
   *   "after"   the next call at or after it
   *
   * Returns null rather than reaching across the boundary. An unattributed row
   * is honest; one pointing at a future meeting is not.
   */
  const nearestCall = (
    dealId: string | null,
    at: string,
    direction: "before" | "after",
  ): { id: string; date: string } | null => {
    if (!dealId) return null;
    const calls = callsByDeal.get(dealId);
    if (!calls || calls.length === 0) return null;
    const t = Date.parse(at);
    if (!Number.isFinite(t)) return null;
    // A briefing goes out shortly before its call, and a recap shortly after,
    // so a little slack stops a few minutes of clock drift throwing the match
    // to the previous or next meeting entirely.
    const SLACK_MS = 60 * 60 * 1000;
    let best: { id: string; date: string } | null = null;
    let bestDiff = Infinity;
    for (const c of calls) {
      const ct = Date.parse(c.date);
      if (!Number.isFinite(ct)) continue;
      const d = direction === "before" ? t - ct : ct - t;
      if (d < -SLACK_MS) continue; // on the wrong side of this moment
      const mag = Math.abs(d);
      if (mag < bestDiff) {
        bestDiff = mag;
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
    salesforce_account_id?: string | null;
  }>;
  const dealById = new Map(deals.map((d) => [d.id, pretty(d.account)] as const));
  // opportunity id -> deal (account, id), for resolving write-backs.
  const oppToDeal = new Map<string, { account: string; id: string }>();
  // Salesforce Account id -> deal. Separate map, because an Account id and a
  // Rolldog opportunity id are different namespaces and collapsing them would
  // attribute a write to whichever happened to collide.
  const sfAccountToDeal = new Map<string, { account: string; id: string }>();
  for (const d of deals) {
    const opp = (d.external_id ? rolldogOppIdForDeal(d.external_id) : null) ?? d.rolldog_opportunity_id;
    if (opp) oppToDeal.set(String(opp), { account: pretty(d.account), id: d.id });
    if (d.salesforce_account_id) {
      sfAccountToDeal.set(String(d.salesforce_account_id), { account: pretty(d.account), id: d.id });
    }
  }

  const out: ActivityEntry[] = [];

  // recap_claim is the lock recap-sync takes before generating, so a retry
  // cannot double-send. It is not an artifact anyone received, and showing it
  // made every recap look like it was sent twice.
  const DELIVERED = (k: string) => k !== "recap_claim";
  for (const m of ((sentRes.data ?? []) as Array<{
    id: string;
    deal_id: string | null;
    call_id: string | null;
    kind: string;
    subject: string | null;
    to_email: string | null;
    sent_at: string;
    body_html: string | null;
  }>).filter((m) => DELIVERED(m.kind))) {
    // 2026-08-24: the warning that used to live here came true. Unknown kinds
    // fell back to "recap", so five link_escalation emails displayed as
    // "Post-call recap sent" against calls from three days earlier, and the
    // operator reasonably concluded DealRipe was mailing reps recaps for
    // meetings it had never captured. It was not. The log lied and was believed,
    // which is the one thing an activity log must never do.
    //
    // A kind we do not recognise is now labelled "Message sent" rather than
    // impersonating a known artifact. Wrong-but-vague is recoverable;
    // wrong-but-specific is what costs an evening.
    // Every kind in SentMessageKind belongs here. reengage_draft has existed
    // since the re-engagement sweep shipped and was never added, so seven of
    // them this morning displayed as "Message sent" against a customer address,
    // which is the same failure as the link_escalation one recorded above:
    // an unknown kind falling back to a label that describes something else.
    const KNOWN = [
      "briefing",
      "recap",
      "no_show_draft",
      "followup_draft",
      "digest",
      "link_escalation",
      "reengage_draft",
      "draft_ready",
    ];
    const kind = (KNOWN.includes(m.kind) ? m.kind : "unknown") as Exclude<ActivityKind, "rolldog_write" | "salesforce_write">;
    // Prefer the call_id stored on the message (hard link, set on every recap /
    // briefing / no-show draft going forward). Fall back to nearest-in-time only
    // for legacy rows written before call_id was stored.
    const stored = m.call_id ? { id: m.call_id, date: callDateById.get(m.call_id) ?? m.sent_at } : null;
    // A briefing is sent before its call; a recap, no-show note and follow-up
    // draft all describe one that already happened.
    const call =
      kind === "digest"
        ? null
        : stored ?? nearestCall(m.deal_id, m.sent_at, kind === "briefing" ? "after" : "before");
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
      values: null,
      callId: call?.id ?? null,
      callDate: call?.date ?? null,
    });
  }

  for (const c of (crmRes.data ?? []) as unknown as Array<{
    id: string;
    opportunity_external_id: string;
    fields: unknown;
    call_id: string | null;
    created_at: string;
    system?: string | null;
    field_values?: Array<{ label: string; value: string; mode?: string }> | null;
    violation_reason?: string | null;
  }>) {
    // Which CRM. Rows written before the `system` column existed are Rolldog by
    // architectural constraint, so the default is a fact rather than a guess.
    const isSalesforce = String(c.system ?? "rolldog") === "salesforce";
    // A Salesforce row carries an Account id, not a Rolldog opportunity id, so
    // resolving it through oppToDeal would silently attribute the write to the
    // wrong deal or to none.
    const resolved = isSalesforce
      ? sfAccountToDeal.get(String(c.opportunity_external_id))
      : oppToDeal.get(String(c.opportunity_external_id));
    // Prefer the real labels over the scope token. `fields` on a Salesforce row
    // is the single value 'sales_development', which tells a reader nothing.
    const written = Array.isArray(c.field_values) ? c.field_values : [];
    const fields =
      written.length > 0
        ? written.map((w) => w.label).join(", ")
        : Array.isArray(c.fields)
          ? (c.fields as string[]).join(", ")
          : "";
    // Prefer the call_id stamped on the write (bulletproof); fall back to
    // nearest-in-time only for legacy rows written before call_id existed.
    const stored = c.call_id ? { id: c.call_id, date: callDateById.get(c.call_id) ?? c.created_at } : null;
    // A write-back carries qualification out of a call that has happened, so it
    // can never belong to a future one.
    const call = stored ?? nearestCall(resolved?.id ?? null, c.created_at, "before");
    // Permitted and landed are different. These rows are already filtered to
    // allowed=true, so a reason here is not a scope refusal: it is the CRM
    // rejecting a write we were entitled to make, or the outcome never being
    // observed. Either way the row must not read "Wrote to Rolldog".
    const notLanded = c.violation_reason ?? null;
    const system = isSalesforce ? "Salesforce" : "Rolldog";
    out.push({
      id: `crm-${c.id}`,
      at: c.created_at,
      kind: isSalesforce ? "salesforce_write" : "rolldog_write",
      dealId: resolved?.id ?? null,
      account:
        resolved?.account ??
        (isSalesforce ? `Account ${c.opportunity_external_id}` : `Opp ${c.opportunity_external_id}`),
      title: notLanded ? `${system} write did not land` : `Wrote to ${system}`,
      detail: notLanded ?? (fields ? `Updated ${fields}` : null),
      bodyHtml: null,
      fields: fields || null,
      values: written.length > 0 ? written : null,
      callId: call?.id ?? null,
      callDate: call?.date ?? null,
    });
  }

  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return out;
}
