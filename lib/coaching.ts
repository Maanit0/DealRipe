/**
 * What DealRipe told this rep to do before, and whether they did it.
 *
 * The prescription ledger has been accumulating since it shipped and nothing
 * has ever read it back to the person it is about. 494 rows: 45 asks made and
 * 186 not made, 18 end commitments secured and 59 not, and 186 rows of "we
 * asked for this and it did not happen" is the most specific coaching material
 * in the product, sitting unused while the briefing tells every rep the same
 * things it told them last week.
 *
 * TWO HALVES, AND THEY ARE DIFFERENT CLAIMS.
 *
 * The DEAL half is a fact about this deal: "the briefing asked you to get the
 * signing path on August 11 and it is still open." One row is enough, because
 * it is not a judgement about the rep, it is the state of a conversation.
 *
 * The REP half is a pattern across their book: "you close on the question and
 * leave without the meeting booked." That IS a judgement, so it needs a
 * population before it is stated at all, and MIN_PATTERN exists to stop a rep
 * being told who they are on the strength of two rows.
 *
 * 'unknown' NEVER BECOMES 'no'. A call with no transcript cannot say whether an
 * ask was made, and 139 of the 494 rows are exactly that. Telling a rep they
 * skipped a question they may well have asked is the fastest way to make them
 * stop reading, and it is this codebase's signature failure pointed at a person
 * instead of a CRM.
 */

import { supabaseAdmin } from "./supabase";

/**
 * How many decided rows before a rep-level pattern may be named.
 *
 * Six, which is roughly two calls' worth. Below that the honest statement is
 * about the deal in front of them, not about how they sell.
 */
const MIN_PATTERN = 6;

/** Prescriptions from calls this recent are the ones worth raising. */
const DEAL_LOOKBACK_DAYS = 90;
const REP_LOOKBACK_DAYS = 60;

/**
 * Above this, the rep already does it and the briefing says nothing.
 *
 * Half. Not a target, just the line above which a habit is not the thing most
 * worth spending the page on.
 */
const EMPHASIS_THRESHOLD = 0.5;

/**
 * What a weak pattern turns into, as an instruction about THIS call.
 *
 * Written as the move rather than the deficiency, because these reach a rep
 * and the difference between "you rarely book the next meeting" and "the
 * booking sentence is the highest-value line on this page" is the difference
 * between a tool they resent and one they use.
 */
const EMPHASIS: Record<string, string> = {
  end_commitment:
    "the booking sentence is the highest-value line on this page. Deals on this book agree a next step out loud and it never reaches a calendar, so treat getting a date said out loud as the outcome of this call.",
  question:
    "the asks below are the whole point of this page. Keep them few, short and specific enough to be said verbatim while the customer is talking.",
};

type PrescriptionRow = {
  deal_id: string | null;
  text: string | null;
  kind: string | null;
  followed: string | null;
  followed_evidence: string | null;
  scored_at: string | null;
  issued_at: string | null;
  outcome_next_meeting: string | null;
};

export type CoachingRead =
  /** Material to coach from, rendered for the prompt. */
  | { status: "present"; lines: string[] }
  /** The ledger was read and holds nothing decided for this deal or rep. */
  | { status: "nothing_decided" }
  /** This deal has no prior prescriptions at all, which is normal on a first call. */
  | { status: "no_history" }
  /** The read failed. Never rendered as the rep having done nothing. */
  | { status: "unavailable"; error: string };

const KIND_LABEL: Record<string, string> = {
  question: "ask",
  end_commitment: "end commitment",
  next_step: "next step",
  avoid: "thing to avoid",
};

function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
}

/**
 * Coaching context for one upcoming call.
 *
 * Returns rendered lines for the prompt rather than a verdict, for the same
 * reason the flag engine renders lines: the model is better at applying a fact
 * to today's call than at deciding which fact matters, and a verdict computed
 * here would have to be re-explained there anyway.
 */
export async function buildCoachingContext(args: {
  tenantId: string;
  dealId: string;
  /** The rep's mailbox, for the cross-deal pattern. Omitted skips that half. */
  repEmail?: string | null;
}): Promise<CoachingRead> {
  const db = supabaseAdmin();

  const dealSince = new Date(Date.now() - DEAL_LOOKBACK_DAYS * 86_400_000).toISOString();
  const dealRes = await db
    .from("prescribed_actions")
    .select("deal_id, text, kind, followed, followed_evidence, scored_at, issued_at, outcome_next_meeting")
    .eq("tenant_id", args.tenantId)
    .eq("deal_id", args.dealId)
    .gte("issued_at", dealSince)
    .order("issued_at", { ascending: false });
  if (dealRes.error) {
    return { status: "unavailable", error: `prescribed_actions read failed: ${dealRes.error.message}` };
  }
  const onDeal = (dealRes.data ?? []) as PrescriptionRow[];

  // SCORED ONLY. An unscored row is one the scorer has not reached yet, which
  // is a different thing from a rep who did not act, and the column that says
  // which is scored_at.
  const decidedOnDeal = onDeal.filter((r) => r.scored_at && (r.followed === "yes" || r.followed === "no"));

  const lines: string[] = [];

  // ---- This deal ----
  const missed = decidedOnDeal.filter((r) => r.followed === "no").slice(0, 3);
  const done = decidedOnDeal.filter((r) => r.followed === "yes").slice(0, 2);

  for (const r of missed) {
    const d = daysAgo(r.issued_at);
    lines.push(
      `NOT DONE (${KIND_LABEL[r.kind ?? ""] ?? "action"}${d === null ? "" : `, ${d} days ago`}): ${r.text ?? ""}`.trim(),
    );
  }
  for (const r of done) {
    const d = daysAgo(r.issued_at);
    const outcome =
      r.outcome_next_meeting === "yes"
        ? " and a next meeting followed"
        : r.outcome_next_meeting === "no"
          ? " but no meeting followed"
          : "";
    lines.push(
      `DONE (${KIND_LABEL[r.kind ?? ""] ?? "action"}${d === null ? "" : `, ${d} days ago`})${outcome}: ${r.text ?? ""}`.trim(),
    );
  }

  // ---- This rep, across their book ----
  //
  // NEVER AS A NUMBER, AND NEVER QUOTED TO THE REP.
  //
  // The first version rendered "2 of 15 asks DealRipe asked for were done on
  // the call" and the model dutifully put it in the red SIGNAL box: a rep
  // scorecard, in the most alarming container on the page, in an email that
  // rep reads two minutes before talking to a customer. Maanit, 2026-08-25:
  // "that looks very bad. It should be practical coaching that is useful for
  // them, not being mean to them or exposing gaps. Those are sales leader
  // flags, and they should go to a sales leader, not to the rep."
  //
  // So the pattern still decides WHAT to emphasise and never appears as a
  // fact. The counts stay available to the leader-facing paths, which is where
  // a follow-through rate belongs and where it is already reported.
  if (args.repEmail) {
    const repSince = new Date(Date.now() - REP_LOOKBACK_DAYS * 86_400_000).toISOString();
    const deals = await db
      .from("deals")
      .select("id")
      .eq("tenant_id", args.tenantId)
      .eq("rep_email", args.repEmail);
    if (deals.error) {
      return { status: "unavailable", error: `deals read failed: ${deals.error.message}` };
    }
    const dealIds = ((deals.data ?? []) as Array<{ id: string }>).map((d) => d.id);
    if (dealIds.length > 0) {
      const repRes = await db
        .from("prescribed_actions")
        .select("deal_id, text, kind, followed, followed_evidence, scored_at, issued_at, outcome_next_meeting")
        .eq("tenant_id", args.tenantId)
        .in("deal_id", dealIds)
        .gte("issued_at", repSince);
      if (repRes.error) {
        return { status: "unavailable", error: `prescribed_actions read failed: ${repRes.error.message}` };
      }
      const decided = ((repRes.data ?? []) as PrescriptionRow[]).filter(
        (r) => r.scored_at && (r.followed === "yes" || r.followed === "no"),
      );
      const byKind = new Map<string, { yes: number; no: number }>();
      for (const r of decided) {
        const k = r.kind ?? "action";
        const e = byKind.get(k) ?? { yes: 0, no: 0 };
        if (r.followed === "yes") e.yes++;
        else e.no++;
        byKind.set(k, e);
      }
      for (const [kind, hint] of Object.entries(EMPHASIS)) {
        const e = byKind.get(kind);
        if (!e) continue;
        const n = e.yes + e.no;
        // Only a weak pattern earns emphasis, and only on a real population.
        // A rep who already does this well needs no line: praise from a tool
        // is noise, and a briefing that congratulates you is one you skim.
        if (n < MIN_PATTERN || e.yes / n >= EMPHASIS_THRESHOLD) continue;
        lines.push(`EMPHASIS: ${hint}`);
      }
    }
  }

  if (lines.length === 0) {
    return onDeal.length === 0 ? { status: "no_history" } : { status: "nothing_decided" };
  }
  return { status: "present", lines };
}

/**
 * The prompt block. Absent statuses render nothing at all rather than a line
 * saying we have nothing, since a briefing that reports on its own record is
 * the thing rule 15a exists to stop.
 */
export function coachingLinesForBriefing(read: CoachingRead): string | null {
  if (read.status !== "present") return null;
  return [
    "COACHING FROM PRIOR CALLS. What DealRipe asked for on earlier calls for THIS DEAL, and what the transcript shows happened.",
    "Only rows the scorer DECIDED appear here. A call with no transcript produces no row, so absence here is never evidence the rep skipped something.",
    "NEVER QUOTE ANY OF THIS AS A COUNT, A RATE OR A TALLY, and never write a sentence about the rep's record. An EMPHASIS line is an instruction to YOU about which part of the page matters most on this call; it is never repeated to the rep in any form. Turn everything here into a specific move on THIS call.",
    ...read.lines.map((l) => `- ${l}`),
  ].join("\n");
}
