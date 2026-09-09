/**
 * Which side of the table a transcript label sat on, and how to read a roster.
 *
 * WHY THIS IS IN lib/ AND NOT IN A SCRIPT. It was in scripts/mine-plays.ts,
 * which made the most careful speaker matcher in the codebase a diagnostic.
 * CLAUDE.md's rule runs the other way: a diagnostic imports production logic or
 * it does not exist. A checker that can disagree with the code it checks will,
 * and it will do so confidently.
 *
 * The reasoning that produced it, kept because it cost a real mistake: the
 * first mine-plays run attributed two Seaboard Marine moves said by the
 * CUSTOMER'S own engineer, and a Tqlglobal one said by the customer offering to
 * bring a colleague, to Magaya reps. A move is a thing the SELLER did, so a
 * customer's sentence recorded as one becomes advice handed to five other reps
 * on the strength of the buyer having said it.
 *
 * Side is decided from the invite, where the domain is unambiguous, never from
 * the model. "unknown" is its own answer and stays visible: the seller side is
 * often joined by somebody who was never on the invite, and silently dropping
 * them loses real moves while silently keeping them repeats the bug.
 */

import { SELLER_DOMAIN } from "./attendees";

export type Side = "seller" | "customer" | "unknown";

export type Participant = { name?: string | null; email?: string | null; responseStatus?: string | null };

/**
 * calls.participants, read honestly.
 *
 * THREE OUTCOMES, not two. calls.participants is typed `Json | null` and holds
 * three different things in practice:
 *
 *   the modern shape   NormalizedAttendee[] from lib/microsoft-graph.ts
 *   legitimately empty  Graph sometimes returns no attendees at all, which is a
 *                       fact about the meeting and not a failure
 *   a legacy string[]   seed rows (lib/seed-data.ts, scripts/seed-second-nature)
 *                       hold ["Jess Tanaka (TopSort)"] with no addresses
 *
 * The legacy form must be REJECTED rather than parsed. A display name carries
 * no address, so keying a person off it invents one, and every side test here
 * runs on the domain. Callers that persist a roster should record which of the
 * three they got instead of writing zero rows and letting a reader assume the
 * meeting had nobody on it.
 *
 * NOTE the organizer is NOT in this list. Graph reports it separately and it is
 * stored in calls.organizer_email. Reading absence from attendees as absence
 * from the meeting once flagged five of Alexandra's own meetings as misrouted.
 */
export type ParticipantsRead =
  | { status: "ok"; participants: Participant[] }
  | { status: "empty" }
  | { status: "legacy_string_list"; count: number };

export function readParticipants(raw: unknown): ParticipantsRead {
  if (!Array.isArray(raw) || raw.length === 0) return { status: "empty" };
  if (raw.every((p) => typeof p === "string")) return { status: "legacy_string_list", count: raw.length };
  const participants = raw.filter((p): p is Participant => !!p && typeof p === "object");
  return participants.length > 0 ? { status: "ok", participants } : { status: "empty" };
}

/** Lowercase alphabetic name tokens, so "Soto, Jaime" and "Jaime Soto" match. */
function nameTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z\s]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/**
 * Does this transcript label name this participant.
 *
 * Two tokens shared is a match, and one is enough when either side only has one
 * to give. The email local part is checked too, because half the Magaya invites
 * carry an address where the name should be: "JHuseby@tql.com" is how the
 * roster spells the man the transcript calls "Joseph Huseby".
 */
export function labelNamesParticipant(speaker: string, p: Participant): boolean {
  const s = nameTokens(speaker);
  if (s.length === 0) return false;
  const n = nameTokens(p.name ?? "");
  const shared = s.filter((t) => n.includes(t)).length;
  if (shared >= 2) return true;
  if (shared === 1 && (s.length === 1 || n.length === 1)) return true;

  const local = (p.email ?? "").split("@")[0].toLowerCase().replace(/[^a-z]/g, "");
  if (local.length >= 4 && s.some((t) => t.length >= 4 && local.includes(t))) return true;
  return false;
}

/**
 * This call's invite decides first, and a wider directory catches the rest.
 *
 * The invite is the customer's copy as often as ours, so a seller-side person
 * who joined without being on it looks identical to a stranger. Checking the
 * speaker against every seller-domain attendee seen anywhere in the window
 * fixes that without weakening the customer test, which still runs first and
 * still wins: a name that is on THIS invite as the customer is the customer.
 */
export function sideOfSpeaker(
  participants: ReadonlyArray<Participant>,
  speaker: string,
  directory: ReadonlyArray<Participant>,
  sellerDomain: string = SELLER_DOMAIN,
): Side {
  let sawCustomer = false;
  for (const p of participants) {
    if (!labelNamesParticipant(speaker, p)) continue;
    const domain = (p.email ?? "").split("@")[1]?.toLowerCase() ?? "";
    if (domain === sellerDomain) return "seller";
    if (domain) sawCustomer = true;
  }
  if (sawCustomer) return "customer";
  if (directory.some((p) => labelNamesParticipant(speaker, p))) return "seller";
  return "unknown";
}

/**
 * Every seller-domain attendee seen on any call in the window, deduped by
 * address.
 *
 * This is the closest thing the codebase has to a directory of the seller's own
 * people, and it is derived entirely from evidence: someone is on it because
 * they were on an invite, not because anyone recorded a role for them. That
 * distinction is deliberate and should survive any later work here.
 */
export function sellerDirectory(
  all: ReadonlyArray<ReadonlyArray<Participant>>,
  sellerDomain: string = SELLER_DOMAIN,
): Participant[] {
  const byEmail = new Map<string, Participant>();
  for (const list of all) {
    for (const p of list) {
      const email = (p.email ?? "").toLowerCase();
      if (email.endsWith(`@${sellerDomain}`) && !byEmail.has(email)) byEmail.set(email, p);
    }
  }
  return [...byEmail.values()];
}
