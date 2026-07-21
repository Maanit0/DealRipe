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

  // Most recent real call that has already HAPPENED and has an invite list.
  // A future scheduled call has no transcript, so every invitee would look like
  // a no-show; attendance only makes sense for a call in the past.
  const now = Date.now();
  let call: { id: string; scheduled_start: string | null; call_date: string | null; participants: unknown } | null = null;
  for (const c of calls.data ?? []) {
    if (c.outcome && NO_CONTENT.has(c.outcome)) continue;
    const t = Date.parse(c.scheduled_start ?? c.call_date ?? "");
    if (Number.isFinite(t) && t > now) continue; // upcoming call, not yet happened
    if (Array.isArray(c.participants) && c.participants.length > 0) {
      call = c;
      break;
    }
  }
  if (!call) return null;

  // Speaker tokens from the transcript, so "spoke" reflects actual
  // participation, not just being mentioned. Labels come in several shapes:
  //   "Ely Cardenas | EXTRUM:buenas tardes"   (colon, no space, company suffix)
  //   "Juan Lopez: que me comenta"            (colon + space)
  // So we split on the first colon (not ": "), drop any " | COMPANY" suffix, and
  // keep the individual name words as tokens.
  const t = await db.from("transcripts").select("body").eq("call_id", call.id).maybeSingle();
  const speakerTokens = new Set<string>();
  for (const raw of (t.data?.body ?? "").split("\n")) {
    const line = raw.trim();
    const idx = line.indexOf(":");
    if (idx <= 0 || idx > 60) continue;
    let label = line.slice(0, idx);
    const pipe = label.indexOf("|");
    if (pipe > 0) label = label.slice(0, pipe); // strip " | EXTRUM" style suffix
    for (const tok of label.toLowerCase().split(/[^a-záéíóúñü]+/i)) {
      if (tok.length >= 3) speakerTokens.add(tok);
    }
  }
  const tokens = [...speakerTokens];

  const invitees: Invitee[] = [];
  for (const p of call.participants as Array<Record<string, unknown>>) {
    const email = typeof p.email === "string" ? p.email : null;
    const name = typeof p.name === "string" ? p.name : null;
    const domain = email?.split("@")[1]?.toLowerCase();
    if (domain === "magaya.com") continue; // internal reps, not customer stakeholders
    if (!name && !email) continue;

    // Identity candidates: name words plus the email local part. A calendar
    // invite often carries only "ecardenas@extrum.com", whose local part won't
    // equal the spoken "Ely Cardenas", so we match by substring both ways: the
    // spoken last name "cardenas" is contained in the local part "ecardenas".
    const identity: string[] = [];
    if (name) {
      for (const w of name.toLowerCase().split(/[^a-záéíóúñü]+/i)) if (w.length >= 2) identity.push(w);
    }
    const local = email?.split("@")[0]?.toLowerCase();
    if (local) identity.push(local);

    const spoke = identity.some((id) =>
      tokens.some(
        (s) => s === id || (s.length >= 4 && id.includes(s)) || (id.length >= 4 && s.includes(id)),
      ),
    );
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
