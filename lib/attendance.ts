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
  onInvite: boolean; // true = on the calendar invite; false = joined but not invited
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
  // External guests carry a " | ORG" suffix in Teams transcripts (Magaya reps
  // do not), so we also keep each external speaker's display name and org. That
  // lets us surface a customer stakeholder who joined and spoke but was never on
  // the calendar invite, which the invite list alone would miss.
  const externalSpeakers = new Map<string, string>(); // normalized name -> org (lowercased)
  for (const raw of (t.data?.body ?? "").split("\n")) {
    const line = raw.trim();
    const idx = line.indexOf(":");
    if (idx <= 0 || idx > 60) continue;
    let label = line.slice(0, idx);
    let org: string | null = null;
    const pipe = label.indexOf("|");
    if (pipe > 0) {
      org = label.slice(pipe + 1).trim().toLowerCase();
      label = label.slice(0, pipe); // strip " | EXTRUM" style suffix
    }
    const name = label.trim();
    for (const tok of name.toLowerCase().split(/[^a-záéíóúñü]+/i)) {
      if (tok.length >= 3) speakerTokens.add(tok);
    }
    if (org && name && !org.includes("magaya")) externalSpeakers.set(name.toLowerCase(), org);
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
      onInvite: true,
    });
  }

  // Did a person (by name) speak on this call? Matches their name words against
  // the transcript speaker tokens, substring both ways so "Villalobos" hits.
  const spokeByName = (name: string): boolean => {
    const nt = name.toLowerCase().split(/[^a-záéíóúñü]+/i).filter((w) => w.length >= 3);
    return nt.some((n) =>
      tokens.some((s) => s === n || (s.length >= 4 && n.includes(s)) || (n.length >= 4 && s.includes(n))),
    );
  };
  // Is this person already represented in the attendee list (invitee or extra)?
  const alreadyListed = (name: string): boolean => {
    const nt = name.toLowerCase().split(/[^a-záéíóúñü]+/i).filter((w) => w.length >= 3);
    return invitees.some((inv) => {
      const invName = (inv.name ?? inv.email ?? "").toLowerCase();
      const invLocal = inv.email?.split("@")[0]?.toLowerCase() ?? "";
      return nt.some((n) => invName.includes(n) || (n.length >= 4 && invLocal.includes(n)));
    });
  };

  // Add customer stakeholders who spoke but were never on the calendar invite.
  // Primary source is DealRipe's own contacts for the account: they are known to
  // be customer-side, so this cleanly excludes Magaya reps (Rossy, Alex, Juan)
  // who are not stored as contacts. This works even when the transcript carries
  // no " | ORG" tags (e.g. the Cargo Cleared call, where Harris Brown, the
  // economic buyer, joined via Stephanie and was never separately invited).
  const contactsRes = await db
    .from("contacts")
    .select("name")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId);
  for (const ct of contactsRes.data ?? []) {
    const nm = typeof ct.name === "string" ? ct.name.trim() : "";
    if (!nm || alreadyListed(nm) || !spokeByName(nm)) continue;
    invitees.push({ name: nm, email: null, responseStatus: null, spoke: true, onInvite: false });
  }

  // Fallback: external ("| ORG") speakers who match the account domain but were
  // not captured as contacts. Covers stakeholders the contact extractor missed.
  let acctRoot: string | null = null;
  for (const p of call.participants as Array<Record<string, unknown>>) {
    const dom = (typeof p.email === "string" ? p.email : "").split("@")[1]?.toLowerCase();
    if (dom && dom !== "magaya.com") {
      acctRoot = dom.split(".")[0];
      break;
    }
  }
  if (acctRoot) {
    for (const [spName, org] of externalSpeakers) {
      const orgFirst = org.split(/\s+/)[0];
      if (!(org.includes(acctRoot) || acctRoot.includes(orgFirst))) continue;
      if (alreadyListed(spName)) continue;
      const display = spName.replace(/\b\w/g, (c) => c.toUpperCase());
      invitees.push({ name: display, email: null, responseStatus: null, spoke: true, onInvite: false });
    }
  }

  if (invitees.length === 0) return null;

  return { callDate: call.scheduled_start ?? call.call_date ?? null, invitees };
}
