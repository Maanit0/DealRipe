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
  return {
    dealSize: num(core["deal-size"]),
    score: str(core["score"]),
    qRank: str(core["q-rank"]),
    forecastCategory: str(core["forecast-category"]),
    closeDate: str(core["close-date"]),
    stageName: str(core["stage-name"]),
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

/** Read one opportunity's summary. Best-effort: returns null on any failure. */
export async function getRolldogSummary(
  opportunityId: string,
): Promise<RolldogSummary | null> {
  try {
    const core = await readOpportunity(opportunityId, READ_FIELDS as unknown as string[]);
    return summaryFromCore(core);
  } catch {
    return null;
  }
}
