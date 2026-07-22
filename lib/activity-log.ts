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
  const [dealsRes, sentRes, crmRes] = await Promise.all([
    db.from("deals").select("id, account, external_id, rolldog_opportunity_id").eq("tenant_id", tenantId),
    db
      .from("sent_messages")
      .select("id, deal_id, kind, subject, to_email, sent_at")
      .eq("tenant_id", tenantId)
      .order("sent_at", { ascending: false }),
    db
      .from("crm_access_log")
      .select("id, opportunity_external_id, fields, allowed, operation, created_at")
      .eq("tenant_id", tenantId)
      .eq("operation", "write")
      .eq("allowed", true)
      .order("created_at", { ascending: false }),
  ]);

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
    kind: string;
    subject: string | null;
    to_email: string | null;
    sent_at: string;
  }>) {
    const kind = (["briefing", "recap", "no_show_draft", "digest"].includes(m.kind) ? m.kind : "recap") as Exclude<ActivityKind, "rolldog_write">;
    out.push({
      id: `sm-${m.id}`,
      at: m.sent_at,
      kind,
      dealId: m.deal_id,
      account: m.deal_id ? dealById.get(m.deal_id) ?? null : null,
      title: KIND_TITLE[kind],
      detail: m.to_email ? `To ${m.to_email}` : m.subject,
    });
  }

  for (const c of (crmRes.data ?? []) as Array<{
    id: string;
    opportunity_external_id: string;
    fields: unknown;
    created_at: string;
  }>) {
    const resolved = oppToDeal.get(String(c.opportunity_external_id));
    const fields = Array.isArray(c.fields) ? (c.fields as string[]).join(", ") : "";
    out.push({
      id: `crm-${c.id}`,
      at: c.created_at,
      kind: "rolldog_write",
      dealId: resolved?.id ?? null,
      account: resolved?.account ?? `Opp ${c.opportunity_external_id}`,
      title: "Wrote to Rolldog",
      detail: fields ? `Updated ${fields}` : null,
    });
  }

  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return out;
}
