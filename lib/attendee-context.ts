/**
 * Who is actually going to be in the room, from the calendar.
 *
 * Every DealRipe briefing until 2026-08-25 named the attendees and stopped
 * there. The invite carries more than names and none of it was used:
 *
 *  - responseStatus per person. Ativzla's customer was "none" on the Aug 20
 *    invite and "accepted" on Aug 24. "The customer has not accepted this
 *    invite" is a real pre-call fact and nobody was told.
 *  - who is NEW. Ativzla's Aug 27 meeting adds Ernesto Losada, who has been on
 *    no previous call. A person appearing for the first time is one of the
 *    highest-value things a rep can know walking in, and on a late-stage deal it
 *    is often the economic buyer arriving.
 *  - who has DROPPED OFF. Someone who was on the last two calls and is not on
 *    this one is the champion going quiet, seen from the other side.
 *
 * Facts only. This returns what the calendar says; the model decides what it
 * means, because that depends on the call type and the stage and this file
 * knows neither.
 */
import { domainOf } from "./graph-mail";

export type Attendee = { name?: string | null; email?: string | null; responseStatus?: string | null };

export type AttendeeContext = {
  /** Customer-side people on THIS invite who have accepted. */
  accepted: string[];
  /** Customer-side people who have not responded or declined. */
  unconfirmed: string[];
  /** On this invite and on no previous captured call. */
  newFaces: string[];
  /** On a previous captured call and not on this invite. */
  droppedOff: string[];
  /** Colleagues on this invite who were on no previous call. A solution
   *  engineer or a manager appearing changes what the meeting IS. */
  newColleagues: string[];
  lines: string[];
};

/**
 * Calendar plumbing, not people. Apexcargo's invite carries
 * noreply@sender.zohocalendar.in, and a briefing that says "accepted:
 * noreply@sender.zohocalendar.in" tells a rep the room is full when it is empty.
 */
const NOT_A_PERSON = /^(no-?reply|do-?not-?reply|notifications?|calendar|invite|meetings?|bookings?)@|@(sender\.)?(zohocalendar|calendly|calendar-server|resource)\./i;

const label = (a: Attendee): string => {
  const n = (a.name ?? "").trim();
  const e = (a.email ?? "").trim();
  if (n && n.toLowerCase() !== e.toLowerCase()) return `${n} (${e})`;
  return e || n || "unknown";
};

/**
 * @param internalDomain the seller's own domain, so colleagues are excluded.
 *        A briefing about who is in the room means the CUSTOMER's people.
 */
export function buildAttendeeContext(args: {
  thisMeeting: Attendee[];
  priorCallAttendees: Attendee[][];
  internalDomain: string;
}): AttendeeContext {
  const isCustomer = (a: Attendee) => {
    const e = (a.email ?? "").toLowerCase();
    return e.includes("@") && !NOT_A_PERSON.test(e) && domainOf(e) !== args.internalDomain.toLowerCase();
  };
  const key = (a: Attendee) => (a.email ?? "").toLowerCase().trim();

  const here = args.thisMeeting.filter(isCustomer);
  const seenBefore = new Set<string>();
  for (const call of args.priorCallAttendees) for (const a of call.filter(isCustomer)) seenBefore.add(key(a));

  const accepted = here.filter((a) => (a.responseStatus ?? "").toLowerCase() === "accepted").map(label);
  const unconfirmed = here
    .filter((a) => (a.responseStatus ?? "").toLowerCase() !== "accepted")
    .map(label);
  const newFaces = here.filter((a) => !seenBefore.has(key(a))).map(label);

  const hereKeys = new Set(here.map(key));
  const dropped = new Map<string, string>();
  for (const call of args.priorCallAttendees) {
    for (const a of call.filter(isCustomer)) {
      if (!hereKeys.has(key(a))) dropped.set(key(a), label(a));
    }
  }
  const droppedOff = [...dropped.values()];

  // Our own side. A colleague who has not been on this deal before is a real
  // signal about the meeting: a solution engineer means a technical session, a
  // manager means something is being escalated or closed.
  const seenInternal = new Set<string>();
  for (const call of args.priorCallAttendees) {
    for (const a of call.filter((x) => !isCustomer(x))) seenInternal.add(key(a));
  }
  const newColleagues = args.thisMeeting
    .filter((a) => !isCustomer(a) && key(a) && !seenInternal.has(key(a)))
    .map(label);

  const lines: string[] = [];
  if (here.length === 0) {
    lines.push(`WHO IS IN THE ROOM: the invite carries no customer attendee we can read. Do not infer who will be there.`);
  } else {
    lines.push(`WHO IS IN THE ROOM, from the calendar invite.`);
    if (newFaces.length) {
      lines.push(
        `- NEW TO THIS DEAL: ${newFaces.join(", ")}. They have been on no previous call we captured. Find out who they are and why they are here; on a late-stage call this is often the person who signs.`,
      );
    }
    if (accepted.length) lines.push(`- Accepted: ${accepted.join(", ")}.`);
    if (unconfirmed.length) {
      lines.push(
        `- Has NOT accepted: ${unconfirmed.join(", ")}. Do not assume they will attend, and do not mention their response status to them.`,
      );
    }
    if (droppedOff.length) {
      lines.push(
        `- On an earlier call and NOT on this invite: ${droppedOff.join(", ")}. Worth knowing whether they stepped back or were simply not needed.`,
      );
    }
  }
  if (newColleagues.length) {
    lines.push(
      `- Joining from our side for the first time on this deal: ${newColleagues.join(", ")}. A colleague who has not been on this account before usually means the meeting is a different KIND of meeting than the last one.`,
    );
  }
  return { accepted, unconfirmed, newFaces, droppedOff, newColleagues, lines };
}
