/**
 * Whose fault was it, and should it cost the call anything.
 *
 * Two defects share this file because they are the same mistake in two
 * places: the pipeline treats "this call could not be processed" and "the
 * pipeline could not run" as one thing, and it treats "we deliberately did
 * not do this" as a failure.
 *
 * 1. Retry budget. MAX_CONTENT_ATTEMPTS is 3 at one attempt per five-minute
 *    cron run. On 2026-08-16 the Anthropic key ran out of credit and every
 *    call captured during the outage exhausted its budget in fifteen minutes
 *    and was abandoned. Nothing about those transcripts was wrong. A billing
 *    stop, an expired key, a rate limit and a 503 are all reasons to wait,
 *    not reasons to give up on a conversation.
 *
 * 2. Follow-up drafts. "rep already emailed the customer after this call, so
 *    no draft was written" is the product working exactly as designed, and it
 *    was being written into ingest_error and counted as an attempt. Three
 *    calls have been carrying it since 2026-08-14 and read as broken in every
 *    view that keys on that column.
 *
 * The rule both halves follow: a return value says which of "no" and "did not
 * check" it means, and neither is ever silently converted into the other.
 */

// ====================================================================
// Extraction failures
// ====================================================================

export type IngestFailureClass =
  /** The provider was down, slow, or unreachable. Nothing to do but wait. */
  | "provider"
  /** Our credentials are wrong or expired. Waiting will not fix it; a human must. */
  | "auth"
  /** We are going too fast. Waiting fixes it. */
  | "rate_limit"
  /** The account cannot pay. Waiting does not fix it, but retrying costs nothing. */
  | "billing"
  /** The transcript itself could not be processed. This one is the call's own. */
  | "content"
  /** We could not tell. Never silently treated as content. */
  | "unknown";

export type IngestFailureVerdict = {
  class: IngestFailureClass;
  /**
   * Whether this spends the content retry budget. True only for 'content'.
   * Everything else, including 'unknown', spends the separate infra budget so
   * an outage cannot abandon a conversation.
   */
  spendsContentBudget: boolean;
  /** How long to wait before the next attempt. */
  backoffMs: number;
  /** True when no amount of retrying will help and someone has to act. */
  needsHuman: boolean;
  detail: string;
};

/**
 * Ordered most specific first. A billing error from Anthropic is a 400 whose
 * body mentions the credit balance, so it must be tested before anything that
 * matches on a status code.
 */
const PATTERNS: Array<{
  class: IngestFailureClass;
  re: RegExp;
  needsHuman: boolean;
  detail: string;
}> = [
  {
    class: "billing",
    re: /credit balance|insufficient_quota|insufficient funds|billing|payment required|\b402\b|quota exceeded/i,
    needsHuman: true,
    detail: "the provider account cannot pay for the call",
  },
  {
    class: "auth",
    re: /\b401\b|\b403\b|invalid[_ -]?api[_ -]?key|authentication_error|unauthorized|forbidden|invalid x-api-key|expired token/i,
    needsHuman: true,
    detail: "our credentials were rejected",
  },
  {
    class: "rate_limit",
    re: /\b429\b|rate[_ -]?limit|too many requests|overloaded_error/i,
    needsHuman: false,
    detail: "we were asked to slow down",
  },
  {
    class: "provider",
    re: /\b5\d\d\b|overloaded|service unavailable|bad gateway|gateway timeout|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|fetch failed|network error|premature close/i,
    needsHuman: false,
    detail: "the provider did not answer",
  },
  {
    class: "content",
    re: /FrameworkNotConfigured|no framework|framework is not configured|could not parse|invalid json|malformed|schema|transcript is empty|no deal for|unknown field key|validation failed/i,
    needsHuman: true,
    detail: "the transcript or its configuration could not be processed",
  },
];

/** Wait between attempts for a failure that is not the call's fault. */
const BACKOFF_MS: Record<IngestFailureClass, (attempt: number) => number> = {
  // Doubling from five minutes, capped at an hour. An outage that lasts
  // longer than an hour is not going to be helped by asking more often.
  provider: (n) => Math.min(60, 5 * 2 ** Math.max(0, n - 1)) * 60_000,
  rate_limit: (n) => Math.min(60, 5 * 2 ** Math.max(0, n - 1)) * 60_000,
  // A human has to rotate a key or top up an account. Checking every five
  // minutes accomplishes nothing except log noise.
  auth: () => 60 * 60_000,
  billing: () => 60 * 60_000,
  // We do not know what this is, so we neither hammer it nor abandon it.
  unknown: () => 15 * 60_000,
  // Not used: content failures retry on the next cron run as they always did.
  content: () => 0,
};

/**
 * Attempts allowed before a call is parked for a human.
 *
 * Content is unchanged at three: a transcript that fails three times is not
 * going to succeed on the fourth and a person should look.
 *
 * Infra is twelve, which with the backoff above is roughly a working day.
 * It exists so that a permanently broken key does not retry until the heat
 * death of the pilot, not because twelve is meaningful.
 */
export const MAX_CONTENT_ATTEMPTS = 3;
export const MAX_INFRA_ATTEMPTS = 12;

/**
 * Classify an extraction failure.
 *
 * Default is 'unknown', and 'unknown' does NOT spend the content budget. An
 * unrecognised error is exactly the case where guessing is expensive: read as
 * content it abandons a real conversation after three runs, and read as infra
 * it costs some retries and a line in the health report saying we could not
 * classify it. The second is cheaper and honest, and the report makes the gap
 * visible so the pattern list can grow.
 */
export function classifyIngestFailure(
  message: string,
  infraAttempt = 1,
): IngestFailureVerdict {
  for (const p of PATTERNS) {
    if (!p.re.test(message)) continue;
    return {
      class: p.class,
      spendsContentBudget: p.class === "content",
      backoffMs: BACKOFF_MS[p.class](infraAttempt),
      needsHuman: p.needsHuman,
      detail: p.detail,
    };
  }
  return {
    class: "unknown",
    spendsContentBudget: false,
    backoffMs: BACKOFF_MS.unknown(infraAttempt),
    needsHuman: false,
    detail: "we could not tell what caused this, so it is being backed off rather than counted against the call",
  };
}

// ====================================================================
// Follow-up drafts
// ====================================================================

export type DraftDisposition = {
  /**
   * held        we deliberately wrote no draft and that is correct.
   * failed      we tried to write one and could not.
   * unavailable we could not establish whether one was warranted. Not the
   *             same as deciding against one, and it must never be read as
   *             "the rep did not follow up".
   */
  state: "held" | "failed" | "unavailable";
  /** Whether another run is likely to succeed. Only meaningful when state is failed. */
  retryable: boolean;
  /** True when a person has to change configuration for this ever to work. */
  needsHuman: boolean;
  reason: string;
};

/**
 * Reasons a draft was deliberately not written. Every one of these is the
 * product working, and none of them is an error.
 *
 * "no rep email on the deal" and the mailbox allowlist are holds with a
 * configuration flavour: nothing failed, but nothing will ever happen either
 * until someone changes something, so they are flagged for a human without
 * being counted as failures.
 */
const HOLD_PATTERNS: Array<{ re: RegExp; needsHuman: boolean }> = [
  { re: /rep already emailed the customer/i, needsHuman: false },
  { re: /follow-up already drafted for this call/i, needsHuman: false },
  { re: /is not an opportunity call/i, needsHuman: false },
  { re: /no customer-side attendee on the call/i, needsHuman: false },
  { re: /no rep email on the deal/i, needsHuman: true },
  { re: /is not on GRAPH_MAIL_ALLOWED_MAILBOXES/i, needsHuman: true },
];

/**
 * "We asked and could not find out." The Graph read that checks whether the
 * rep already followed up can fail, and its failure is neither a hold nor a
 * draft failure: it means the precondition is unknown. Writing a draft on
 * that basis risks duplicating an email the rep already sent, which is worse
 * than the missing draft, so it is recorded as unavailable and retried.
 */
const UNAVAILABLE_PATTERN =
  /could not read .* to check whether the rep already followed up|could not establish/i;

/**
 * Failures worth another attempt. Unchanged from the list that was inline in
 * transcript-sync, which was derived from three of Ariel's drafts on
 * 2026-08-13 that all succeeded on the first manual retry with no code change.
 *
 * Default is NOT retryable. An unrecognised reason retried forever is worse
 * than one that waits for a human.
 */
const RETRYABLE_FAILURE =
  /timeout|timed out|rate.?limit|429|50\d\b|socket|network|fetch failed|ECONNRESET|overloaded|generation returned nothing|draft not created|did not report a result/i;

export function classifyDraftOutcome(reason: string): DraftDisposition {
  for (const h of HOLD_PATTERNS) {
    if (h.re.test(reason)) {
      return { state: "held", retryable: false, needsHuman: h.needsHuman, reason };
    }
  }
  if (UNAVAILABLE_PATTERN.test(reason)) {
    return { state: "unavailable", retryable: true, needsHuman: false, reason };
  }
  return {
    state: "failed",
    retryable: RETRYABLE_FAILURE.test(reason),
    needsHuman: false,
    reason,
  };
}
