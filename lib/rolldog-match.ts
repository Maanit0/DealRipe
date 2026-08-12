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
 *   - Rolldog answered and had nothing                                 -> "none".
 *   - We could not ask Rolldog                                    -> "unavailable".
 *
 * "confirmed" maps to the rolldog_link_confidence value that writeBackDealToRolldog
 * treats as authorized; nothing else ever writes.
 *
 * TWO THINGS THIS GOT WRONG, both fixed on 2026-08-11.
 *
 * A failed search used to `catch { return { status: "none" } }`, so a transient
 * Rolldog error was indistinguishable from Rolldog confirming the customer does
 * not exist. A deal could be permanently classified as a brand new prospect
 * because one request timed out, and nothing anywhere would say so. That is the
 * exact failure this codebase keeps paying for, and it is why "unavailable"
 * exists as a separate status that callers must handle.
 *
 * And it searched the account slug once. Deal slugs are derived from email
 * domains, so "Mollaxpanama" never finds "MOLLAX PANAMA S.A." and "Natforwarding"
 * never finds "National Forwarding Co". It now tries the slug, the domain root,
 * and progressively shorter prefixes, because Rolldog's filter[search] matches
 * substrings and a shorter query is a wider net.
 */

import { accountFromSubject, isFreeMailDomain } from "./pilot-config";
import { searchOpportunities, type OppSummary } from "./rolldog";

export type MatchResult =
  | { status: "confirmed"; opp: OppSummary; queries: string[] }
  | { status: "review"; candidates: OppSummary[]; reason: string; queries: string[] }
  | { status: "none"; queries: string[] }
  /** We never got an answer. NOT evidence that the customer is absent. */
  | { status: "unavailable"; reason: string; queries: string[] };

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Shortest query worth sending. Below this the search returns half of Rolldog. */
const MIN_QUERY = 5;

/**
 * The search terms worth trying for one deal, widest-useful first.
 *
 * Prefixes matter because the account name in Rolldog is usually longer than
 * our slug ("MOLLAX PANAMA S.A." vs "Mollaxpanama"), and a substring search on
 * the full slug fails while "mollax" succeeds.
 */
export function searchVariants(args: {
  account: string;
  domain?: string | null;
  /** The calendar subject. Often the ONLY usable identifier, because a customer
   *  on gmail has no domain worth searching and the deal slug is then derived
   *  from a person rather than a company. */
  meetingSubject?: string | null;
}): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    const t = (s ?? "").trim();
    if (t.length >= MIN_QUERY && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };

  const account = (args.account ?? "").trim();
  push(account);

  // The company name a rep typed into the invite. Tried early because it is
  // written by a human who knows who they are meeting, which beats a slug
  // derived from an email address.
  push(accountFromSubject(args.meetingSubject));

  // The domain root is often the real trading name, and it is what the deal was
  // keyed on in the first place. Free mail tells us nothing about the company,
  // which is exactly when the subject above is doing all the work.
  const domain = (args.domain ?? "").trim().toLowerCase();
  if (domain && !isFreeMailDomain(domain)) {
    push(domain.split(".")[0]);
  }

  // Individual words, longest first.
  //
  // Prefixes of the whole string are useless for a multi-word name, because
  // they keep the space: "Nat Forwarding" yields "Nat Forwar", "Nat Forw",
  // "Nat Fo", none of which is a substring of "National Forwarding Co". This
  // was reported as "both CRMs answered and had nothing" on 2026-08-11 when
  // what had actually happened was four queries that could not have matched.
  const words = [...account.split(/[^A-Za-z0-9]+/), ...(accountFromSubject(args.meetingSubject) ?? "").split(/[^A-Za-z0-9]+/)]
    .filter((w) => w.length >= MIN_QUERY)
    .sort((a, b) => b.length - a.length);
  for (const w of words) push(w);

  // Progressively shorter prefixes, which are what works for a single-token
  // slug like "Mollaxpanama" where there are no word boundaries to split on.
  for (const len of [10, 8, 6]) {
    if (account.length > len) push(account.slice(0, len));
  }

  return out;
}

export async function matchDealToOpportunity(args: {
  account: string;
  externalId?: string | null;
  domain?: string | null;
  meetingSubject?: string | null;
}): Promise<MatchResult> {
  const queries = searchVariants({
    account: args.account,
    domain: args.domain,
    meetingSubject: args.meetingSubject,
  });
  if (queries.length === 0) return { status: "none", queries };

  // Collect across every variant, deduped by opportunity id. One query failing
  // is tolerable; every query failing means we learned nothing and must say so.
  const byId = new Map<string, OppSummary>();
  const failures: string[] = [];
  for (const q of queries) {
    try {
      for (const c of await searchOpportunities(q)) {
        if (!byId.has(c.id)) byId.set(c.id, c);
      }
    } catch (err) {
      failures.push(`${q}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length === queries.length) {
    return {
      status: "unavailable",
      reason: `every Rolldog search failed (${failures[0]})`,
      queries,
    };
  }

  const live = [...byId.values()].filter((c) => !c.archived);
  if (live.length === 0) {
    // Rolldog answered for at least one query and had nothing. A partial
    // failure still muddies that, so say which it was.
    return failures.length > 0
      ? { status: "unavailable", reason: `${failures.length} of ${queries.length} searches failed, so "no match" is not trustworthy`, queries }
      : { status: "none", queries };
  }

  const target = normalizeName(args.account);
  const exact = live.filter(
    (c) => normalizeName(c.accountName) === target || normalizeName(c.name) === target,
  );

  if (exact.length === 1) return { status: "confirmed", opp: exact[0], queries };
  if (exact.length > 1) {
    return { status: "review", candidates: exact, reason: `${exact.length} exact-name matches`, queries };
  }
  return {
    status: "review",
    candidates: live.slice(0, 8),
    reason: "no exact name match, fuzzy candidates only",
    queries,
  };
}
