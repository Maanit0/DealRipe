/**
 * Meetings: every captured call across the tenant, newest first, plus per-call
 * detail for the inspection view. Capture failures and placeholders are hidden
 * (same as everywhere else). This is the raw-capture layer of the app; a deal is
 * the synthesized state built from these meetings.
 */

import { repDisplayName } from "./pilot-config";
import { supabaseAdmin } from "./supabase";

const HIDDEN = new Set(["capture_failed", "placeholder"]);

export type MeetingListItem = {
  callId: string;
  dealId: string;
  dealExternalId: string | null;
  account: string;
  rep: string | null;
  date: string | null;
  durationMin: number | null;
  meetingType: string | null;
  outcome: string | null;
  /** Customer-side attendee names (non-Magaya), for the meeting label. */
  participants: string[];
};

/** Customer-side attendee names from a call's participants JSON. */
function customerNames(participants: unknown): string[] {
  if (!Array.isArray(participants)) return [];
  const names: string[] = [];
  for (const p of participants as Array<Record<string, unknown>>) {
    const email = typeof p.email === "string" ? p.email : "";
    const domain = email.split("@")[1]?.toLowerCase();
    if (domain === "magaya.com") continue;
    const name = typeof p.name === "string" && p.name ? p.name : email ? email.split("@")[0] : "";
    if (name) names.push(name);
  }
  return Array.from(new Set(names));
}

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

function pretty(account: string): string {
  return DISPLAY[account] ?? account;
}

export async function getMeetings(tenantId: string): Promise<MeetingListItem[]> {
  const db = supabaseAdmin();
  const [callsRes, dealsRes] = await Promise.all([
    db
      .from("calls")
      .select("id, deal_id, scheduled_start, call_date, duration_minutes, outcome, meeting_type, has_been_extracted, participants")
      .eq("tenant_id", tenantId)
      .order("scheduled_start", { ascending: false }),
    db.from("deals").select("id, account, external_id, rep_email").eq("tenant_id", tenantId),
  ]);

  const deals = new Map(
    ((dealsRes.data ?? []) as Array<{ id: string; account: string; external_id: string | null; rep_email: string | null }>).map(
      (d) => [d.id, d] as const,
    ),
  );

  const out: MeetingListItem[] = [];
  for (const c of (callsRes.data ?? []) as Array<{
    id: string;
    deal_id: string | null;
    scheduled_start: string | null;
    call_date: string | null;
    duration_minutes: number | null;
    outcome: string | null;
    meeting_type: string | null;
    has_been_extracted: boolean;
    participants: unknown;
  }>) {
    if (!c.deal_id) continue;
    if (c.outcome && HIDDEN.has(c.outcome)) continue;
    if (!c.has_been_extracted) continue; // still processing / not yet resolved
    const d = deals.get(c.deal_id);
    if (!d) continue;
    out.push({
      callId: c.id,
      dealId: c.deal_id,
      dealExternalId: d.external_id,
      account: pretty(d.account),
      rep: repDisplayName(d.rep_email),
      date: c.scheduled_start ?? c.call_date,
      durationMin: c.duration_minutes,
      meetingType: c.meeting_type,
      outcome: c.outcome,
      participants: customerNames(c.participants),
    });
  }
  return out;
}

export type MeetingDetail = {
  callId: string;
  dealId: string;
  dealExternalId: string | null;
  account: string;
  rep: string | null;
  date: string | null;
  durationMin: number | null;
  meetingType: string | null;
  outcome: string | null;
  transcript: string;
};

export async function getMeetingDetail(
  tenantId: string,
  callId: string,
): Promise<MeetingDetail | null> {
  const db = supabaseAdmin();
  const call = await db
    .from("calls")
    .select("id, deal_id, scheduled_start, call_date, duration_minutes, outcome, meeting_type")
    .eq("tenant_id", tenantId)
    .eq("id", callId)
    .maybeSingle();
  if (call.error || !call.data?.deal_id) return null;

  const [deal, tr] = await Promise.all([
    db
      .from("deals")
      .select("id, account, external_id, rep_email")
      .eq("id", call.data.deal_id)
      .maybeSingle(),
    db.from("transcripts").select("body").eq("call_id", callId).maybeSingle(),
  ]);
  if (deal.error || !deal.data) return null;

  return {
    callId,
    dealId: call.data.deal_id,
    dealExternalId: deal.data.external_id,
    account: pretty(deal.data.account),
    rep: repDisplayName(deal.data.rep_email),
    date: call.data.scheduled_start ?? call.data.call_date,
    durationMin: call.data.duration_minutes,
    meetingType: call.data.meeting_type,
    outcome: call.data.outcome,
    transcript: tr.data?.body ?? "",
  };
}
