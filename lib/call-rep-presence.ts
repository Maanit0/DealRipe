/**
 * Which pilot rep was actually ON the call, as opposed to on the invite.
 *
 * The follow-up draft is written into the DEAL OWNER's mailbox, decided once at
 * deal level and never revisited per call. Steven Johnson, 2026-09-02: a Great
 * Way meeting he was invited to and did not attend produced a draft in his
 * Outlook, while Alexandra Suntrup, who ran the call, had nothing to send.
 *
 *   deal rep_email      sjohnson@magaya.com
 *   magaya on invite    abby.gonzalez, sjohnson, npercz, asuntrup
 *   actually spoke      Abby Gonzalez, Alexandra Suntrup
 *
 * A draft in the wrong rep's mailbox is worse than a missing one: the person who
 * ran the call cannot send it, and the person who can send it was not there.
 *
 * THE HARD PART IS NOT FINDING WHO SPOKE. It is telling "the owner was absent"
 * apart from "we could not match the owner's name", which look identical from
 * the outside and have opposite correct actions. A transcript that matched no
 * pilot rep at all is evidence the matcher failed, not evidence the room was
 * empty, so it returns `no_rep_matched` and the caller keeps the owner.
 */

import { autoJoinRepEmails } from "./pilot-config";
import { supabaseAdmin } from "./supabase";

export type RepPresence =
  /** The transcript matched at least one pilot rep. `spoke` is who. */
  | { status: "read"; spoke: string[] }
  /** No transcript yet, or too short to read. Worth retrying. */
  | { status: "no_transcript" }
  /**
   * A real transcript that matched NO pilot rep.
   *
   * Never treated as "no rep attended". Magaya reps carry no " | ORG" suffix in
   * Teams transcripts and a display name can differ from the mailbox, so zero
   * matches means the matching failed, and a routing decision must not be built
   * on it.
   */
  | { status: "no_rep_matched" }
  | { status: "unavailable"; error: string };

/** Name tokens for a rep, from the invite where possible, else the mailbox. */
function identityFor(email: string, participants: Array<Record<string, unknown>>): string[] {
  const out: string[] = [];
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local) out.push(local);
  for (const p of participants) {
    const pe = typeof p.email === "string" ? p.email.toLowerCase() : null;
    if (pe !== email) continue;
    const name = typeof p.name === "string" ? p.name : null;
    if (!name) continue;
    for (const w of name.toLowerCase().split(/[^a-záéíóúñü]+/i)) if (w.length >= 3) out.push(w);
  }
  return [...new Set(out)];
}

export async function readRepPresence(callId: string): Promise<RepPresence> {
  const db = supabaseAdmin();
  const [t, c] = await Promise.all([
    db.from("transcripts").select("body").eq("call_id", callId).maybeSingle(),
    db.from("calls").select("participants").eq("id", callId).maybeSingle(),
  ]);
  if (t.error) return { status: "unavailable", error: t.error.message };
  if (c.error) return { status: "unavailable", error: c.error.message };

  const body = (t.data?.body ?? "").trim();
  if (body.length < 20) return { status: "no_transcript" };

  // Speaker tokens, same shape handling as lib/attendance.ts: split on the first
  // colon, drop a " | ORG" suffix, keep name words.
  const tokens = new Set<string>();
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const idx = line.indexOf(":");
    if (idx <= 0 || idx > 60) continue;
    let label = line.slice(0, idx);
    const pipe = label.indexOf("|");
    if (pipe > 0) label = label.slice(0, pipe);
    for (const tok of label.trim().toLowerCase().split(/[^a-záéíóúñü]+/i)) {
      if (tok.length >= 3) tokens.add(tok);
    }
  }
  const spoken = [...tokens];
  const participants = Array.isArray(c.data?.participants)
    ? (c.data?.participants as Array<Record<string, unknown>>)
    : [];

  const spoke: string[] = [];
  for (const rep of autoJoinRepEmails().map((r) => r.toLowerCase())) {
    const identity = identityFor(rep, participants);
    const hit = identity.some((id) =>
      spoken.some((s) => s === id || (s.length >= 4 && id.includes(s)) || (id.length >= 4 && s.includes(id))),
    );
    if (hit) spoke.push(rep);
  }
  return spoke.length > 0 ? { status: "read", spoke } : { status: "no_rep_matched" };
}

export type MailboxChoice = { mailbox: string; rerouted: boolean; reason: string };

/**
 * The mailbox this call's draft belongs in.
 *
 * Moves off the deal owner ONLY when the transcript positively places another
 * pilot rep on the call and positively fails to place the owner. Every other
 * shape keeps the owner, including a transcript we could not read, a call where
 * both attended, and a call where two other reps spoke and there is no single
 * obvious author.
 */
export async function draftMailboxForCall(args: {
  callId: string;
  owner: string;
}): Promise<MailboxChoice> {
  const owner = args.owner.trim().toLowerCase();
  const keep = (reason: string): MailboxChoice => ({ mailbox: owner, rerouted: false, reason });

  const presence = await readRepPresence(args.callId);
  if (presence.status === "unavailable") return keep(`presence read failed: ${presence.error}`);
  if (presence.status === "no_transcript") return keep("no transcript, cannot tell who attended");
  if (presence.status === "no_rep_matched") return keep("transcript matched no pilot rep, so the matcher is unreliable here");

  if (presence.spoke.includes(owner)) return keep("the deal owner was on the call");

  const others = presence.spoke.filter((r) => r !== owner);
  // Two reps and no owner is a genuine ambiguity about who writes the follow up,
  // and picking one silently is how a draft ends up with the wrong author again.
  if (others.length !== 1) {
    return keep(`owner absent but ${others.length} pilot reps spoke, no single author`);
  }
  return {
    mailbox: others[0],
    rerouted: true,
    reason: `${others[0]} ran the call, ${owner} did not speak`,
  };
}
