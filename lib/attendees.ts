/**
 * Who is actually on the call, for the briefing prompt.
 *
 * The prompt has always had a rule telling it to target each question to the
 * person it is aimed at, framing one thing for an economic buyer and another
 * for a technical contact. That rule was running blind. attendeesFrom() reads
 * our contacts table, which is empty for every auto-created deal, so all of
 * Alexandra's fourteen briefings received the string "the customer (attendees
 * not yet confirmed)" while the invite sat right there naming three people.
 *
 * The briefings still named customers, because they were mining the Salesforce
 * contact list instead. That is a worse source for this purpose: it is whoever
 * the BDR happened to record, not whoever accepted the invite. On Joe Arevalo
 * it named Joel Del Toro and never mentioned Gustavo, who is on the meeting and
 * simply absent from Salesforce.
 *
 * So: calendar first, enriched with a title from Salesforce where the email
 * matches, and the seller's own people listed separately. A rep needs to know a
 * colleague is joining, both because it changes how the call runs and because
 * co-sold deals are exactly where recaps and drafts go to the wrong person.
 */

const SELLER_DOMAIN = "magaya.com";

export type MeetingAttendee = { name?: string | null; email?: string | null };
export type ContactTitle = { name: string; title: string | null; email: string | null };

function isSeller(email: string | null | undefined): boolean {
  return (email ?? "").toLowerCase().endsWith(`@${SELLER_DOMAIN}`);
}

/**
 * Shared mailboxes, which are not people.
 *
 * Title-casing the local part of an address is fine for "joel@" and wrong for
 * "docs@": the YES Customs briefing opened with "Walk Docs through the
 * proposal", which is a rep being told to address a distribution list by name.
 * These addresses still belong on the invite line, they simply must never be
 * spoken to or counted as a stakeholder.
 */
const ROLE_MAILBOXES = new Set([
  "docs",
  "documents",
  "info",
  "sales",
  "admin",
  "administration",
  "accounting",
  "accounts",
  "billing",
  "support",
  "help",
  "contact",
  "office",
  "team",
  "ops",
  "operations",
  "customs",
  "imports",
  "exports",
  "logistics",
  "noreply",
  "no-reply",
  "donotreply",
  "invoices",
  "ar",
  "ap",
  "hr",
  "it",
]);

function isRoleMailbox(email: string, displayName: string): boolean {
  const local = (email.split("@")[0] ?? "").toLowerCase().replace(/[._-]/g, "");
  const shown = displayName.toLowerCase().replace(/[\s._-]/g, "");
  const stem = (email.split("@")[1] ?? "").split(".")[0]?.toLowerCase() ?? "";

  // Check the display name as well as the address, not instead of it.
  //
  // The first version bailed out whenever a display name existed, on the theory
  // that "Sales, Maria <sales@x.com>" is a person. But Exchange returned "Ewi"
  // as the display name for ewi@ewiinc.com, so the guard fired and the mailbox
  // sailed through as a person named Ewi, standing in a briefing alongside
  // Evey, Frank and Cynthia. A display name that is itself the company name or
  // a role word is not a person's name.
  const candidates = [local, shown].filter((c) => c.length >= 2);
  if (candidates.length === 0) return false;

  for (const c of candidates) {
    if (ROLE_MAILBOXES.has(c)) return true;
    // An address or display name that is the company's own name is a company
    // inbox: "ewi" against ewiinc.com, "protrans" against protrans.com.
    if (stem.length >= 2 && (stem.startsWith(c) || c.startsWith(stem))) return true;
  }

  // A multi-word display name is a person. "Joel Del Toro" survives everything
  // above only by coincidence of length, so make it explicit.
  return !/\s/.test(displayName.trim()) && candidates.includes(local) && ROLE_MAILBOXES.has(local);
}

/**
 * A display name for one attendee.
 *
 * Exchange returns the email address as the display name when the person is
 * outside the organization and not in the address book, which is why the raw
 * invite shows "gustavo@joearevalo.com <gustavo@joearevalo.com>". Repeating
 * that twice reads like a bug, so the local part is title-cased instead, and
 * the address is kept only when it adds something.
 */
function displayName(a: MeetingAttendee): string {
  const email = (a.email ?? "").trim();
  const raw = (a.name ?? "").trim();
  if (raw && raw.toLowerCase() !== email.toLowerCase()) return raw;
  const local = email.split("@")[0] ?? "";
  if (!local) return email || "unknown";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/**
 * The attendee line for the prompt. Returns null when the meeting carries no
 * external attendee, so the caller can fall back rather than assert an empty
 * customer list.
 */
export function attendeeLineFromMeeting(
  attendees: ReadonlyArray<MeetingAttendee>,
  knownContacts: ReadonlyArray<ContactTitle> = [],
): string | null {
  const byEmail = new Map(
    knownContacts
      .filter((c) => c.email)
      .map((c) => [c.email!.toLowerCase(), c] as const),
  );

  const customers: string[] = [];
  const colleagues: string[] = [];
  const mailboxes: string[] = [];

  for (const a of attendees) {
    const email = (a.email ?? "").toLowerCase();
    if (!email) continue;
    if (isSeller(email)) {
      colleagues.push(displayName(a));
      continue;
    }
    const known = byEmail.get(email);
    // A Salesforce contact record is a strong signal of personhood: someone
    // filed them as a human being. Trust that over the heuristic.
    const shown = known?.name ?? displayName(a);
    if (!known?.name && isRoleMailbox(email, shown)) {
      mailboxes.push(email);
      continue;
    }
    const title = known?.title ? `, ${known.title}` : "";
    // Prefer the Salesforce spelling of a name over an Exchange display name:
    // "Joel Del Toro" beats "joel@joearevalo.com".
    const name = known?.name ?? displayName(a);
    customers.push(`${name}${title}`);
  }

  const parts: string[] = [];
  if (customers.length > 0) parts.push(customers.join("; "));
  if (mailboxes.length > 0) {
    // Named explicitly as inboxes so the prompt cannot address one as a person,
    // but kept visible, since a documents alias on a proposal call is a real
    // signal about how that company handles paperwork.
    parts.push(
      `Also copied, shared inboxes rather than people, never address these by name: ${mailboxes.join(", ")}.`,
    );
  }
  if (colleagues.length > 0) {
    parts.push(`Also on the call from Magaya: ${colleagues.join(", ")}.`);
  }

  // A meeting with only a shared inbox on the customer side still has no named
  // attendee, so fall back rather than claim we know who is coming.
  if (customers.length === 0) return null;
  return parts.join(" ");
}
