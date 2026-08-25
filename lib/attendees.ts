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

/** One person as the rep's email shows them: name, what they do, where they sit. */
export type BriefingAttendee = {
  name: string;
  title: string | null;
  /** champion, economic buyer, influencer, user. Null when we have not decided. */
  relationship: string | null;
  side: "customer" | "colleague" | "mailbox";
};

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
  // The freight desk. Added 2026-08-25 after pricing@kcarlton.com, the ONLY
  // external attendee on that call, rendered as a person named "Pricing" in the
  // roster and in the prompt's attendee line. In this industry the shared
  // mailbox is usually named for the function that owns the paperwork, so these
  // are the ones a logistics book actually produces.
  "pricing",
  "quotes",
  "quoting",
  "quotations",
  "rates",
  "booking",
  "bookings",
  "dispatch",
  "brokerage",
  "compliance",
  "entry",
  "entries",
  "traffic",
  "finance",
  "purchasing",
  "procurement",
  "csr",
  "service",
  "customerservice",
  "warehouse",
]);

/**
 * A stored contact NAME that is really a shared mailbox.
 *
 * Same list, applied where there is no address to check: "Pricing", "Docs",
 * "Customs". A person's name is not one word that is also a department.
 */
export function isRoleMailboxName(name: string | null | undefined): boolean {
  const n = (name ?? "").trim().toLowerCase();
  if (!n || /\s/.test(n)) return false;
  return ROLE_MAILBOXES.has(n.replace(/[._-]/g, ""));
}

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
 * One row per invitee, sorted into customers, our own people, and inboxes.
 *
 * The prompt has always taken this as a sentence, which is all a prompt needs.
 * The EMAIL cannot use a sentence: five people with titles and relationships
 * ran to four wrapped lines of grey text under the heading, which is the first
 * thing a rep sees and the easiest thing to skip. A roster renders as rows.
 *
 * attendeeLineFromMeeting is built from this rather than beside it, so the
 * people the prompt is told about and the people the rep is shown can never
 * diverge. Two functions walking the same invite with their own copy of the
 * mailbox rules is how one of them ends up naming a distribution list.
 */
export type RosterEntry = {
  name: string;
  title: string | null;
  side: "customer" | "colleague" | "mailbox";
  email: string;
};

export function rosterFromMeeting(
  attendees: ReadonlyArray<MeetingAttendee>,
  knownContacts: ReadonlyArray<ContactTitle> = [],
): RosterEntry[] {
  const byEmail = new Map(
    knownContacts
      .filter((c) => c.email)
      .map((c) => [c.email!.toLowerCase(), c] as const),
  );

  const out: RosterEntry[] = [];
  for (const a of attendees) {
    const email = (a.email ?? "").toLowerCase();
    if (!email) continue;
    if (isSeller(email)) {
      out.push({ name: displayName(a), title: null, side: "colleague", email });
      continue;
    }
    const known = byEmail.get(email);
    // A Salesforce contact record is a strong signal of personhood: someone
    // filed them as a human being. Trust that over the heuristic.
    const shown = known?.name ?? displayName(a);
    if (!known?.name && isRoleMailbox(email, shown)) {
      out.push({ name: email, title: null, side: "mailbox", email });
      continue;
    }
    // Prefer the Salesforce spelling of a name over an Exchange display name:
    // "Joel Del Toro" beats "joel@joearevalo.com".
    out.push({ name: known?.name ?? displayName(a), title: known?.title ?? null, side: "customer", email });
  }
  return out;
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
  const roster = rosterFromMeeting(attendees, knownContacts);
  const customers = roster
    .filter((r) => r.side === "customer")
    .map((r) => `${r.name}${r.title ? `, ${r.title}` : ""}`);
  const colleagues = roster.filter((r) => r.side === "colleague").map((r) => r.name);
  const mailboxes = roster.filter((r) => r.side === "mailbox").map((r) => r.email);

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

/**
 * The roster the rep's email prints, from the two sources that know anything.
 *
 * The INVITE is the authority on who is coming: it is who accepted, where our
 * contacts table is empty on every auto-created deal. The DEAL's contacts are
 * the only place a relationship lives (champion, economic buyer), because that
 * is a judgement made from the calls rather than a field on an invite. Neither
 * source alone produces a usable line, so they are joined here, once, and both
 * callers read the result.
 *
 * Matched on name rather than email on purpose: the deal contact rows carry no
 * address at all for most of the pilot. An unmatched person keeps their invite
 * row with no relationship, which is correct. Guessing one would put "economic
 * buyer" next to a name on the strength of a surname collision, and a rep who
 * pitches the wrong person that way does not get the call back.
 */
export function briefingRoster(args: {
  meetingAttendees?: ReadonlyArray<MeetingAttendee>;
  crmContacts?: ReadonlyArray<ContactTitle>;
  dealContacts?: ReadonlyArray<{ name: string; role?: string | null; relationship?: string | null }>;
}): BriefingAttendee[] {
  const rel = new Map(
    (args.dealContacts ?? [])
      .filter((c) => c.name)
      .map((c) => [c.name.trim().toLowerCase(), c] as const),
  );
  const relationshipOf = (name: string): { relationship: string | null; title: string | null } => {
    const hit = rel.get(name.trim().toLowerCase());
    const r = (hit?.relationship ?? "").replace(/_/g, " ").trim();
    return { relationship: r && r !== "unknown" ? r : null, title: hit?.role ?? null };
  };

  const fromInvite = rosterFromMeeting(args.meetingAttendees ?? [], args.crmContacts ?? []);
  if (fromInvite.some((r) => r.side === "customer")) {
    return fromInvite.map((r) => {
      const extra = relationshipOf(r.name);
      return { name: r.name, title: r.title ?? extra.title, relationship: extra.relationship, side: r.side };
    });
  }

  // No named customer on the invite. Fall back to the deal's own contacts,
  // which is what the briefing prompt falls back to, rather than printing an
  // empty roster that reads as "nobody is coming".
  //
  // FILTERED THE SAME WAY. The contacts table is populated from invites, so a
  // shared inbox that reached it once is stored as a person forever: the
  // KCarlton roster printed a stakeholder named "Pricing" from
  // pricing@kcarlton.com even after the invite path learned to reject it,
  // because this branch never applied the same rule. A guard on one of two
  // paths into the same output is not a guard.
  return (args.dealContacts ?? []).filter((c) => !isRoleMailboxName(c.name)).map((c) => {
    const r = (c.relationship ?? "").replace(/_/g, " ").trim();
    return {
      name: c.name,
      title: c.role ?? null,
      relationship: r && r !== "unknown" ? r : null,
      side: "customer" as const,
    };
  });
}
