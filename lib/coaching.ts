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
  // Deliberately by KIND rather than a single rate. "You follow through on the
  // questions and not on the booking" is actionable; "your follow-through is
  // 22%" is a score, and a score is something a rep argues with rather than
  // acts on. The measured split says these are genuinely different behaviours:
  // asks run about 19% and end commitments about 23%, and the deals that stall
  // are the ones missing the second.
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
      for (const [kind, e] of byKind) {
        const n = e.yes + e.no;
        if (n < MIN_PATTERN) continue;
        lines.push(
          `THIS REP, last ${REP_LOOKBACK_DAYS} days: ${e.yes} of ${n} ${
            KIND_LABEL[kind] ?? kind
          }s DealRipe asked for were actually done on the call.`,
        );
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
    "COACHING FROM PRIOR CALLS. What DealRipe asked this rep to do before, and what the transcript shows happened.",
    "Only rows the scorer DECIDED appear here. A call with no transcript produces no row, so absence here is never evidence the rep skipped something.",
    ...read.lines.map((l) => `- ${l}`),
  ].join("\n");
}
