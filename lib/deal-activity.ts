/**
 * Deals with action, and deals with none.
 *
 * Mark Buman asked for exactly this on 2026-08-26, in his own words: "in some
 * of these forecast calls the reps say I still haven't heard from them, it's
 * been two weeks. I'd love a way if we could sort by no interaction versus
 * interaction. Then I can concentrate on, especially as we're getting closer to
 * the end of the quarter, how do we make action happen."
 *
 * THREE BUCKETS, NEVER TWO.
 *
 * "Nothing has happened on this deal" and "we could not read whether anything
 * happened" produce the same empty result and only one of them is a coaching
 * conversation. A CRO who takes a silent-deal list into a forecast call and
 * gets told "they called me on my cell yesterday" stops using the list. So a
 * deal whose signals could not be read is reported as UNKNOWN and never as
 * silent, and the artifact says so in the open.
 *
 * WHAT WE CANNOT SEE, SAID OUT LOUD. Mark raised it himself before we did: a
 * phone call to a rep's mobile leaves no trace in any system we read. The
 * report states that where the silent list appears rather than in a footnote,
 * because the first time it is wrong in front of a rep is the last time it
 * gets opened.
 */

/**
 * How recently something has to have happened to count as live.
 *
 * Fourteen days, which is Mark's own number ("it's been two weeks"). Matched to
 * how he already talks about it rather than tuned, so the list agrees with the
 * judgement he was making by hand.
 */
export const ACTIVITY_WINDOW_DAYS = 14;

export type ActivityVerdict = "active" | "silent" | "not_started" | "unknown";

export type ActivityRead = {
  verdict: ActivityVerdict;
  /** One line naming the most recent thing that happened, or why we cannot tell. */
  reason: string;
  /** Sort key inside the silent list: longest silence first. Null when unknown. */
  quietDays: number | null;
};

/**
 * What the classifier needs, from wherever the caller got it.
 *
 * Deliberately NOT BuyerSignals. The Monday report is built on
 * getPipelineChanges, the same engine behind Mark's digest, because the two
 * land in his inbox together and a deal that appears with one amount in one and
 * a different amount in the other destroys both. Taking a plain shape lets the
 * same rule run over either source without either one becoming the definition.
 */
export type ActivityInput = {
  /** A meeting on the calendar with this customer. Null when unread. */
  nextMeetingBooked: boolean | null;
  /**
   * Has DealRipe ever captured a conversation on this deal.
   *
   * 16 of 122 deals have a meeting booked and have never had a call. Those are
   * first meetings that have not happened yet, and calling them "the customer is
   * moving" next to a column reading "no movement this week" is what made this
   * report confusing on first read. They are new business waiting to start, not
   * momentum.
   */
  hasEverSpoken: boolean;
  /** Days since we last spoke to them on a call. Null when there has been none. */
  daysSinceConversation: number | null;
  /** Days since THEY last emailed us. Null when none on record. */
  daysSinceCustomerEmail: number | null;
  /**
   * Whether this rep's mailbox has been ingested at all.
   *
   * A rep whose mail was never read has every one of their deals looking
   * email-silent, which would put a whole book into the column Mark acts on.
   * False makes the verdict unknown rather than silent.
   */
  mailboxRead: boolean;
};

/**
 * Did anything happen on this deal, from the customer's side.
 *
 * Deliberately customer-weighted. A rep sending three emails into silence is
 * not activity, it is the definition of the problem, and counting our own
 * outbound would put the deals Mark most wants to see straight into the wrong
 * column.
 */
export function readActivity(input: ActivityInput, windowDays = ACTIVITY_WINDOW_DAYS): ActivityRead {
  const { nextMeetingBooked, daysSinceConversation, daysSinceCustomerEmail, mailboxRead } = input;

  // A meeting on the calendar is the strongest form of action there is, and it
  // is a future fact rather than a recency one, so it is checked first and is
  // not subject to the window.
  if (nextMeetingBooked === true) {
    return input.hasEverSpoken
      ? { verdict: "active", reason: "next meeting on the calendar", quietDays: null }
      : { verdict: "not_started", reason: "first meeting booked, not held yet", quietDays: null };
  }

  const recentCall = daysSinceConversation !== null && daysSinceConversation <= windowDays;
  const recentReply = daysSinceCustomerEmail !== null && daysSinceCustomerEmail <= windowDays;

  if (recentCall || recentReply) {
    const bits: string[] = [];
    if (recentReply) bits.push(`they emailed ${daysSinceCustomerEmail} day${daysSinceCustomerEmail === 1 ? "" : "s"} ago`);
    if (recentCall) bits.push(`spoke ${daysSinceConversation} day${daysSinceConversation === 1 ? "" : "s"} ago`);
    return { verdict: "active", reason: bits.join(", "), quietDays: null };
  }

  // NOTHING FOUND. Only now does it matter whether we actually looked.
  if (!mailboxRead) {
    return {
      verdict: "unknown",
      reason: "this rep's mailbox has not been read, so email silence cannot be claimed",
      quietDays: null,
    };
  }
  if (nextMeetingBooked === null) {
    return {
      verdict: "unknown",
      reason: "the calendar could not be read for this deal",
      quietDays: null,
    };
  }

  const candidates = [daysSinceConversation, daysSinceCustomerEmail].filter(
    (d): d is number => d !== null,
  );
  const days = candidates.length > 0 ? Math.min(...candidates) : null;
  return {
    verdict: "silent",
    reason:
      days === null
        ? "no call and no customer email on record, and nothing booked"
        : `nothing from them in ${days} days, and nothing booked`,
    quietDays: days,
  };
}

/** The caveat, printed where the silent list is rather than in a footnote. */
export const SILENCE_CAVEAT =
  "This reads calls, calendar and email. A call to a rep's mobile leaves no trace in any of them, " +
  "so treat this as the list to ask about rather than a verdict. A rep saying 'they called me' is the " +
  "list working.";
