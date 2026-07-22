/**
 * Invited-vs-attended per call for a deal. The invite list is stored on the
 * call (calls.participants = the calendar attendees, with names, emails, and
 * RSVP status). "Spoke" is read from the transcript speaker lines, so a customer
 * who was invited but never speaks surfaces as a likely no-show, and a customer
 * stakeholder who joined without an invite is surfaced too. RSVP is exact;
 * "spoke" is best-effort.
 *
 * History is preserved: getDealAttendanceHistory returns one entry per real past
 * call (newest first), so a deal's who-showed-up record accumulates across calls
 * instead of the latest call overwriting the last. That trend (is the buyer
 * engaging more or less over time) is the signal, so it must not be wiped.
 */

import { supabaseAdmin } from "./supabase";

const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled", "placeholder", "capture_failed"]);

// Free/personal email providers, where the local part is a handle that rarely
// matches the person's spoken name. Used to safely merge a personal-email
// no-show with the single person who actually spoke.
const FREE_EMAIL = /@(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|gmx|zoho)\./i;

export type Invitee = {
  name: string | null;
  email: string | null;
  responseStatus: string | null;
  spoke: boolean;
  onInvite: boolean; // true = on the calendar invite; false = joined but not invited
};

export type CallAttendance = {
  callId: string;
  callDate: string | null;
  invitees: Invitee[];
};

// Backwards-compatible single-call shape.
export type DealAttendance = CallAttendance | null;

type CallRow = {
  id: string;
  scheduled_start: string | null;
  call_date: string | null;
  participants: unknown;
  outcome?: string | null;
};

/** Attendance for one call, given the account's known contact names. */
async function computeCallAttendance(
  tenantId: string,
  call: CallRow,
  contactNames: string[],
): Promise<CallAttendance | null> {
  const db = supabaseAdmin();

  // Speaker tokens from the transcript, so "spoke" reflects actual
  // participation. Labels come in several shapes:
  //   "Ely Cardenas | EXTRUM:buenas tardes"   (colon, no space, company suffix)
  //   "Juan Lopez: que me comenta"            (colon + space)
  // Split on the first colon (not ": "), drop any " | COMPANY" suffix, keep the
  // individual name words as tokens.
  const t = await db.from("transcripts").select("body").eq("call_id", call.id).maybeSingle();
  const body = t.data?.body ?? "";
  // No transcript yet (call still processing, or not captured): we cannot tell
  // who spoke, so we must NOT render a premature all-no-show verdict. Skip this
  // call until a real transcript exists.
  if (body.trim().length < 20) return null;
  const speakerTokens = new Set<string>();
  // External guests carry a " | ORG" suffix in Teams transcripts (Magaya reps do
  // not); keep each external speaker's name + org so we can surface a stakeholder
  // who joined and spoke but was never on the invite.
  const externalSpeakers = new Map<string, string>(); // normalized name -> org (lowercased)
  for (const raw of body.split("\n")) {
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
  const participants = Array.isArray(call.participants)
    ? (call.participants as Array<Record<string, unknown>>)
    : [];
  for (const p of participants) {
    const email = typeof p.email === "string" ? p.email : null;
    const name = typeof p.name === "string" ? p.name : null;
    const domain = email?.split("@")[1]?.toLowerCase();
    if (domain === "magaya.com") continue; // internal reps, not customer stakeholders
    if (!name && !email) continue;

    // Identity candidates: name words plus the email local part. A calendar
    // invite often carries only "ecardenas@extrum.com", whose local part won't
    // equal the spoken "Ely Cardenas", so match by substring both ways: the
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

  const spokeByName = (name: string): boolean => {
    const nt = name.toLowerCase().split(/[^a-záéíóúñü]+/i).filter((w) => w.length >= 3);
    return nt.some((n) =>
      tokens.some((s) => s === n || (s.length >= 4 && n.includes(s)) || (n.length >= 4 && s.includes(n))),
    );
  };
  const alreadyListed = (name: string): boolean => {
    const nt = name.toLowerCase().split(/[^a-záéíóúñü]+/i).filter((w) => w.length >= 3);
    return invitees.some((inv) => {
      const invName = (inv.name ?? inv.email ?? "").toLowerCase();
      const invLocal = inv.email?.split("@")[0]?.toLowerCase() ?? "";
      return nt.some((n) => invName.includes(n) || (n.length >= 4 && invLocal.includes(n)));
    });
  };

  // Add customer stakeholders who spoke but were never on the calendar invite.
  // Primary source is DealRipe's own contacts: known customer-side, so this
  // excludes Magaya reps who are not stored as contacts. Works even when the
  // transcript carries no " | ORG" tags (e.g. Cargo Cleared, where Harris Brown
  // joined via Stephanie and was never separately invited).
  for (const nm of contactNames) {
    if (!nm || alreadyListed(nm) || !spokeByName(nm)) continue;
    invitees.push({ name: nm, email: null, responseStatus: null, spoke: true, onInvite: false });
  }

  // Fallback: external ("| ORG") speakers matching the account domain but not
  // captured as contacts. Covers stakeholders the contact extractor missed.
  let acctRoot: string | null = null;
  for (const p of participants) {
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

  // Merge a personal-email no-show with a single spoke-extra: they are almost
  // certainly the same person invited under a personal address whose handle does
  // not resemble their spoken name (e.g. qqgregory@gmail.com = "Quincy"), so we
  // must not double-count them. Gated to free-email domains so a real corporate
  // no-show is never wrongly merged with a colleague who joined uninvited.
  const noShow = invitees.filter((i) => i.onInvite && !i.spoke);
  const spokeExtras = invitees.filter((i) => !i.onInvite && i.spoke);
  if (noShow.length === 1 && spokeExtras.length === 1 && FREE_EMAIL.test(noShow[0].email ?? "")) {
    noShow[0].spoke = true;
    noShow[0].name = spokeExtras[0].name ?? noShow[0].name;
    const idx = invitees.indexOf(spokeExtras[0]);
    if (idx >= 0) invitees.splice(idx, 1);
  }

  if (invitees.length === 0) return null;
  return { callId: call.id, callDate: call.scheduled_start ?? call.call_date ?? null, invitees };
}

/**
 * Attendance for every real past call on the deal, newest first (capped). A
 * future scheduled call is skipped (no transcript, so everyone would look absent)
 * and so are no-content outcomes.
 */
export async function getDealAttendanceHistory(
  tenantId: string,
  dealId: string,
  limit = 6,
): Promise<CallAttendance[]> {
  const db = supabaseAdmin();
  const calls = await db
    .from("calls")
    .select("id, scheduled_start, call_date, participants, outcome")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId)
    .order("scheduled_start", { ascending: false });
  if (calls.error) return [];

  const contactsRes = await db
    .from("contacts")
    .select("name")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId);
  const contactNames = ((contactsRes.data ?? []) as Array<{ name: unknown }>)
    .map((c) => (typeof c.name === "string" ? c.name.trim() : ""))
    .filter(Boolean);

  const now = Date.now();
  const out: CallAttendance[] = [];
  for (const c of (calls.data ?? []) as CallRow[]) {
    if (out.length >= limit) break;
    if (c.outcome && NO_CONTENT.has(c.outcome)) continue;
    const t = Date.parse(c.scheduled_start ?? c.call_date ?? "");
    if (Number.isFinite(t) && t > now) continue; // upcoming call, not yet happened
    if (!Array.isArray(c.participants) || c.participants.length === 0) continue;
    const a = await computeCallAttendance(tenantId, c, contactNames);
    if (a) out.push(a);
  }
  return out;
}

/** The most recent call's attendance (thin wrapper over the history). */
export async function getDealAttendance(
  tenantId: string,
  dealId: string,
): Promise<DealAttendance> {
  const h = await getDealAttendanceHistory(tenantId, dealId, 1);
  return h[0] ?? null;
}
