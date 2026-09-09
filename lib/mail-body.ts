/**
 * One trimmer for message bodies. The new content, without the thread under it.
 *
 * WHY THIS IS A LEAF MODULE. Four near-copies of this logic existed, each
 * slightly weaker than the next, and each written where it was needed rather
 * than where it belonged:
 *
 *   lib/followup-draft.ts     cutQuotedTail + stripMailChrome, line-anchored,
 *                             the only one that handles "-----Original
 *                             Appointment-----" and ">" quote markers
 *   lib/email-log.ts          attachMessageExcerpts, a non-anchored split
 *   lib/deal-memory.ts        stripMailChrome plus its own second cut
 *   scripts/mine-followup-shapes.ts  the only one that strips Safelinks
 *
 * The strongest cut and the strongest noise-stripping were in different files,
 * so every caller got some of the fix and none got all of it. This module is
 * the union, and it imports nothing from lib/ so that email-log can use it
 * without pulling in followup-draft and creating a cycle.
 *
 * WHAT IT DOES NOT DO. It does not collapse newlines into spaces and it does
 * not append an ellipsis. Those are presentation choices that differ per
 * caller, and baking one in would make this the fifth variant rather than the
 * last one.
 */

/**
 * The boundary where our text stops and someone else's begins.
 *
 * Line-anchored deliberately. Juan's replies quote the customer with
 * "-----Original Appointment-----" and the invite headers; appended to a draft,
 * the body ended in a dash, the completeness check read that as a truncation,
 * and every draft he should have had was discarded before it reached his
 * Outlook. That is the Black Gold call on 2026-08-12.
 *
 * Everything past the first boundary is another person's prose. It is wrong in
 * a signature, wrong in a voice sample, and wrong in a stored body, so it is
 * cut in one place for all three.
 */
const QUOTED_BOUNDARY_RE =
  /^\s*(?:-{2,}\s*original\s+(?:message|appointment)\s*-{2,}|_{5,}\s*$|from:\s|sent:\s|on\s.{0,160}\swrote:\s*$|>)/i;

/**
 * Lines that are the mail system talking, not a person.
 *
 * The external-sender banner is handled here rather than as a boundary because
 * it sits at the TOP of a message. Splitting on it returns an empty first
 * segment whenever it is the very first line, which reads downstream as an
 * empty body: absence of evidence presented as evidence of absence, in the one
 * module written to stop that.
 *
 * Magaya's tenant stamps "CAUTION: This email originated from outside your
 * organization" on every inbound message and Outlook adds "You don't often get
 * email from x. Learn why this is important". Both land at the top, so an
 * excerpt taken from the top is the banner and nothing else: the first run of
 * the deal-memory block handed the writer a security warning under the heading
 * "what they said".
 */
const NOISE_LINE_RE =
  /^\s*(?:\[cid:|NOTICE:|CAUTION:|WARNING:\s*This (?:email|message)|This (?:e-?mail|message) (?:and any attachments|was sent)|automatically generated|\[?EXTERNAL\]?\s*:?\s*$)/i;

/**
 * The same banners when they wrap onto a continuation line, where there is no
 * "CAUTION:" prefix left to anchor on.
 *
 * "Do not click links unless you recognize the sender" is the banner's SECOND
 * line and every earlier copy of this filter missed it, so a trimmed excerpt
 * still opened with security-warning text. That is the same incident the first
 * line was added for, one line lower down.
 */
const NOISE_CONTAINS_RE =
  /originated from outside (?:your|the) organization|you don'?t often get email from|learn why this is important|do not click (?:any )?links or open attachments|unless you (?:recognize|know|trust) the sender/i;

export function cutQuotedTail(text: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => QUOTED_BOUNDARY_RE.test(l));
  return at === -1 ? text : lines.slice(0, at).join("\n");
}

/** Signature furniture, inline-image placeholders and rules. */
export function stripMailChrome(text: string): string {
  return cutQuotedTail(text)
    .replace(/Get Outlook for (iOS|Android)\s*<[^>]*>/gi, "")
    .replace(/Sent from my (iPhone|iPad|Android|BlackBerry)[^\n]*/gi, "")
    .replace(/\[cid:[^\]]*\]\s*(<[^>]*>)?/gi, "")
    .replace(/\[(?:A |An )?[^\]]{0,80}(?:picture|image|drawing|logo)[^\]]{0,80}\]\s*(<[^>]*>)?/gi, "")
    .replace(/^[_\-\u2500-\u257F]{6,}$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type TrimmedBody = {
  /** The new content, quoted history and chrome removed, capped. */
  text: string;
  /** Length of the body as Graph returned it, BEFORE any trimming. */
  originalChars: number;
  /** True only when the cap cut it. Trimming away chrome is not truncation. */
  truncated: boolean;
  /**
   * True when the quoted-tail cut removed everything and the uncut text was
   * used instead. The caller holds MORE than usual, including the quoted
   * thread, and the boundary detection failed on this message.
   */
  cutFellThrough: boolean;
};

/**
 * Trim a raw Graph body down to what the sender actually wrote.
 *
 * originalChars is the RAW length, not the trimmed length, so a stored body can
 * always answer "how much did we drop". Without it a short email and a heavily
 * quoted one are indistinguishable after the fact.
 */
export function trimMessageBody(body: string, opts?: { cap?: number }): TrimmedBody {
  const originalChars = body.length;
  const raw = body.replace(/\r/g, "");

  const scrub = (s: string) =>
    s
      .split("\n")
      .filter((l) => !NOISE_LINE_RE.test(l) && !NOISE_CONTAINS_RE.test(l))
      .join("\n")
      // Safelinks wraps every URL in ~900 characters of tracking, which drowns
      // the prose it is attached to and burns the cap on nothing.
      .replace(/<https?:\/\/[^>]{60,}>/g, "")
      .replace(/https?:\/\/\S{120,}/g, "[long link]")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  let cleaned = scrub(stripMailChrome(raw));
  let cutFellThrough = false;

  // IF THE CUT REMOVED EVERYTHING, THE CUT WAS WRONG.
  //
  // Measured over 2,075 stored bodies: 195 trimmed to an empty string while
  // recording body_status 'stored', and 160 more had a raw body over 5,000
  // characters and kept under 120. The cause is the quoted-tail boundary firing
  // on the FIRST line: a forward whose note sits below the quote, a reply typed
  // underneath, or a message whose opening line happens to start "From:".
  //
  // Returning nothing is the worst available answer, because every caller then
  // records an empty body as successfully stored. Falling back to the
  // chrome-stripped but uncut text keeps the quoted thread, which is noisy and
  // is unambiguously better than silence.
  if (cleaned.length === 0) {
    const uncut = scrub(raw);
    if (uncut.length > 0) {
      cleaned = uncut;
      cutFellThrough = true;
    }
  }

  const cap = opts?.cap;
  if (cap === undefined || cleaned.length <= cap) {
    return { text: cleaned, originalChars, truncated: false, cutFellThrough };
  }
  return { text: cleaned.slice(0, cap).trimEnd(), originalChars, truncated: true, cutFellThrough };
}
