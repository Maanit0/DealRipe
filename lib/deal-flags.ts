/**
 * Deal flags: one definition, three audiences.
 *
 * WHY A SINGLE ENGINE
 *
 * A flag currently has no home. The briefing computes its own blockers, the
 * digest computes its own risks, and the forecast room computes a third set.
 * Three implementations of "what is wrong with this deal" drift, and when they
 * disagree a rep and their leader are looking at different truths about the
 * same deal. This is the one definition; the briefing, the digest and the
 * forecast room render it.
 *
 * WHAT MAKES THESE FLAGS DIFFERENT FROM A CRM'S
 *
 * Kiddom's ops lead wrote the critique better than we would have:
 *
 *   "Most flags turn on whether something was documented. No economic buyer
 *    fires when nobody has been tagged as one. Run against CRM fields alone, a
 *    flag set measures whether a rep filled something in, so a disciplined rep
 *    with a dying deal stays green and a busy rep with a healthy deal lights
 *    up red."
 *
 * Every flag here reads evidence: who spoke, who wrote, what the calls proved,
 * what the CRM's own history recorded. None of them fires because a field is
 * blank.
 *
 * AND EVERY FLAG CARRIES ITS MOVE
 *
 * Also theirs: "Not a list of red items, but the next action." A flag with no
 * move is a complaint. `move` is required.
 *
 * THE TWO AXES THAT MATTER MOST, AND WHY THEY ARE NOT THE SAME
 *
 *   BAND vs EVIDENCE. "No economic buyer" is a gap. "COMMIT with no economic
 *   buyer" is a contradiction between what the rep claims and what the deal
 *   supports, and only the second is worth a leader's Tuesday.
 *
 *   CLOSE DATE vs EVIDENCE. A close date is a claim about TIME, and time is
 *   what turns a gap into arithmetic that does not work. No economic buyer on
 *   a deal closing in ninety days is a gap. On a deal closing in ten days it
 *   is impossible: nobody who can sign has been in a room.
 *
 * READ ONLY. Computes, never writes.
 */

import type { BuyerSignals, DealAssessment } from "./deal-signals-buyer";
import type { SalesforceSnapshot } from "./salesforce-stage";

export type FlagSeverity = "critical" | "warning" | "watch";

export type Flag = {
  /** Stable slug. Never rendered; used for counting, suppressing and learning. */
  id: string;
  severity: FlagSeverity;
  /** One line, for a table row. */
  title: string;
  /** Why it fired, with the numbers in it. A flag that cannot show its work
   *  gets argued with once and ignored forever after. */
  evidence: string;
  /** What to do about it. Required: a flag with no move is a complaint. */
  move: string;
  /** Who this changes a decision for. A flag nobody acts on is noise. */
  audience: Array<"rep" | "leader">;
};

/**
 * Bands ordered weakest to strongest, matching Magaya's own picklist.
 *
 * `Omitted` is listed EXPLICITLY at -1 rather than left to fall out of the
 * lookup as undefined. Both produce the same behaviour today, and only one of
 * them says which behaviour was intended: a rep who omits a deal has made a
 * decision not to forecast it, so there is no forecast for the band-versus-
 * evidence rules below to contradict. An unlisted band and a deliberately
 * terminal one must not be indistinguishable, which is this codebase's own
 * governing rule applied to a lookup table.
 *
 * `Closed` never reaches here: a deal carrying an outcome_label is dropped
 * upstream in loadPortfolioRead.
 */
const BAND_ORDER: Record<string, number> = { Omitted: -1, Pipeline: 0, Expect: 1, Commit: 2 };

/**
 * Inside this many days, an open decisive gate stops being a gap and becomes
 * arithmetic that does not work. Three weeks is roughly one Magaya sales
 * cycle's worth of scheduling: getting a new executive into a room, getting
 * budget confirmed and getting a signature all take longer than this.
 */
const IMMINENT_DAYS = 21;

function daysUntil(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round((t - now.getTime()) / 86_400_000);
}

/** The gaps that decide whether a deal can close, as opposed to the ones that
 *  merely make it riskier. An unidentified competitor is a risk; an absent
 *  signer is a blocker. */
function decisiveGaps(s: BuyerSignals): string[] {
  if (s.criticalGapsOpen.status !== "read") return [];
  return s.criticalGapsOpen.value.filter(
    (g) => g.includes("economic buyer") || g.includes("budget") || g.includes("close date"),
  );
}

export function computeDealFlags(args: {
  signals: BuyerSignals;
  assessment: DealAssessment;
  /** The customer's CRM state, when we could read it. */
  crm?: SalesforceSnapshot | null;
  now?: Date;
}): Flag[] {
  const { signals: s, assessment: a } = args;
  const now = args.now ?? new Date();
  const flags: Flag[] = [];
  const crm = args.crm ?? null;
  const band = crm?.forecastCategory ?? null;
  const bandRank = band ? (BAND_ORDER[band] ?? null) : null;
  const closeIn = daysUntil(crm?.closeDate ?? null, now);
  const gaps = decisiveGaps(s);

  // ---- CLOSE DATE, the axis nobody flags ---------------------------------

  if (closeIn !== null && closeIn < 0) {
    flags.push({
      id: "close_date_past",
      severity: "warning",
      title: "Close date is in the past",
      evidence: `the opportunity still carries a close date of ${crm?.closeDate}, ${Math.abs(closeIn)} days ago`,
      move: "set a date the deal can actually hit, or close it out",
      audience: ["rep", "leader"],
    });
  }

  if (closeIn !== null && closeIn >= 0 && closeIn <= IMMINENT_DAYS && gaps.length > 0) {
    flags.push({
      id: "close_date_unachievable",
      severity: "critical",
      title: `Closing in ${closeIn} days with ${gaps.length} decisive gap(s) open`,
      // The arithmetic is the argument. Nobody signs in eleven days when the
      // person who signs has not been in a room.
      evidence: `close date ${crm?.closeDate} is ${closeIn} days out, and the calls have not established: ${gaps.join("; ")}`,
      move:
        closeIn <= 7
          ? "either get these settled this week or move the date, because the forecast is carrying a number that cannot land"
          : "work the gap that blocks signature first; the others can follow",
      audience: ["rep", "leader"],
    });
  }

  if (s.closeDateSlips.status === "read" && s.closeDateSlips.value >= 2) {
    const stillSoon = closeIn !== null && closeIn <= IMMINENT_DAYS;
    flags.push({
      id: "close_date_repeatedly_pushed",
      severity: stillSoon ? "critical" : "warning",
      title: `Close date pushed ${s.closeDateSlips.value} times`,
      evidence:
        s.closeDateSlips.evidence +
        (stillSoon ? `, and it is again claimed ${closeIn} days out` : ""),
      move: stillSoon
        ? "the date has been wrong twice; ask the customer what has to happen first and date it from that, not from the quarter"
        : "ask what changed each time the date moved; the reason is usually the real blocker",
      audience: ["rep", "leader"],
    });
  }

  // ---- BAND AGAINST EVIDENCE ---------------------------------------------
  //
  // These are the rows a leader should open on Tuesday, because each one is a
  // specific contradiction rather than a score.

  if (bandRank !== null && bandRank >= BAND_ORDER.Commit) {
    if (s.economicBuyerEngaged.status === "read" && !s.economicBuyerEngaged.value) {
      flags.push({
        id: "commit_without_economic_buyer",
        severity: "critical",
        title: "Commit with no economic buyer",
        evidence: `the rep has this at Commit and ${s.economicBuyerEngaged.evidence}`,
        move: "name who signs and get them into the next meeting, or move the band",
        audience: ["rep", "leader"],
      });
    }
    if (gaps.some((g) => g.includes("budget"))) {
      flags.push({
        id: "commit_without_budget",
        severity: "critical",
        title: "Commit with no established budget",
        evidence: "the rep has this at Commit and no call has established a budget",
        move: "get a number said out loud by the customer before this counts in the roll-up",
        audience: ["rep", "leader"],
      });
    }
  }

  if (bandRank !== null && bandRank > BAND_ORDER.Pipeline) {
    if (a.momentum === "stalling") {
      flags.push({
        id: "band_above_pipeline_while_stalling",
        severity: "critical",
        title: `${band} on a deal that has gone quiet`,
        evidence: `the rep has this at ${band}. ${a.momentumReason}`,
        move: "re-establish contact this week or move the band; the forecast is carrying a deal nobody is talking to",
        audience: ["rep", "leader"],
      });
    }
    if (s.distinctCustomerSpeakers.status === "read" && s.distinctCustomerSpeakers.value < 2) {
      flags.push({
        id: "band_above_pipeline_single_threaded",
        severity: "warning",
        title: `${band} on a single-threaded deal`,
        evidence: `the rep has this at ${band} and ${s.distinctCustomerSpeakers.evidence}`,
        move: "get a second person from their side into the next conversation",
        audience: ["rep", "leader"],
      });
    }
  }

  // The other direction, and the one only an independent read can produce. A
  // rep excluding a deal the buyer is actively advancing is sandbagging, and
  // it was inexpressible until DealRipe's own ladder gained an Omitted rung:
  // with a Commit/Expect/Pipeline scale there was no way to tell "we agree
  // this is out" from "we never had a way to say that".
  if (band === "Omitted" && a.band !== null && (BAND_ORDER[a.band] ?? -1) > BAND_ORDER.Pipeline) {
    flags.push({
      id: "omitted_but_advancing",
      severity: "warning",
      title: `Omitted by the rep, and the buyer is acting like ${a.band}`,
      evidence: `the rep has excluded this from the forecast. ${a.momentumReason}`,
      move: "ask why it is out; either the forecast is short a deal or there is a reason the calls do not show",
      audience: ["leader"],
    });
  }

  // ---- ENGAGEMENT, the flags a CRM cannot produce -------------------------

  if (s.awaitingReply.status === "read" && s.awaitingReply.value) {
    flags.push({
      id: "emailing_without_reply",
      severity: "warning",
      title: "We wrote last and they have not answered",
      evidence: s.awaitingReply.evidence,
      // Kiddom named this among the most predictive flags they cannot build,
      // because it needs the mailbox and Salesforce does not hold the evidence.
      move: "change the channel or the person rather than sending a third email into the same thread",
      audience: ["rep"],
    });
  }

  if (s.silentInvitees.status === "read" && s.silentInvitees.value > 0) {
    flags.push({
      id: "invited_but_silent",
      severity: "watch",
      title: `${s.silentInvitees.value} invited person(s) did not speak`,
      evidence: s.silentInvitees.evidence,
      move: "ask them a direct question early next time; a silent invitee is either a blocker or a spectator and both matter",
      audience: ["rep"],
    });
  }

  if (a.momentum === "stalling") {
    flags.push({
      id: "losing_momentum",
      severity: "critical",
      title: "Losing momentum",
      evidence: a.momentumReason,
      // Magaya's dominant recorded loss reason is No Decision / Non-Responsive:
      // five of six labelled losses. This is what that looks like early.
      move: "decide deliberately whether to rescue this or stop working it; deals like this die of silence rather than to a competitor",
      audience: ["rep", "leader"],
    });
  }

  // ---- WHAT WE COULD NOT CHECK -------------------------------------------
  //
  // Not a flag about the deal. A flag about US, so a leader reading a short
  // list knows whether it is short because the deal is clean or because we
  // could not see it.
  if (a.confidence === "low") {
    flags.push({
      id: "insufficient_evidence",
      severity: "watch",
      title: "Too little evidence to judge this deal",
      evidence: `only ${12 - a.notChecked.length} of 12 signals could be read: ${a.notChecked.slice(0, 2).join("; ")}`,
      move: "treat the absence of flags here as unknown rather than as clean",
      audience: ["leader"],
    });
  }

  const rank: Record<FlagSeverity, number> = { critical: 0, warning: 1, watch: 2 };
  return flags.sort((x, y) => rank[x.severity] - rank[y.severity]);
}
