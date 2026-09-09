/**
 * What a meeting row actually establishes. OCCURRENCE and CONTENT are separate
 * facts and collapsing them is the source of several false statements in the
 * Monday reports.
 *
 * "Failed to capture" is the collapsed form, and it is wrong in the direction
 * that matters: it tells a reader the meeting might not have happened when the
 * evidence says it did.
 *
 *   lobby_refused   a human was inside the room to press deny. The meeting RAN.
 *                   Only the content is unknown. GHY's Sep 3 session and LT
 *                   AKA's Sep 3 demo are both this, and both were being
 *                   reported as if they might not have occurred.
 *   lobby_timeout   a bot outside the room cannot see whether anyone is inside
 *                   it, so "nobody came" and "nobody admitted the bot" produce
 *                   byte-identical histories. Undecidable, permanently.
 *   short body      a no-show still produces a transcript: joining noise,
 *                   "okay", "I'll be on the line". It passes any length check.
 *                   Apex Cargo's Aug 28 proposal review is 759 characters.
 *
 * Nothing here calls a model. Every branch is a record lookup.
 */

/** Outcomes that mean the row exists but no conversation happened on it. */
const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled", "placeholder", "capture_failed"]);

/**
 * Below this, a stored transcript is joining noise rather than a conversation.
 * Measured against the known no-shows in the pilot, which sit near a thousand
 * characters; a real discovery call is tens of thousands.
 */
export const MIN_CONVERSATION_CHARS = 2000;

export type Occurrence = "scheduled" | "ran" | "no_show" | "cancelled" | "unable_to_verify";
export type Content = "captured" | "partial" | "unavailable" | "not_captured";

export type MeetingFacts = {
  occurrence: Occurrence;
  content: Content;
  /** Why, in a sentence, for provenance and for the reader-facing phrasing. */
  basis: string;
  /** True only when a substantive transcript exists. Drives "last verified conversation". */
  isVerifiedConversation: boolean;
  /** Phrasing the generator may use. Never says more than the evidence supports. */
  phrase: string;
};

export type MeetingRow = {
  scheduled_start: string | null;
  call_date?: string | null;
  outcome: string | null;
  capture_class: string | null;
  capture_sub_code?: string | null;
  transcriptChars: number;
};

export function meetingFacts(c: MeetingRow, nowMs: number = Date.now()): MeetingFacts {
  const start = c.scheduled_start ? Date.parse(c.scheduled_start) : NaN;
  const isFuture = Number.isFinite(start) && start > nowMs;
  const when = c.scheduled_start ?? c.call_date ?? null;
  const dayLabel = when
    ? new Date(when).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    : "the meeting";

  if (isFuture) {
    return {
      occurrence: "scheduled",
      content: "not_captured",
      basis: "future calendar event",
      isVerifiedConversation: false,
      phrase: `${dayLabel} is booked`,
    };
  }

  const declaredNoContent = Boolean(c.outcome && NO_CONTENT.has(c.outcome));

  if (c.capture_class === "no_show" || c.outcome === "no_show") {
    return {
      occurrence: "no_show",
      content: "not_captured",
      basis: `recorded no-show (capture_class=${c.capture_class ?? "-"}, outcome=${c.outcome ?? "-"})`,
      isVerifiedConversation: false,
      phrase: `the ${dayLabel} meeting was a no-show`,
    };
  }

  if (c.transcriptChars > 0 && !declaredNoContent) {
    if (c.transcriptChars < MIN_CONVERSATION_CHARS) {
      // It ran, someone dialled in, and nothing was said. Reporting this as a
      // conversation is how "completed full demo" ends up beside "next step:
      // none" with no explanation.
      return {
        occurrence: "ran",
        content: "partial",
        basis: `transcript is only ${c.transcriptChars} characters, the size of joining noise rather than a conversation`,
        isVerifiedConversation: false,
        phrase: `the ${dayLabel} meeting connected but produced no substantive conversation`,
      };
    }
    return {
      occurrence: "ran",
      content: "captured",
      basis: `transcript stored, ${c.transcriptChars} characters`,
      isVerifiedConversation: true,
      phrase: `the ${dayLabel} meeting took place`,
    };
  }

  if (c.capture_class === "lobby_refused") {
    return {
      occurrence: "ran",
      content: "not_captured",
      basis: "the bot was refused entry, which requires a human inside the meeting",
      isVerifiedConversation: false,
      phrase: `the ${dayLabel} meeting ran, but DealRipe was denied entry and did not capture the discussion`,
    };
  }

  if (c.capture_class === "lobby_timeout") {
    return {
      occurrence: "unable_to_verify",
      content: "not_captured",
      basis: "the bot was never admitted; a lobby timeout cannot distinguish a meeting that ran from one that did not",
      isVerifiedConversation: false,
      phrase: `DealRipe could not verify whether the ${dayLabel} meeting took place`,
    };
  }

  if (c.outcome === "rescheduled") {
    return {
      occurrence: "cancelled",
      content: "not_captured",
      basis: "outcome recorded as rescheduled",
      isVerifiedConversation: false,
      phrase: `the ${dayLabel} meeting was rescheduled`,
    };
  }

  return {
    occurrence: "unable_to_verify",
    content: "not_captured",
    basis: `the date has passed and no capture evidence exists on the row (capture_class=${c.capture_class ?? "none"}, outcome=${c.outcome ?? "none"})`,
    isVerifiedConversation: false,
    phrase: `DealRipe could not verify whether the ${dayLabel} meeting took place`,
  };
}

/**
 * Senders that are machinery, not the customer.
 *
 * customer_side is domain-based: not magaya.com therefore the customer. That
 * counted echosign@echosign.com as the customer writing to you, on 52 messages
 * across 39 deals, and on 8 deals it was the most recent customer-side contact.
 * Master Cargo's report line reads "One reply July 22, then silence" and that
 * reply is a robot: no human has ever replied on that deal.
 */
export const MACHINE_SENDER =
  /(^|@|\.)(echosign|docusign|pandadoc|hellosign|adobesign|calendly|notifications?|no-?reply|mailer-daemon|postmaster)(\.|@|$)/i;

export function isMachineSender(email: string | null | undefined): boolean {
  return MACHINE_SENDER.test(String(email ?? ""));
}

/**
 * Adobe Sign state, read off the subject line.
 *
 * MEASURED AGAINST 2,495 REAL MESSAGES ON 2026-09-08, which corrected three
 * things the first version got wrong. It matched a bare \bagreement\b and read
 * "executed" only from a leading "Completed:", and both were wrong in the
 * direction that matters.
 *
 * 1. IT MISSED MOST EXECUTIONS. Adobe Sign announces completion four different
 *    ways: "Completed: ...", "... is Signed and Filed!", "You signed: ..." and
 *    "Completed: You're copied on ...". Only the first was recognised, so a
 *    signed NDA was reported as still out for signature. That is the dangerous
 *    direction: documentStateLine would tell a rep to chase a document the
 *    customer had already signed.
 *
 * 2. IT MATCHED HUMANS TALKING. "Following up - NDA and demo next steps",
 *    "Best Group and Magaya Agreement Discussion" and "Magaya Agreement for
 *    Approval" are people writing email, not envelope notifications. Counting
 *    them puts a document state on a deal that has no document.
 *
 * 3. IT MATCHED THREADS THAT INHERITED THE SUBJECT. "Customs ABI Session -
 *    Agenda & Storyboard | ... Re: Completed: ..." is a human replying on a
 *    thread whose subject happens to carry the notification, and "Automatic
 *    reply: Completed: ..." is an out-of-office. Neither is an envelope event.
 *
 * So this now requires the NOTIFICATION SHAPE, not the noun. A message only
 * counts when the subject looks like something an e-signature platform emits.
 */

/** Out-of-office and other auto-responses that merely quote a notification. */
const NOT_AN_ENVELOPE = /^\s*(automatic reply|out of office|undeliverable|delivery status)/i;

/**
 * The document was signed by everyone. Four shapes, all observed in the pilot.
 * "Completed:" is anchored so a quoted "Re: ... Completed:" mid-subject does not
 * count, but "signed and filed" is Adobe's own sentence and is safe anywhere.
 */
const EXECUTED = [
  /^\s*(re:\s*)?completed:/i,
  /\bis signed and filed\b/i,
  /^\s*you signed:/i,
];

/**
 * The envelope is in flight. These are Adobe's own phrasings; a human writing
 * "I'll send the NDA over" matches none of them.
 */
const IN_FLIGHT = [
  /\bsignature requested on\b/i,
  /\bhas been sent out for signature\b/i,
  /\bhas copied you on\b/i,
  /\bis out for signature\b/i,
  /\bplease (?:review and )?sign\b/i,
  /\bbetween .+ and .+ is\b/i,
];

export function agreementSignal(subject: string | null | undefined): {
  kind: "nda" | "quote" | "agreement";
  executed: boolean;
} | null {
  const s = String(subject ?? "");
  if (!s || NOT_AN_ENVELOPE.test(s)) return null;
  // The document has to be named. This is necessary but no longer sufficient.
  if (!/\b(NDA|non-?disclosure|quote agreement|agreement)\b/i.test(s)) return null;

  const executed = EXECUTED.some((re) => re.test(s));
  const inFlight = IN_FLIGHT.some((re) => re.test(s));
  // Neither shape means a person wrote this and mentioned a document.
  if (!executed && !inFlight) return null;

  const kind = /NDA|non-?disclosure/i.test(s) ? "nda" : /quote/i.test(s) ? "quote" : "agreement";
  // Executed wins over in-flight: "Completed: ... has been sent out for
  // signature" is a completion notice quoting the original envelope, and
  // walking a signed document back to pending is the error worth avoiding.
  return { kind, executed };
}
