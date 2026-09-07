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
 * Adobe EchoSign puts the state in the subject: an envelope out for signature
 * carries the document name, and a fully executed one is prefixed "Completed:".
 * Deterministic, and currently unread by anything.
 */
export function agreementSignal(subject: string | null | undefined): {
  kind: "nda" | "quote" | "agreement";
  executed: boolean;
} | null {
  const s = String(subject ?? "");
  if (!/\b(NDA|non-?disclosure|quote agreement|agreement)\b/i.test(s)) return null;
  const executed = /^\s*(Re:\s*)?Completed:/i.test(s);
  const kind = /NDA|non-?disclosure/i.test(s) ? "nda" : /quote/i.test(s) ? "quote" : "agreement";
  return { kind, executed };
}
