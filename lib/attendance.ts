/**
 * Invited-vs-attended for a deal's most recent real call. The invite list is
 * stored on the call (calls.participants = the calendar attendees, with names,
 * emails, and RSVP status). "Spoke" is approximated from the transcript's
 * speaker lines, so a customer who was invited but never speaks surfaces as a
 * likely no-show. RSVP status is exact; "spoke" is best-effort.
 */

import { supabaseAdmin } from "./supabase";

const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled", "placeholder"]);

export type Invitee = {
  name: string | null;
  email: string | null;
  responseStatus: string | null;
  spoke: boolean;
};

export type DealAttendance = {
  callDate: string | null;
  invitees: Invitee[];
} | null;

export async function getDealAttendance(
  tenantId: string,
  dealId: string,
): Promise<DealAttendance> {
  const db = supabaseAdmin();
  const calls = await db
    .from("calls")
    .select("id, scheduled_start, call_date, participants, outcome")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId)
    .order("scheduled_start", { ascending: false });
  if (calls.error) return null;

  // Most recent real call that has an invite list.
  let call: { id: string; scheduled_start: string | null; call_date: string | null; participants: unknown } | null = null;
  for (const c of calls.data ?? []) {
    if (c.outcome && NO_CONTENT.has(c.outcome)) continue;
    if (Array.isArray(c.participants) && c.participants.length > 0) {
      call = c;
      break;
    }
  }
  if (!call) return null;

  // Speaker names from the transcript (the token before ": " on each line), so
  // "spoke" reflects actual participation, not just being mentioned.
  const t = await db.from("transcripts").select("body").eq("call_id", call.id).maybeSingle();
  const speakers = new Set<string>();
  for (const line of (t.data?.body ?? "").split("\n")) {
    const idx = line.indexOf(": ");
    if (idx > 0 && idx < 40) speakers.add(line.slice(0, idx).toLowerCase().trim());
  }

  const invitees: Invitee[] = [];
  for (const p of call.participants as Array<Record<string, unknown>>) {
    const email = typeof p.email === "string" ? p.email : null;
    const name = typeof p.name === "string" ? p.name : null;
    const domain = email?.split("@")[1]?.toLowerCase();
    if (domain === "magaya.com") continue; // internal reps, not customer stakeholders
    if (!name && !email) continue;
    const first = (name ?? email?.split("@")[0] ?? "").toLowerCase().trim().split(/\s+/)[0];
    const spoke = first.length >= 2 && [...speakers].some((s) => s.includes(first));
    invitees.push({
      name,
      email,
      responseStatus: typeof p.responseStatus === "string" ? p.responseStatus : null,
      spoke,
    });
  }
  if (invitees.length === 0) return null;

  return { callDate: call.scheduled_start ?? call.call_date ?? null, invitees };
}
