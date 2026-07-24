/**
 * Matches a DealRipe deal to a live Rolldog opportunity, for auto-linking deals
 * that started in Salesforce-only (discovery) and later get a Rolldog opp.
 *
 * The rule is deliberately conservative, because writing captured data to the
 * wrong customer's opportunity is the one unrecoverable error:
 *   - Exactly one non-archived opportunity whose normalized account-name (or
 *     name) equals the deal's account  -> "confirmed" (safe to auto-link+write).
 *   - Two or more exact matches, or only fuzzy matches                 -> "review"
 *     (surfaced for a human to confirm, never auto-written).
 *   - No candidates at all                                             -> "none".
 *
 * "confirmed" maps to the rolldog_link_confidence value that writeBackDealToRolldog
 * treats as authorized; "review"/"none" never write.
 */

import { searchOpportunities, type OppSummary } from "./rolldog";

export type MatchResult =
  | { status: "confirmed"; opp: OppSummary }
  | { status: "review"; candidates: OppSummary[]; reason: string }
  | { status: "none" };

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export async function matchDealToOpportunity(args: {
  account: string;
  externalId?: string | null;
}): Promise<MatchResult> {
  const q = (args.account ?? "").trim();
  if (!q) return { status: "none" };

  let candidates: OppSummary[];
  try {
    candidates = await searchOpportunities(q);
  } catch {
    return { status: "none" };
  }

  const live = candidates.filter((c) => !c.archived);
  if (live.length === 0) return { status: "none" };

  const target = normalizeName(args.account);
  const exact = live.filter((c) => normalizeName(c.accountName) === target || normalizeName(c.name) === target);

  if (exact.length === 1) return { status: "confirmed", opp: exact[0] };
  if (exact.length > 1) return { status: "review", candidates: exact, reason: `${exact.length} exact-name matches` };
  return { status: "review", candidates: live.slice(0, 5), reason: "no exact name match, fuzzy candidates only" };
}
