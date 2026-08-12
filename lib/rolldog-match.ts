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
import {
  opportunitiesForAccount,
  searchAccounts,
  searchOpportunities,
  type AccountSummary,
  type OppSummary,
} from "./rolldog";

export type MatchResult =
  | { status: "confirmed"; opp: OppSummary; queries: string[] }
  | { status: "review"; candidates: OppSummary[]; reason: string; queries: string[] }
  /** Rolldog answered and has no opportunity. `accountOnly` means the customer
   *  IS there as an account with no opportunity yet, which before a discovery
   *  call is Magaya's normal state rather than a miss. */
  | { status: "none"; queries: string[]; accountOnly?: { ids: string[]; names: string } }
  /** We never got an answer. NOT evidence that the customer is absent. */
  | { status: "unavailable"; reason: string; queries: string[] };

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Normalized, with the corporate suffix removed.
 *
 * "NETA Logistics Ltd." and "Neta Logistics" are the same company, and the
 * plain normalizer calls them different because one ends in "ltd". That alone
 * pushed several deals into manual review on 2026-08-11 while the correct
 * opportunity sat in the candidate list.
 */
const SUFFIXES = /(inc|llc|ltd|limited|corp|corporation|co|sa|sas|spa|srl|bv|gmbh|ag|plc|lp|llp|pte|pty)$/;
function normalizeCompany(s: string): string {
  let n = normalizeName(s);
  // Twice, because "Something Logistics Inc. LLC" and similar do occur.
  for (let i = 0; i < 2; i++) n = n.replace(SUFFIXES, "");
  return n;
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
  /** Names from another system, searched early because they are usually the
   *  company's real name rather than something derived from an address. */
  knownNames?: ReadonlyArray<string | null | undefined>;
}): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    const t = (s ?? "").trim();
    if (t.length >= MIN_QUERY && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };

  const account = (args.account ?? "").trim();
  push(account);

  // A name another system already verified, which outranks anything we derive.
  for (const n of args.knownNames ?? []) push(n);

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

/**
 * The one opportunity that is unambiguously the live deal, or null.
 *
 * Owned by the rep on the call, sitting in a real stage, and the newest of
 * those. All three must agree and the winner must be alone. Shared by the
 * domain path and the name path so they cannot drift apart.
 */
function pickCurrent(candidates: OppSummary[], repOwnerId?: string | number | null): OppSummary | null {
  if (!repOwnerId) return null;
  const owned = candidates.filter((c) => String(c.owner ?? "") === String(repOwnerId));
  const active = owned.filter((c) => (c.stageName ?? "").trim().length > 0);
  if (active.length !== 1) return null;
  const winner = active[0];
  const newer = owned.filter(
    (c) => c.id !== winner.id && Date.parse(c.createdAt ?? "") > Date.parse(winner.createdAt ?? ""),
  );
  return newer.length === 0 ? winner : null;
}

/** Most likely first, so a human reading the list starts at the right end. */
function rankCandidates(candidates: OppSummary[], repOwnerId?: string | number | null): OppSummary[] {
  return [...candidates].sort((a, b) => {
    const own = (c: OppSummary) => (repOwnerId && String(c.owner ?? "") === String(repOwnerId) ? 1 : 0);
    const act = (c: OppSummary) => ((c.stageName ?? "").trim() ? 1 : 0);
    return (
      own(b) - own(a) ||
      act(b) - act(a) ||
      (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0)
    );
  });
}

/** Bare domain from a website field, which Rolldog stores inconsistently:
 *  "miraclegroups.com", "http://www.logisticsplus.com", "https://logisticspl.us". */
export function websiteDomain(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  const stripped = s
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0];
  return stripped.includes(".") ? stripped : null;
}

/**
 * Find the opportunity via the customer's ACCOUNT, matched on domain.
 *
 * Rolldog's filter[search] is name-only: searching "miraclegroups.com" returns
 * nothing even though an account carries exactly that website. So domain cannot
 * drive the search. It can drive the CHOICE, which is where the difficulty
 * actually is.
 *
 * "Miracle" returns seven accounts and exactly two carry miraclegroups.com.
 * "Logistics Plus" returns twelve and three carry a website worth testing. Name
 * matching was never going to separate those, and a domain equality test does it
 * outright. Once the account is known, its opportunities are listed directly and
 * no name is compared again.
 *
 * Returns null when the domain is absent, free mail, or no account's website
 * matches, so the caller falls through to the existing name search rather than
 * losing anything that used to work.
 */
async function matchViaAccountDomain(args: {
  domain: string;
  queries: string[];
  repOwnerId?: string | number | null;
}): Promise<{ accounts: AccountSummary[]; opps: OppSummary[] } | null> {
  const target = websiteDomain(args.domain);
  if (!target || isFreeMailDomain(target)) return null;

  const byId = new Map<string, AccountSummary>();
  for (const q of args.queries) {
    try {
      for (const a of await searchAccounts(q)) if (!byId.has(a.id)) byId.set(a.id, a);
    } catch {
      // One failed query is survivable here: this is an enrichment path and the
      // name search still runs behind it.
    }
  }
  const hits = [...byId.values()].filter((a) => websiteDomain(a.website) === target);
  if (hits.length === 0) return null;

  const opps: OppSummary[] = [];
  for (const a of hits) {
    try {
      opps.push(...(await opportunitiesForAccount(a.id)));
    } catch {
      /* keep whatever else resolved */
    }
  }
  return { accounts: hits, opps: opps.filter((o) => !o.archived) };
}

export async function matchDealToOpportunity(args: {
  account: string;
  externalId?: string | null;
  domain?: string | null;
  meetingSubject?: string | null;
  /**
   * Other names we have good reason to believe identify this customer, above
   * all the Salesforce account name once it has been resolved by domain.
   *
   * The deal slug is derived from an email address, so it is frequently not the
   * company's name at all: "Netalogistics" against "NETA Logistics Ltd.",
   * "Successchb" against "Success System Services INC.". Searching found those
   * opportunities and the exactness test then discarded them, because it only
   * compared candidates to the slug. A domain-verified Salesforce name is
   * stronger evidence of who this is than anything we can derive ourselves.
   */
  knownNames?: ReadonlyArray<string | null | undefined>;
  /** The Rolldog user id of the rep on this call, from REP_UID. Used only to
   *  break ties between identically named opportunities. */
  repOwnerId?: string | number | null;
}): Promise<MatchResult> {
  const queries = searchVariants({
    account: args.account,
    domain: args.domain,
    meetingSubject: args.meetingSubject,
    knownNames: args.knownNames,
  });
  if (queries.length === 0) return { status: "none", queries };

  // Domain first, but as EVIDENCE rather than as a shortcut.
  //
  // The first version returned as soon as a domain-matched account held a single
  // live opportunity, and the benchmark caught it immediately: Cargo Services
  // Group has six opportunities on that name, and the domain path confirmed a
  // 2023 record while the correct link is the 2025 one that is actually in a
  // stage. One opportunity on AN account is not the same as the current
  // opportunity for THIS deal.
  //
  // It also returned early when the account had no opportunities at all, which
  // skipped the name search entirely and turned working matches into "no
  // candidates". So the domain path now only contributes candidates, and the
  // same currency rules decide, once, over everything found.
  let domainOpps: OppSummary[] = [];
  let domainAccounts: AccountSummary[] = [];
  if (args.domain) {
    const viaDomain = await matchViaAccountDomain({
      domain: args.domain,
      queries,
      repOwnerId: args.repOwnerId,
    });
    if (viaDomain) {
      domainOpps = viaDomain.opps;
      domainAccounts = viaDomain.accounts;
    }
  }

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

  // Fold in anything the domain-matched accounts hold. Those are reached by
  // account id rather than by name, so they can include opportunities no name
  // search would ever return.
  for (const o of domainOpps) if (!byId.has(o.id)) byId.set(o.id, o);

  const live = [...byId.values()].filter((c) => !c.archived);
  if (live.length === 0) {
    // Rolldog answered for at least one query and had nothing. A partial
    // failure still muddies that, so say which it was.
    if (failures.length > 0) {
      return {
        status: "unavailable",
        reason: `${failures.length} of ${queries.length} searches failed, so "no match" is not trustworthy`,
        queries,
      };
    }
    // The customer IS in Rolldog as an account with no opportunity on it, which
    // before a discovery call is Magaya's normal state. Saying only "no
    // candidates" would send someone hunting for a record that should not exist
    // yet, and would have someone email the rep about it.
    return domainAccounts.length > 0
      ? {
          status: "none",
          queries,
          accountOnly: {
            ids: domainAccounts.map((a) => a.id),
            names: domainAccounts.map((a) => a.name).join(", "),
          },
        }
      : { status: "none", queries };
  }

  // Exact against every name we believe identifies this customer, with the
  // corporate suffix ignored. One target used to mean the deal slug only.
  const targets = new Set(
    [args.account, accountFromSubject(args.meetingSubject), ...(args.knownNames ?? [])]
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map(normalizeCompany)
      .filter((s) => s.length >= 4),
  );
  const exact = live.filter(
    (c) => targets.has(normalizeCompany(c.accountName)) || targets.has(normalizeCompany(c.name)),
  );

  if (exact.length === 1) return { status: "confirmed", opp: exact[0], queries };
  if (exact.length > 1) {
    // Magaya carries many opportunities per account: 20 named SEABOARD MARINE
    // LTD, 16 CBX Global JAX, 10 Leschaco. Name matching cannot resolve that
    // and never will, so the tie is broken on the three things that actually
    // distinguish a live deal from years of history:
    //
    //   owner    the rep who is on this call owns it
    //   stage    it sits in a real SQL stage rather than blank or archived
    //   recency  it is the newest of those
    //
    // All three must agree, and the winner must be alone, or this stays a
    // human's decision. Netalogistics is the case this is for: two candidates
    // owned by the rep, one created the morning of the call and sitting in
    // SQL 0, the other a year old with no stage.
    const picked = pickCurrent(exact, args.repOwnerId);
    if (picked) return { status: "confirmed", opp: picked, queries };
    return {
      status: "review",
      candidates: rankCandidates(exact, args.repOwnerId).slice(0, 8),
      reason: `${exact.length} opportunities on this account, none uniquely current`,
      queries,
    };
  }
  return {
    status: "review",
    candidates: live.slice(0, 8),
    reason: "no exact name match, fuzzy candidates only",
    queries,
  };
}
