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
import { stageKeyFromName, stageRank } from "./rolldog-summary";

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

/**
 * Silence that disqualifies an Expect.
 *
 * Shorter than the stalling threshold on purpose. `losing_momentum` asks
 * whether a deal is dying, measured against its OWN rhythm. This asks a
 * narrower question with a fixed answer: an Expect carries a number in this
 * quarter's roll-up, and three weeks of nothing is too long for a deal doing
 * that.
 */
const EXPECT_STALE_DAYS = 21;

/**
 * Silence that makes a Pipeline deal storage rather than upside.
 *
 * Deliberately long. The weakest band is where early deals legitimately sit
 * quiet between conversations, and flagging those at three weeks would fire on
 * most of the book and teach a leader to skip the section.
 */
const PIPELINE_DEAD_DAYS = 60;

/**
 * A close-date push large enough to be its own event.
 *
 * `close_date_repeatedly_pushed` catches a pattern of small moves. This catches
 * the single move of a quarter or more, which is a different fact: the deal
 * changed, not the date, and one big push never trips a count-of-two rule.
 */
const MAJOR_SLIP_DAYS = 60;

/**
 * How long an unanswered message waits before it means something.
 *
 * Seven calendar days, which is five working ones, so a Friday send is not
 * flagged on Wednesday. See the comment at the flag: the ungated version fired
 * on 60% of the book.
 */
const UNANSWERED_DAYS = 7;

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
  /**
   * WHY the CRM state is absent, which the absent state cannot say.
   *
   * Passing only `crm` collapses five distinguishable reads into one null and
   * silently disables every band flag. `no_open_opportunity` in particular is
   * a finding in its own right, not a missing input.
   */
  crmRead?: string | null;

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

  // ---- FORECAST VALIDATION -----------------------------------------------
  //
  // The Kiddom catalogue's second group, translated to Magaya's bands. Each one
  // is a JOIN between the band the rep claims and evidence DealRipe already
  // computes, which makes them the cheapest high-value flags available and the
  // reason a leader opens the room at all.
  //
  // ON THE BAND MAPPING, because getting it backwards inverts all of them:
  // in the source scheme LOW is the MOST certain band, not the least. Its own
  // evidence table requires "Committed stage, clear customer commitment,
  // engaged economic buyer, validated close date" for Low, and calls High
  // "credible upside, not a storage bucket for stale deals". So Low is Commit,
  // Medium is Expect, High is Pipeline. See docs/flag-catalogue.md.
  const stageKey = stageKeyFromName(crm?.stageName ?? null);
  const stage = stageRank(stageKey);
  const quiet = s.daysSinceLastCall.status === "read" ? s.daysSinceLastCall.value : null;
  const noNextMeeting = s.nextMeetingBooked.status === "read" && !s.nextMeetingBooked.value;

  if (bandRank !== null && bandRank >= BAND_ORDER.Commit) {
    // "Low Forecast Without Customer Commitment". The single most predictive
    // one in the group: a Commit is a promise that the customer has agreed to
    // something, and this asks whether anyone heard them agree.
    if (s.commitmentSecured.status === "read" && !s.commitmentSecured.value) {
      flags.push({
        id: "commit_without_commitment",
        severity: "critical",
        title: "Commit with nothing the customer agreed to",
        evidence: `the rep has this at Commit and ${s.commitmentSecured.evidence}`,
        move: "get one dated thing the customer says yes to, in writing, before this counts in the roll-up",
        audience: ["rep", "leader"],
      });
    }
    // "Low Forecast With No Upcoming Meeting".
    if (noNextMeeting) {
      flags.push({
        id: "commit_without_next_meeting",
        severity: "warning",
        title: "Commit with nothing on the calendar",
        evidence: "the rep has this at Commit and no next meeting is booked with the customer",
        move: "a deal that closes this quarter has a next conversation; book it or move the band",
        audience: ["rep", "leader"],
      });
    }
    // "Low Forecast Still Not Committed", as a stage-versus-band check.
    if (stage !== null && stage < 4) {
      flags.push({
        id: "commit_at_early_stage",
        severity: "warning",
        title: `Commit while the CRM still has this at ${stageKey}`,
        evidence: `the rep forecasts Commit and the opportunity sits at "${crm?.stageName}"`,
        move: "move the stage or move the band; one of the two is wrong and the roll-up reads the band",
        audience: ["leader"],
      });
    }
  }

  if (bandRank !== null && bandRank === BAND_ORDER.Expect) {
    // "Medium Forecast Still Qualified".
    if (stage !== null && stage < 3) {
      flags.push({
        id: "expect_at_early_stage",
        severity: "watch",
        title: `Expect while the CRM still has this at ${stageKey}`,
        evidence: `the rep forecasts Expect and the opportunity sits at "${crm?.stageName}"`,
        move: "either the solution is further along than the stage says, or the band is ahead of the deal",
        audience: ["leader"],
      });
    }
    // "Medium Forecast Without Recent Engagement".
    if (quiet !== null && quiet >= EXPECT_STALE_DAYS && noNextMeeting) {
      flags.push({
        id: "expect_without_engagement",
        severity: "warning",
        title: `Expect on a deal with no contact in ${quiet} days`,
        evidence: `the rep has this at Expect, the last captured conversation was ${quiet} days ago, and nothing is booked`,
        move: "an Expect carries a number this quarter; get a conversation on the calendar or move it down",
        audience: ["rep", "leader"],
      });
    }
  }

  // "High Forecast Is Inactive". Reads oddly until you have the mapping: this
  // is the weakest band going stale, which is how a pipeline fills with deals
  // nobody has decided to stop working.
  if (bandRank === BAND_ORDER.Pipeline && quiet !== null && quiet >= PIPELINE_DEAD_DAYS && noNextMeeting) {
    flags.push({
      id: "pipeline_inactive",
      severity: "watch",
      title: `Pipeline deal untouched for ${quiet} days`,
      evidence: `no captured conversation in ${quiet} days and nothing booked, while the deal still counts as pipeline`,
      move: "Pipeline should be credible upside, not storage. Work it deliberately or omit it",
      audience: ["leader"],
    });
  }

  // "Major Close-Date Slip". A single push of a quarter or more is a different
  // event from three small ones and is not caught by the repeated-push rule.
  if (
    s.closeDateSlips.status === "read" &&
    s.closeDateSlips.value === 1 &&
    /(\d+) days? in total/.test(s.closeDateSlips.evidence)
  ) {
    const total = Number(s.closeDateSlips.evidence.match(/(\d+) days? in total/)![1]);
    if (total >= MAJOR_SLIP_DAYS) {
      flags.push({
        id: "close_date_major_slip",
        severity: "warning",
        title: `Close date moved ${total} days in one change`,
        evidence: s.closeDateSlips.evidence,
        move: "a push this size is a change in the deal, not a change in the date; find out which and record it",
        audience: ["rep", "leader"],
      });
    }
  }

  // ---- FLAGS THAT DO NOT NEED A BAND --------------------------------------
  //
  // Everything above is gated on bandRank, which means a deal with no readable
  // CRM band produces NO band flags at all. That is correct for a claim about
  // the rep's forecast and catastrophic as a default, and it was silently
  // hiding the worst deals in the book.
  //
  // Measured 2026-08-20 on the six deals the digest actually prints: three of
  // them (Seino Logix, GHY, Caderco) carry no open Salesforce opportunity, so
  // crm was null and every flag was skipped. GHY has four critical gates open,
  // no economic buyer and nothing booked, and produced zero flags. Dunavant, a
  // $293k deal advancing with no economic buyer ever on a call, produced zero
  // flags because that check required a Commit band.
  //
  // Absence of a CRM read rendered as absence of a problem. The signature bug,
  // arriving inside the flag engine.

  // NO OPEN OPPORTUNITY IS NOT A CLOSED DEAL, and the first version of this
  // flag said it was.
  //
  // It shipped as "every opportunity on the account is closed, so this deal may
  // have resolved outside DealRipe" and fired on 45 deals. Checked against
  // resolveDealOutcome, it was right on ZERO of them: 36 accounts carry no
  // opportunity AT ALL rather than closed ones, and the other 9 carry only
  // closes that predate our first call, which is an existing customer having a
  // new conversation (Tqlglobal's most recent close is 2025-08-01 and its first
  // captured call is 2026-08-13).
  //
  // The cause is Magaya's own motion, which scripts/link-deal.ts prints on every
  // run: DealRipe creates a deal from a calendar invite, and Magaya does not
  // create the opportunity until AFTER the discovery call. So "no open
  // opportunity" is the NORMAL state of a new deal here, and a deal that
  // genuinely resolved already carries an outcome_label and is dropped upstream
  // by loadPortfolioRead before it ever reaches this function.
  //
  // What is actually worth saying is narrower and true: a deal the rep has
  // worked more than once with no opportunity to write to. Field write-back,
  // the stage and the forecast all need one, so this is a real blocker rather
  // than a guess about whether the deal is alive. One deal qualifies today.
  const worked = s.conversationCount.status === "read" ? s.conversationCount.value : null;
  if (args.crmRead === "no_open_opportunity" && worked !== null && worked >= 2) {
    flags.push({
      id: "worked_with_no_opportunity",
      severity: "warning",
      title: `${worked} calls in and no Salesforce opportunity exists`,
      evidence:
        `the account is linked and carries no open opportunity, so there is nothing for the stage, the ` +
        `forecast or field write-back to attach to`,
      move: "create the opportunity so this deal can be forecast and written to, or say why it should not be",
      audience: ["rep", "leader"],
    });
  }

  // A deal being actively worked with nobody who can sign it.
  //
  // Gated on ENGAGEMENT rather than on band, so it says "this deal is
  // progressing without a signer" and not "this early deal has not met the
  // signer yet", which would be true of most of the book and useless.
  const engaged =
    (s.nextMeetingBooked.status === "read" && s.nextMeetingBooked.value) ||
    (s.fieldsAnswered.status === "read" && s.fieldsAnswered.value >= 3);
  if (
    bandRank === null &&
    engaged &&
    s.economicBuyerEngaged.status === "read" &&
    !s.economicBuyerEngaged.value
  ) {
    flags.push({
      id: "no_economic_buyer_while_progressing",
      severity: "warning",
      title: "Progressing with nobody who can sign it",
      evidence: `the deal is moving and ${s.economicBuyerEngaged.evidence}`,
      move: "name who signs and get them into the next conversation while there still is one",
      audience: ["rep", "leader"],
    });
  }

  // A deal at the top of a forecast that we have never heard.
  //
  // Seino Logix leads the digest at $345,516 and no captured call on it has
  // produced a conversation. A leader reading a ranked list is entitled to know
  // which rows are ranked on the CRM's word alone.
  if (
    s.daysSinceLastCall.status === "unavailable" &&
    s.criticalGapsOpen.status === "unavailable" &&
    a.confidence !== "low"
  ) {
    flags.push({
      id: "never_heard",
      severity: "warning",
      title: "No conversation has ever been captured on this deal",
      evidence: `${s.daysSinceLastCall.reason}, so everything known about it comes from the CRM`,
      move: "get DealRipe on the next call, or treat this deal's forecast as the rep's word alone",
      audience: ["leader"],
    });
  }

  // THE CHAMPION THE REP MAY BE MISTAKING FOR THE SIGNER.
  //
  // A senior person is engaged, the calls read them as a champion, and nobody
  // on the deal is identified as the buyer. That is a deal being run through
  // someone who cannot approve it, which is the most expensive mistake in
  // mid-market selling and the one a forecast never shows until signature.
  //
  // No CRM holds the evidence: it needs the transcript to say who the person is
  // to the deal, which is what contacts-extract produces. Raised at `warning`
  // rather than critical because being wrong about it costs a rep one question,
  // and being right about it saves a quarter.
  if (s.championMistakenForBuyer.status === "read" && s.championMistakenForBuyer.value) {
    flags.push({
      id: "champion_not_signer",
      severity: "warning",
      title: `${s.championMistakenForBuyer.value} may be a champion rather than the signer`,
      evidence: s.championMistakenForBuyer.evidence,
      move: "ask them directly who approves a purchase this size, and get that person into a conversation",
      audience: ["rep", "leader"],
    });
  }

  // ---- ENGAGEMENT, the flags a CRM cannot produce -------------------------

  // A WAITING PERIOD, not just the state.
  //
  // awaitingReply is true the moment a rep sends a follow-up, which is the
  // normal condition of a live conversation. Ungated, this fired on 67 of 112
  // open deals, 60% of the book, and a flag that fires on most rows is not a
  // flag: it is a background colour, and it teaches a leader to skip the
  // section it appears in.
  //
  // Five working days is the threshold, expressed as seven calendar days so a
  // Friday send is not flagged on Wednesday. Below it, an unanswered email is
  // an email in flight.
  const waited = s.daysSinceOurMessage.status === "read" ? s.daysSinceOurMessage.value : null;
  if (s.awaitingReply.status === "read" && s.awaitingReply.value && waited !== null && waited >= UNANSWERED_DAYS) {
    flags.push({
      id: "emailing_without_reply",
      severity: "warning",
      title: `We wrote ${waited} days ago and they have not answered`,
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


/**
 * The flags, rendered for a briefing prompt.
 *
 * WHY A RENDERER RATHER THAN HANDING OVER THE OBJECTS
 *
 * A briefing is read live on a call, and two of the three fields on a Flag are
 * for a different reader. `move` is written for a leader or for the rep's own
 * planning ("move the band", "or stop working it"), and a rep who reads that
 * out on a call has said something about our forecast to a customer, which the
 * briefing rules forbid outright. So only the title and the evidence cross
 * over, and the prompt is told these are the ONLY acceptable basis for the
 * signal flag.
 *
 * `watch` is dropped. A briefing carries one signal flag, so a list that
 * includes the low-severity ones just gives the model more to choose wrongly
 * from.
 *
 * Returns null rather than an empty string when there is nothing, so the
 * prompt block is omitted entirely instead of appearing with nothing under it.
 */
export function renderFlagsForBriefing(flags: Flag[]): string | null {
  const useful = flags
    .filter((f) => f.severity !== "watch")
    .filter((f) => f.audience.includes("rep") || f.severity === "critical");
  if (useful.length === 0) return null;
  return useful.map((f) => `- ${f.title}. ${f.evidence}`).join("\n");
}
