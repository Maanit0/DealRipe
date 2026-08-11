/**
 * Lightweight Rolldog opportunity summary for the UI: the scalar signals a rep
 * or CRO glances at (deal size, Rolldog's own quality score and q-rank,
 * forecast category, stage). One core read per opportunity, best-effort.
 */

import { readOpportunity } from "./rolldog";

const READ_FIELDS = ["amount", "opportunity_score", "stage", "close_date"] as const;

export type RolldogSummary = {
  dealSize: number | null;
  score: string | null;
  qRank: string | null;
  forecastCategory: string | null;
  closeDate: string | null;
  stageName: string | null;
  // Won/lost + removed. status carries the open/won/lost state; statusReason the
  // loss reason Mark cares about; archived flags a dropped opportunity.
  status: string | null;
  statusReason: string | null;
  archived: boolean;
  // Net-new vs renewal, for Mark's triage (he ignores renewals). Rolldog carries
  // both a deal-kind and an opportunity-type-name; either can carry "renewal".
  dealKind: string | null;
  opportunityType: string | null;
  // The account's real name from Rolldog, so we don't hardcode display names.
  accountName: string | null;
  nextStep: string | null;
  percentage: number | null;
  // CRM process timestamps (ISO). These are rep/CRM-driven, not written by
  // DealRipe (except updatedAt, which any write bumps — see repLastActivityIso).
  createdAt: string | null;
  currentStageDate: string | null;
  updatedAt: string | null;
};

/** Parse a Rolldog opportunity core object into the summary shape. */
export function summaryFromCore(core: Record<string, unknown>): RolldogSummary {
  const num = (v: unknown): number | null =>
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v : typeof v === "number" ? String(v) : null;
  const bool = (v: unknown): boolean => v === true || v === "true" || v === 1 || v === "1";
  return {
    dealSize: num(core["deal-size"]),
    score: str(core["score"]),
    qRank: str(core["q-rank"]),
    forecastCategory: str(core["forecast-category"]),
    closeDate: str(core["close-date"]),
    stageName: str(core["stage-name"]),
    status: str(core["status"]),
    statusReason: str(core["status-reason"]),
    archived: bool(core["archived"]),
    dealKind: str(core["deal-kind"]),
    opportunityType: str(core["opportunity-type-name"]),
    accountName: str(core["account-name"]),
    nextStep: str(core["next-step"]),
    percentage: num(core["percentage"]),
    createdAt: str(core["created-at"]),
    currentStageDate: str(core["current-stage-date"]),
    updatedAt: str(core["updated-at"]),
  };
}

/** Whole days between an ISO timestamp and now. Null if unparseable/absent. */
export function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

/**
 * The rep's true last activity on the CRM record, attributed away from
 * DealRipe's own write-backs. The opportunity's updated-at is bumped by ANY
 * write, including ours, so it alone cannot mean "rep last touched".
 *
 *   - We never wrote back            -> live updated-at is pure rep activity.
 *   - Live updated-at is newer than  -> the rep (someone not us) touched it
 *     our last write-back               after our write; that's rep activity.
 *   - Otherwise our write is latest  -> fall back to the day-0 baseline
 *                                        updated-at (rep's pilot-start touch).
 *
 * Conservative by design: when in doubt it reports the older, rep-attributable
 * timestamp, so it never overstates how fresh the rep has kept the record.
 */
export function repLastActivityIso(args: {
  liveUpdatedAt: string | null;
  dealripeLastWriteback: string | null;
  baselineUpdatedAt: string | null;
}): string | null {
  const { liveUpdatedAt, dealripeLastWriteback, baselineUpdatedAt } = args;
  if (!dealripeLastWriteback) return liveUpdatedAt;
  const TOLERANCE_MS = 60_000;
  if (
    liveUpdatedAt &&
    new Date(liveUpdatedAt).getTime() >
      new Date(dealripeLastWriteback).getTime() + TOLERANCE_MS
  ) {
    return liveUpdatedAt;
  }
  return baselineUpdatedAt ?? null;
}

/**
 * Parse a summary's Rolldog stage-name ("SQL 3 - Proposal Validation") into the
 * framework stage key ("SQL3"). Null if the name has no recognizable stage.
 */
export function stageKeyFromSummary(s: RolldogSummary | null): string | null {
  if (!s || !s.stageName) return null;
  const m = s.stageName.match(/SQL\s*(\d)/i);
  return m ? `SQL${m[1]}` : null;
}

/**
 * A summary read, saying which of "read it" and "could not read it" happened.
 *
 * There is no third case. getOpportunityCore throws on every non-ok status,
 * 404 included, so an opportunity that does not exist arrives here as an error
 * and not as an empty body. That means a null from getRolldogSummary has only
 * ever meant "the read failed", and every caller that treated it as "this deal
 * has no CRM stage" was reading a failure as a fact. The stage it silently
 * dropped is the one that decides whether a briefing opens as first-touch
 * discovery or as a proposal follow-up.
 */
export type RolldogSummaryRead =
  | { status: "ok"; summary: RolldogSummary }
  /** The read threw. We know nothing about this opportunity, including whether it exists. */
  | { status: "unavailable"; summary: null; error: string };

/**
 * Read one opportunity's summary, distinguishing a failure from an answer.
 *
 * Prefer this over getRolldogSummary anywhere the absence of a summary changes
 * what a rep or a customer's CRM sees.
 */
export async function readRolldogSummary(
  opportunityId: string,
): Promise<RolldogSummaryRead> {
  try {
    const core = await readOpportunity(opportunityId, READ_FIELDS as unknown as string[]);
    return { status: "ok", summary: summaryFromCore(core) };
  } catch (err) {
    return {
      status: "unavailable",
      summary: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read one opportunity's summary. Best-effort.
 *
 * Null means the read FAILED, not that the opportunity is empty or missing.
 * Kept for the display surfaces (the pipeline page, the deal page, the digest)
 * where a thinner card is the right outcome either way; the failure is logged
 * rather than returned so it stops being invisible. Anywhere the difference
 * matters, call readRolldogSummary instead.
 */
export async function getRolldogSummary(
  opportunityId: string,
): Promise<RolldogSummary | null> {
  const read = await readRolldogSummary(opportunityId);
  if (read.status === "ok") return read.summary;
  console.warn(
    `[rolldog-summary] read failed for opportunity ${opportunityId}, callers will see no CRM summary for it: ${read.error}`,
  );
  return null;
}
