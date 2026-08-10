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

  for (const a of attendees) {
    const email = (a.email ?? "").toLowerCase();
    if (!email) continue;
    if (isSeller(email)) {
      colleagues.push(displayName(a));
      continue;
    }
    const known = byEmail.get(email);
    const title = known?.title ? `, ${known.title}` : "";
    // Prefer the Salesforce spelling of a name over an Exchange display name:
    // "Joel Del Toro" beats "joel@joearevalo.com".
    const name = known?.name ?? displayName(a);
    customers.push(`${name}${title}`);
  }

  if (customers.length === 0) return null;

  const line = customers.join("; ");
  return colleagues.length > 0
    ? `${line}. Also on the call from Magaya: ${colleagues.join(", ")}.`
    : line;
}
