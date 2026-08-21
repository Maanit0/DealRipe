/**
 * ONE ranking for the Monday digest, used by everything that needs an order.
 *
 * WHY THIS EXISTS, measured 2026-08-20 against the live pilot
 *
 * The digest had two rankings and nothing reconciled them.
 * getPipelineChanges sorts its records by `attention`, a risk score where each
 * high-severity flag is worth 40 and deal size is capped at 30. digest-synthesis
 * then writes an LLM-authored "Do this" onto the first 8 of that array. And
 * lib/emails/weekly-digest.ts re-sorted by `dealSizeAnnual` and printed the top
 * 6, on the reasoning that Mark triages by revenue.
 *
 * Both orders are defensible. Having both silently is not. On the live data:
 *
 *   4 of the 6 deals printed in Mark's email had only the deterministic
 *   fallback action, including the two largest on the page, Seino Logix at
 *   $345,516 and Dunavant at $292,584, which are the first two things he reads.
 *
 *   6 of the 8 model calls were spent writing actions for deals the email
 *   never printed.
 *
 * The fix is not to pick one of the two sorts. It is to have exactly one, and
 * for the synthesis to follow the display order rather than lead it. Which
 * deals a leader sees is a product decision; which deals get an LLM pass is
 * downstream of it.
 *
 * WHAT THE ORDER IS
 *
 * Recoverable value, not risk and not revenue. A leader reading this on Monday
 * cannot act on "this deal is scary"; they can act on "this deal is worth a lot
 * and one specific thing is in the way." So three factors multiply:
 *
 *   value at stake      what closing it is worth
 *   risk that it bites  the existing attention score, which is already the
 *                       flag-weighted read and is not re-derived here
 *   fixability          whether there is a move a person can make this week
 *
 * The third is the one no existing sort had, and it is what demotes a deal that
 * has gone dark. A deal 30 days silent with unanswered outbound is genuinely at
 * risk and genuinely not recoverable by a leader on Monday, so it belongs on a
 * short separate list rather than at the top of the main one.
 *
 * UNKNOWN VALUE IS NOT ZERO
 *
 * 45 of 108 deals carry a null dealSizeAnnual. Sorting by `annual ?? 0` buries
 * every one of them beneath a $4,200 deal, which reads as "these are worthless"
 * when it means "Rolldog has no value on this opportunity". They are ranked at
 * a declared neutral value instead, and the count is returned so the digest can
 * say so out loud rather than let the omission speak.
 */

import type { DealChangeRecord } from "./pipeline-changes";

/** How many attention deals the digest prints. One constant, so the synthesis
 *  budget and the email can never disagree about the visible set again. */
export const DIGEST_ATTENTION_LIMIT = 6;

/**
 * Where a deal with no known value sits.
 *
 * Deliberately a real number rather than 0 or the median. It is roughly a small
 * Magaya deal, so an unvalued deal outranks a genuinely tiny one and loses to
 * anything substantial, which is the honest ordering when the only thing we
 * know is that we do not know.
 */
const UNKNOWN_ANNUAL = 40_000;

/**
 * Silence past which a leader cannot fix it this week.
 *
 * A deal nobody has spoken to in three weeks does not get rescued by an item on
 * a Monday agenda. It gets a decision about whether to keep working it, which is
 * a different conversation and a different list.
 */
const DARK_DAYS = 21;

/**
 * Squeeze the attention score into [1 - RISK_SWING, 1 + RISK_SWING].
 *
 * The band is deliberately narrow. Risk decides which of two similar deals
 * leads; it does not decide that a small troubled deal outranks a large one,
 * because a leader cannot act on relative alarm and can act on revenue.
 */
const RISK_SWING = 0.35;

function riskWeight(attention: number, span: { lo: number; hi: number }): number {
  if (span.hi <= span.lo) return 1;
  const t = (Math.max(attention, 1) - span.lo) / (span.hi - span.lo);
  return 1 - RISK_SWING + t * 2 * RISK_SWING;
}

export type DigestRank = {
  deal: DealChangeRecord;
  score: number;
  /** The value used for ranking, and whether it was actually read. */
  value: { annual: number; known: boolean };
  /** One clause naming why this is where it is, for a leader who disagrees. */
  because: string;
};

export type DigestPriority = {
  /** The deals to print, in the order to print them. */
  ranked: DigestRank[];
  /**
   * At risk and not fixable on a Monday: quiet past DARK_DAYS with nothing
   * booked. Kept separate rather than dropped, because a deal dying of silence
   * is Magaya's most recorded loss reason and deleting it from the digest is
   * how it stays that way.
   */
  goingDark: Array<{ deal: DealChangeRecord; daysQuiet: number | null }>;
  /**
   * Deals with no value in Rolldog, split by whether they made the cut.
   *
   * Two numbers rather than one because they answer different questions.
   * `printed` tells a reader why a card shows no dollar figure. `all` tells
   * them how much of the attention list is being ranked on a stand-in, which
   * on the live pilot is 49 of 63 and is a CRM hygiene problem rather than a
   * digest problem.
   */
  valueUnknown: { printed: number; all: number };
  /** Attention deals that did not make the cut, so the email can say how many. */
  belowTheFold: number;
};

function daysQuiet(d: DealChangeRecord, now: number): number | null {
  if (!d.lastConversationAt) return null;
  const t = Date.parse(d.lastConversationAt);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / 86_400_000);
}

/**
 * Can a person move this deal this week?
 *
 * 1.0 there is a named gap and a live conversation to close it in.
 * 0.6 the deal is alive but the next move belongs to the customer.
 * 0.25 quiet past DARK_DAYS: real risk, not this week's work.
 */
function fixability(d: DealChangeRecord, quiet: number | null): { f: number; why: string } {
  if (quiet !== null && quiet > DARK_DAYS && !d.nextMeetingBooked) {
    return { f: 0.25, why: `quiet ${quiet} days with nothing booked` };
  }
  if (d.repOwedMeeting) {
    return { f: 1, why: "a meeting was agreed and is not on the calendar" };
  }
  if (d.economicBuyer && !d.economicBuyer.engaged) {
    return { f: 1, why: "the person who signs has never been on a call" };
  }
  if (d.missing.length > 0 && d.nextMeetingBooked) {
    return { f: 1, why: `${d.missing.length} gate(s) open with a meeting booked to close them` };
  }
  if (d.nextStepIsCustomerWait) {
    return { f: 0.6, why: "the next move is the customer's" };
  }
  return { f: 0.6, why: "open gates, no specific move named" };
}

/**
 * The single digest ordering.
 *
 * `now` is injected rather than read from the clock so a caller can rank as of
 * a past moment, which is what makes a digest reproducible after the fact.
 */
export function rankForDigest(
  deals: DealChangeRecord[],
  opts: { now?: Date; limit?: number } = {},
): DigestPriority {
  const now = (opts.now ?? new Date()).getTime();
  const limit = opts.limit ?? DIGEST_ATTENTION_LIMIT;

  const attention = deals.filter((d) => d.needsAttention);
  const goingDark: Array<{ deal: DealChangeRecord; daysQuiet: number | null }> = [];
  const scored: DigestRank[] = [];

  // Risk is relative to THIS week's book, not to an absolute scale. A week
  // where every deal is troubled should still be ordered by value, and a week
  // with one outlier should let that outlier climb.
  const scores = attention.map((d) => Math.max(d.attention, 1));
  const attentionSpan = { lo: Math.min(...scores, 1), hi: Math.max(...scores, 1) };

  for (const d of attention) {
    const quiet = daysQuiet(d, now);
    const { f, why } = fixability(d, quiet);
    // Carries the number, so the email states the silence rather than asserting
    // it. "Quiet 34 days" is a fact a leader can act on; "going quiet" is a mood.
    if (f <= 0.25) goingDark.push({ deal: d, daysQuiet: quiet });

    const known = d.dealSizeAnnual !== null && d.dealSizeAnnual > 0;
    const annual = known ? (d.dealSizeAnnual as number) : UNKNOWN_ANNUAL;

    // VALUE IS THE PRIMARY AXIS, risk and fixability only modulate it.
    //
    // The first version multiplied log10(annual) by the raw attention score.
    // That inverted the intent: log10 spans 4.0 to 5.5 across this book, a
    // factor of 1.4, while attention spans 50 to 130, a factor of 2.6. Risk
    // therefore decided the order and value barely moved it, which put a deal
    // with no recorded value above Seino Logix at $345,516. A leader reading
    // that asks why, and is right to.
    //
    // sqrt keeps a real spread on value (a $345k deal is 2.9x a $40k one)
    // without letting one large deal own the list, and risk is squeezed into a
    // narrow band around 1 so it re-orders neighbours rather than overturning
    // the revenue order. Risk still comes from the existing attention score
    // rather than being re-derived: two flag engines disagreeing is the class
    // of bug this module exists to close.
    const value = Math.sqrt(annual);
    const risk = riskWeight(d.attention, attentionSpan);
    scored.push({
      deal: d,
      score: value * risk * f,
      value: { annual, known },
      because: known
        ? `$${Math.round(annual / 1000)}k at stake, ${why}`
        : `value not recorded in Rolldog, ${why}`,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.deal.account.localeCompare(b.deal.account));
  // Longest silent first: the ones closest to being unrecoverable lead.
  goingDark.sort((a, b) => (b.daysQuiet ?? 0) - (a.daysQuiet ?? 0));
  const ranked = scored.slice(0, limit);

  return {
    ranked,
    goingDark,
    valueUnknown: {
      printed: ranked.filter((r) => !r.value.known).length,
      all: scored.filter((s) => !s.value.known).length,
    },
    belowTheFold: Math.max(0, scored.length - ranked.length),
  };
}
