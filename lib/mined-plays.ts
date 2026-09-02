/**
 * The learned motion, read back into the briefing.
 *
 * lib/magaya-plays.ts is a hand-curated list distilled by a human from a
 * handful of calls in April, keyed by which qualification gap it serves.
 * lib/mined-plays.generated.ts is every move the reps actually made in the
 * window scripts/mine-plays.ts last read, keyed by what the move DOES. The two
 * answer different questions and both belong in front of the model: the
 * curated list says how Magaya asks about budget, the mined list says what
 * these reps do at this stage that a generic template would never suggest.
 *
 * OFF BY DEFAULT. MINED_PLAYS_ENABLED must be exactly "1". Six reps read these
 * briefings and speak the asks aloud to customers, so the mined material ships
 * when a person has read the generated file and turned it on, not because a
 * cron regenerated it.
 *
 * WHAT THIS IS NOT. It is not evidence that these moves win. precededAdvance
 * records that a stage moved afterwards, over a pilot whose entire
 * DealRipe-observed outcome set is 7 closes of which 5 are one hygiene sweep.
 * It orders examples; it does not rank tactics, and no copy anywhere may say
 * a move worked.
 */

import { MINED_PLAYS, type MinedPlay } from "./mined-plays.generated";

/** Same six the miner assigns, in the order they are worth reading. */
const KIND_LABEL: Record<string, string> = {
  named_ask: "asked for a named person",
  internal_language: "handed the customer language for their own people",
  reframe: "reframed the request instead of taking it at face value",
  trade_for_access: "traded something for access",
  preempt_with_evidence: "pre-empted the objection with evidence",
  narrow_scope: "narrowed scope to protect a gate",
};

export function minedPlaysEnabled(): boolean {
  return process.env.MINED_PLAYS_ENABLED === "1";
}

/**
 * A few moves worth putting in front of the rep for THIS call.
 *
 * Ranked, not filtered to nothing: a briefing for a stage nobody has mined yet
 * still gets the general pool rather than an empty block, because the fallback
 * for "no exact match" is a weaker example and never silence.
 */
export function minedPlaysFor(args: {
  /** The deal's own account, excluded so a rep is not shown their own line back. */
  account?: string | null;
  /** SQL1..SQL5 where known. Same-stage moves rank first. */
  stage?: string | null;
  limit?: number;
}): MinedPlay[] {
  const limit = args.limit ?? 3;
  const account = (args.account ?? "").trim().toLowerCase();
  const stage = (args.stage ?? "").trim().toUpperCase();

  const pool = MINED_PLAYS.filter((p) => {
    // The deal's own prior calls are not a playbook for itself. They are
    // already in the briefing as history, and repeating a rep's own sentence
    // back to them as a suggested move reads as a machine with one idea.
    if (account && p.account.trim().toLowerCase() === account) return false;
    // A quote too short to carry a move is a fragment of diarized speech.
    return p.quote.length >= 40 && p.quote.length <= 420;
  });

  const score = (p: MinedPlay): number => {
    let s = 0;
    if (stage && (p.stage ?? "").toUpperCase() === stage) s += 4;
    if (p.precededAdvance) s += 2;
    if (p.nextMeetingInAWeek) s += 1;
    return s;
  };

  // Spread across kinds. Three examples of the same move is one example, and
  // the point of the six kinds is that they are different things to try.
  const byKind = new Map<string, MinedPlay[]>();
  for (const p of [...pool].sort((a, b) => score(b) - score(a))) {
    const list = byKind.get(p.kind) ?? [];
    list.push(p);
    byKind.set(p.kind, list);
  }
  const kinds = [...byKind.keys()].sort(
    (a, b) => score(byKind.get(b)![0]) - score(byKind.get(a)![0]),
  );
  const out: MinedPlay[] = [];
  for (let round = 0; out.length < limit && round < 4; round++) {
    for (const k of kinds) {
      const p = byKind.get(k)![round];
      if (p && out.length < limit) out.push(p);
    }
  }
  return out;
}

/** The prompt block, or "" when there is nothing to say so callers can append freely. */
export function formatMinedPlaysForBriefing(args: {
  account?: string | null;
  stage?: string | null;
  limit?: number;
}): string {
  if (!minedPlaysEnabled()) return "";
  const plays = minedPlaysFor(args);
  if (plays.length === 0) return "";
  const lines = [
    "WHAT THESE REPS ACTUALLY DID ON RECENT CALLS, verbatim from the transcripts. " +
      "Examples of the MOVE, not text to reuse: the wording belongs to another customer's " +
      "conversation and repeating it here would land wrong. Take the shape and rebuild it " +
      "for this customer and these attendees. None of these is known to have worked, so " +
      "never say or imply that one did:",
  ];
  for (const p of plays) {
    const who = p.speaker.split(/\s+/)[0] || p.rep;
    lines.push(`- ${KIND_LABEL[p.kind] ?? p.kind}. ${who}: "${p.quote}"  (${p.doing})`);
  }
  return lines.join("\n");
}
