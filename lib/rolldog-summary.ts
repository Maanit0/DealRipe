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
  /**
   * Rolldog's numeric stage id, which is the only reliable handle on the one
   * stage whose NAME carries no number. See stageKeyFromSummary below.
   */
  stageId: number | null;
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
    stageId: num(core["stage"]),
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
 * Rolldog stage ids whose NAME cannot be parsed for a stage number.
 *
 * There is exactly one, and lib/stage-gates.ts already had to solve it for the
 * checklist: Magaya's second stage is called "SQL - Develop Opportunity
 * (Qualify)", with no digit anywhere in it, and it is SQL1. That file resolves
 * it positionally and says so; this one was still parsing the name with a
 * regex, so six live deals (Dunavant, Ztransportation, ILS Inc, All Square,
 * Elif Utsukarci, Beyond Pegasus) briefed, snapshotted and scored as deals
 * with no CRM stage at all while the checklist path knew exactly where they
 * were.
 *
 * Keyed on the id rather than the name because the name is the thing that is
 * already wrong, and because the same payload carries a leading space in one
 * checklist item and a typo in another: these strings get tidied.
 *
 * Only the observed id is here. The ids run 200, 202 (SQL2), 204 (SQL3), 208
 * (SQL5), which puts 200 exactly where SQL1 belongs and corroborates
 * stage-gates, and SQL0 sits apart on 773. That arithmetic implies 206 is SQL4
 * and it is deliberately NOT listed: nobody has seen it, its name carries a
 * digit, and the regex below already handles it. Guessing an id here would put
 * a deal in a stage nobody put it in.
 */
const STAGE_ID_TO_KEY: Readonly<Record<number, string>> = Object.freeze({
  200: "SQL1",
});

/**
 * Parse a summary's Rolldog stage into the framework stage key ("SQL3").
 *
 * Null means the stage could not be resolved, which on this pilot is usually
 * an opportunity with no stage set at all: Rolldog returns a null stage-name
 * and a stage of 0 or -1, and nine linked deals are in that state. That is a
 * fact about their CRM, not a parse failure, and it must not be confused with
 * SQL0, which is a real stage carrying id 773.
 */
export function stageKeyFromSummary(s: RolldogSummary | null): string | null {
  if (!s) return null;
  // The name first: it is what a human reads, and every numbered stage carries
  // its number there, except the one that does not.
  const byName = stageKeyFromName(s.stageName);
  if (byName) return byName;
  if (s.stageId !== null && s.stageId in STAGE_ID_TO_KEY) {
    return STAGE_ID_TO_KEY[s.stageId];
  }
  return null;
}

/**
 * The same resolution from a stage NAME alone, for a caller that has no
 * Rolldog summary.
 *
 * Salesforce carries the same stage names as Rolldog and no stage id, so
 * anything reading a SalesforceSnapshot needs this and only this. Exported and
 * shared rather than re-derived, because the one case that matters is exactly
 * the case a fresh regex gets wrong: "SQL - Develop Opportunity (Qualify)"
 * carries no digit and IS SQL1, and reading it as null once already briefed and
 * scored six live deals as having no CRM stage.
 *
 * Returns null for a name that resolves to nothing, which is a real state on
 * this pilot and must never be confused with SQL0.
 */
export function stageKeyFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const m = name.match(/SQL\s*(\d)/i);
  if (m) return `SQL${m[1]}`;
  // The digitless stage. Matched on its own words rather than on "anything
  // starting SQL", so a future unnumbered stage does not silently inherit SQL1.
  if (/develop\s+opportunity/i.test(name) || /\bqualify\b/i.test(name)) return "SQL1";
  return null;
}

/** Ordinal for a framework stage key, for comparing how far along a deal is.
 *  Null in, null out: an unresolved stage is not stage zero. */
export function stageRank(key: string | null): number | null {
  if (!key) return null;
  const m = key.match(/^SQL(\d)$/i);
  return m ? Number(m[1]) : null;
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
