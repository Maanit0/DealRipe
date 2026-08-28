/**
 * Salesforce Account context for pre-call briefings.
 *
 * The gap this closes: a rep's discovery call is booked by a BDR, and until the
 * lead converts there is no Rolldog opportunity, so DealRipe has nothing to
 * brief from and produces a thin, generic page. Mark screen-shared where the
 * real context lives: the Sales Development section on the ACCOUNT, plus the
 * contacts. That is what this reads.
 *
 * It matters most for reps with no call history. Juan and Eduardo get good
 * briefings because DealRipe has watched them for weeks. On Aug 10 four reps
 * start with nothing, and this is what stands in until their own history
 * accumulates.
 *
 * READ ONLY. There is no write function in this module. Field enrichment back
 * into Salesforce is a separate, later, preview-first piece of work, because
 * Eduardo and Mark agreed to "overwrite or enrich" without settling which.
 *
 * Field discovery is by LABEL, not by guessed API name. Magaya's org uses
 * labels like "Does lead have a warehouse?" whose API names we cannot infer,
 * and Salesforce omits fields the running user cannot read from describe
 * entirely, so describing once and matching labels also doubles as the
 * permission check.
 */

import { crosswalkSalesforceAccountId } from "./crm-crosswalk";
import { accountFromSubject, isFreeMailDomain } from "./pilot-config";
import { normalizeName } from "./rolldog-match";
import { getSalesforceClient, SalesforceError } from "./salesforce";

const API_VERSION = "v61.0";

/**
 * The Sales Development fields worth putting in front of a rep, by the label
 * shown in Magaya's Salesforce. Order is the order they render in the briefing.
 * Anything not readable by the integration user is silently skipped.
 */
const WANTED_LABELS: ReadonlyArray<string> = [
  "Software Purposes",
  "Business Issues",
  "Compelling Events",
  "Any Other Software",
  "Other Providers Reached Out",
  "Accounting System Used",
  "Number of Users",
  "Annual Company Revenue",
  "Desired Go-Live Date",
  "Less Than 90 Days",
  "Budget Confirmed",
  "Executive Sponsorship",
  "Does lead have a warehouse?",
  "Are they FF/NVOCC/Courier/3PL?",
  "Knows Magaya/ Is A Referral",
  "ACE/AES Filer Code",
  "Special Handling Instructions",
];

export type SalesforceAccountContext = {
  accountId: string;
  accountName: string;
  website: string | null;
  /** Label -> rendered value, only for fields that are readable AND populated. */
  fields: Array<{ label: string; value: string }>;
  contacts: Array<{ name: string; title: string | null; email: string | null }>;
};

// Describe is expensive and the schema does not move during a cron run.
let _fieldMap: Map<string, string> | null = null;
let _fieldMapAt = 0;
const FIELD_MAP_TTL_MS = 30 * 60 * 1000;

/** Reject anything that could break out of a SOQL string literal. */
function soqlSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._\- ]/g, "");
}

/**
 * GET with a short retry on transport failures and rate limits.
 *
 * A batch of these in a loop reliably produced bare "fetch failed" errors,
 * which is undici failing to connect rather than Salesforce answering. Those
 * are transient and a single retry clears them. Retrying matters more than it
 * looks: a failed lookup is indistinguishable from "this company has no
 * Salesforce account", and that difference decides whether a deal gets
 * classified as debris.
 *
 * 4xx other than 429 are not retried; they are real answers.
 */
async function sfGet<T>(path: string, attempt = 0): Promise<T> {
  try {
    // Inside the try on purpose. Token minting is itself a network call, so a
    // mint failure surfaces as the same bare "fetch failed" as a query failure.
    // Leaving it outside meant the retry never covered the more likely cause.
    const { token, instanceUrl } = await getSalesforceClient();
    const res = await fetch(`${instanceUrl}/services/data/${API_VERSION}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        return sfGet<T>(path, attempt + 1);
      }
    }
    if (!res.ok) {
      throw new SalesforceError(res.status, path, await res.text().catch(() => ""));
    }
    return (await res.json()) as T;
  } catch (e) {
    // Transport-level failure, not an HTTP response. Retry; a SalesforceError
    // is a real answer and must propagate.
    if (e instanceof SalesforceError) throw e;
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      return sfGet<T>(path, attempt + 1);
    }
    throw e;
  }
}

/**
 * Label -> API name for the wanted fields, as visible to the integration user.
 * A label missing from this map is either absent from the org or hidden by
 * field-level security; both cases mean "do not query it".
 */
export async function accountFieldMap(): Promise<Map<string, string>> {
  const meta = await accountFieldMeta();
  return new Map([...meta].map(([label, f]) => [label, f.name]));
}

/**
 * Full describe metadata for the wanted fields.
 *
 * Writing needs more than the API name. "Compelling Events" and "Budget
 * Confirmed" are checkboxes, "Desired Go-Live Date" is a date, "Annual Company
 * Revenue" is a picklist with fixed values, and "Software Purposes" is a long
 * text area with a length limit. Sending a sentence to a checkbox is a 400,
 * and sending 40,000 characters to a text area silently truncates or fails.
 * `updateable` also matters: a formula or read-only field looks perfectly
 * writable until the request is rejected.
 */
export type AccountFieldMeta = {
  name: string;
  type: string;
  updateable: boolean;
  length: number | null;
  picklistValues: string[];
};

let _fieldMeta: Map<string, AccountFieldMeta> | null = null;
let _fieldMetaAt = 0;

export async function accountFieldMeta(): Promise<Map<string, AccountFieldMeta>> {
  if (_fieldMeta && Date.now() - _fieldMetaAt < FIELD_MAP_TTL_MS) return _fieldMeta;

  const desc = await sfGet<{
    fields?: Array<{
      name: string;
      label: string;
      type?: string;
      updateable?: boolean;
      length?: number;
      picklistValues?: Array<{ value: string; active?: boolean }>;
    }>;
  }>("/sobjects/Account/describe");
  const visible = desc.fields ?? [];
  const map = new Map<string, AccountFieldMeta>();
  for (const want of WANTED_LABELS) {
    const hit = visible.find((f) => f.label.trim().toLowerCase() === want.trim().toLowerCase());
    if (!hit) continue;
    map.set(want, {
      name: hit.name,
      type: hit.type ?? "string",
      updateable: hit.updateable !== false,
      length: typeof hit.length === "number" && hit.length > 0 ? hit.length : null,
      picklistValues: (hit.picklistValues ?? []).filter((p) => p.active !== false).map((p) => p.value),
    });
  }
  _fieldMeta = map;
  _fieldMetaAt = Date.now();
  // Keep the older cache coherent so both accessors agree within a run.
  _fieldMap = new Map([...map].map(([label, f]) => [label, f.name]));
  _fieldMapAt = _fieldMetaAt;
  return map;
}

function render(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/**
 * Resolve the account id for a customer domain.
 *
 * Contacts first, Website second. Website is blank on most Magaya accounts, so
 * matching on it alone resolved 2 of 13 live domains; contacts carry real email
 * addresses and are the join that actually works. Where several duplicate
 * account records share a domain, the one holding most of the contacts wins,
 * because Salesforce orgs of this age always carry some duplicates and refusing
 * to brief on all of them helps nobody.
 */

/**
 * Choose between accounts that all match the same customer.
 *
 * Magaya's org carries duplicate records for the same company, and the old ones
 * are not empty: they hold years of accumulated contacts. Dunavant's 2021
 * Closed Lost record had 14 contacts on dunavant.com while the account the rep
 * actually works had 2, so ranking by contact count picked the dead one and
 * marked it 'confirmed'. Every write would have landed where nobody looks, and
 * nothing would have thrown.
 *
 * So the discriminator is LIVE WORK, not accumulated data, which is the rule
 * Eduardo gave on 2026-08-14: "there's always an activity when that discovery
 * is going to happen, that's the most accurate way to match it."
 *
 *   1. an open opportunity
 *   2. any activity at all
 *   3. a current (001RN) record over a legacy (0013j) one
 *
 * Returns null when nothing separates them, which leaves the caller's own
 * tiebreak in charge rather than inventing a winner here.
 */
async function preferLiveAccount(
  ids: readonly string[],
  expectName?: string | null,
): Promise<string | null> {
  const clean = ids.map((i) => soqlSafe(i)).filter(Boolean);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  const inList = clean.map((i) => `'${i}'`).join(",");

  // Uncaught for the same reason the strategies above are: a failure here must
  // surface, not quietly hand back the wrong twin.
  const oq = await sfGet<{ records?: Array<{ AccountId?: string | null }> }>(
    `/query?q=${encodeURIComponent(
      `SELECT AccountId FROM Opportunity WHERE AccountId IN (${inList}) AND IsClosed = false LIMIT 200`,
    )}`,
  );
  const withOpenOpp = new Set((oq.records ?? []).map((r) => r.AccountId).filter(Boolean) as string[]);

  // EXACTLY ONE, and nothing else counts.
  //
  // The first version of this also ranked by task count and preferred 001RN
  // over 0013j when the opportunity signal was silent. Both were wrong, and
  // Mollaxpanama proved it: those tiebreaks turned a match the old code
  // correctly held back for a human into a 'confirmed' link to a legacy record
  // named "Vene-embarques, C.A. LLC", a different company entirely.
  //
  // An open opportunity means somebody is selling to this account right now.
  // Task counts and record ages are accumulation, and accumulation cannot tell
  // you which of two DIFFERENT companies the customer is. Where the opportunity
  // signal does not separate them, this returns null and the caller's existing
  // behaviour stands, which for an unresolved domain means falling through to
  // the name path and, ultimately, to a human.
  if (withOpenOpp.size !== 1) return null;
  const winner = [...withOpenOpp][0];

  // The open opportunity says somebody is selling to this account. It does NOT
  // say it is the same company as the deal, and that distinction is the whole
  // guard. Mollaxpanama's domain matched several accounts, exactly one of which
  // had an open opportunity, and that account is named "Vene-embarques, C.A.
  // LLC". Without this check the resolver upgraded a match the old code
  // correctly left for a human into a 'confirmed' link on a different company.
  //
  // No name to check against means no confidence to add: return null and let
  // the caller's existing fallbacks run, which end at a person.
  if (!expectName || !expectName.trim()) return null;

  const nq = await sfGet<{ records?: Array<{ Name?: string | null }> }>(
    `/query?q=${encodeURIComponent(`SELECT Name FROM Account WHERE Id = '${soqlSafe(winner)}' LIMIT 1`)}`,
  );
  const foundName = nq.records?.[0]?.Name ?? "";
  // Same normalized prefix test the name path uses, so the two agree about
  // what "the same company" means.
  return nameOverlaps(foundName, expectName) ? winner : null;
}

async function resolveAccountId(
  domain: string,
  addresses: ReadonlyArray<string> = [],
  /** The deal's account name, used to sanity-check a duplicate-record tiebreak. */
  expectName?: string | null,
): Promise<string | null> {
  const clean = soqlSafe(domain).toLowerCase().trim();
  if (!clean || !clean.includes(".")) return null;

  // 0. A human already confirmed this mapping. Beats every heuristic below.
  const pinned = crosswalkSalesforceAccountId(clean);
  if (pinned) return pinned;

  // 1. Exact contact email. The strongest signal there is, and the only one
  //    that works for a consumer address. It also catches the case where a
  //    stakeholder sits on the account under a different domain, as Marco
  //    Rizzo at ilinvestimenti.com does on the Medov account.
  const exact = addresses
    .map((a) => soqlSafe(a).toLowerCase().trim())
    .filter((a) => a.includes("@"))
    .slice(0, 10);
  if (exact.length > 0) {
    // No catch here, deliberately. This used to swallow the error and fall
    // through to the Website match, which is blank on most Magaya accounts, so
    // a transient failure returned null and the caller read that as "this
    // company is not in Salesforce". Four of Alexandra's briefings lost their
    // BDR context that way on one run and had it on the next, with no code
    // change between them and nothing in the logs. sfGet already retries twice;
    // if it is still failing, the honest answer is that we do not know, and
    // SalesforceUnavailableError says so. Absence is null; failure throws.
    const eq = await sfGet<{ records?: Array<{ AccountId?: string | null }> }>(
      `/query?q=${encodeURIComponent(
        `SELECT AccountId FROM Contact WHERE Email IN (${exact.map((e) => `'${e}'`).join(",")}) AND AccountId != null LIMIT 10`,
      )}`,
    );
    const ids = new Set((eq.records ?? []).map((r) => r.AccountId).filter(Boolean) as string[]);
    if (ids.size === 1) return [...ids][0];
  }

  // 2. Contacts sharing the domain. Never for consumer mail: matching
  //    '%@gmail.com' returns whichever unrelated company happens to have a
  //    Gmail contact, and briefing one customer's qualification data on
  //    another customer's call is unrecoverable.
  if (!isFreeMailDomain(clean)) {
    // Also uncaught, for the reason given above. Falling through on failure is
    // only safe when the next strategy is as strong as this one, and Website is
    // not: it is set on a small minority of these accounts.
    const cq = await sfGet<{ records?: Array<{ AccountId?: string | null }> }>(
      `/query?q=${encodeURIComponent(
        `SELECT AccountId FROM Contact WHERE Email LIKE '%@${clean}' AND AccountId != null LIMIT 50`,
      )}`,
    );
    const counts = new Map<string, number>();
    for (const r of cq.records ?? []) {
      const id = r.AccountId;
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    if (counts.size === 1) return [...counts.keys()][0];
    if (counts.size > 1) {
      // Live work decides first. Contact count was the ONLY tiebreak here and
      // it is the one that chose Dunavant's 2021 Closed Lost record over the
      // account holding the opportunity created on the day of the call.
      const live = await preferLiveAccount([...counts.keys()], expectName);
      if (live) return live;
      const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      // A clear plurality is a duplicate-record problem, not a real
      // ambiguity. On a tie, keep going rather than giving up: the website
      // match below may still be decisive.
      if (ranked[0][1] > ranked[1][1]) return ranked[0][0];
    }
  }

  // 3. Website. Blank on most Magaya accounts, but decisive when it is set.
  if (isFreeMailDomain(clean)) return null;
  const wq = await sfGet<{ records?: Array<{ Id?: string }> }>(
    `/query?q=${encodeURIComponent(
      `SELECT Id FROM Account WHERE Website LIKE '%${clean}%' ORDER BY LastModifiedDate DESC LIMIT 2`,
    )}`,
  );
  const recs = wq.records ?? [];
  if (recs.length === 1 && recs[0].Id) return recs[0].Id;
  // Two websites matching is the duplicate-record case again, not a genuine
  // ambiguity, so give live work a chance to decide before giving up.
  if (recs.length > 1) {
    return preferLiveAccount(recs.map((r) => r.Id).filter(Boolean) as string[], expectName);
  }
  return null;
}

/**
 * Find the account for a customer email domain and pull its Sales Development
 * context plus contacts. Returns null when there is no confident match, which
 * is the common and correct outcome for a brand new inbound.
 */
export async function getAccountContextByDomain(
  domain: string,
  attendeeEmails: ReadonlyArray<string> = [],
): Promise<SalesforceAccountContext | null> {
  const id = await resolveAccountId(domain, attendeeEmails);
  if (!id) return null;
  return loadAccountContext(id);
}

/**
 * Pull one known Account's Sales Development context plus contacts.
 *
 * Split out from getAccountContextByDomain so an account reached by name (see
 * resolveAccount below) loads through exactly the same code. Returns null only
 * when the id does not come back from Salesforce; every transport or auth
 * failure throws, because "we could not read it" must not look like "it is not
 * there".
 */
/**
 * Fields whose one recorded value is the same on the whole book.
 *
 * COUNTED, not assumed, over the 123 accounts carrying a confirmed deal link on
 * 2026-08-28: Special Handling Instructions is "No" on 123 of 123. A field with
 * one observed value carries no information about the account in front of the
 * rep, and printing it on every briefing spends a line and some of the reader's
 * trust to say nothing.
 *
 * The neighbouring booleans were counted in the same pass and are all KEPT,
 * because they are genuinely answered: Compelling Events splits 57/43, Budget
 * Confirmed 78/22, Executive Sponsorship 55/45. That distinction is the whole
 * point of measuring rather than eyeballing. Unlike a Rolldog checklist box,
 * where false means unset, a "No" in these fields is a BDR's recorded answer
 * and the briefing may rely on it.
 *
 * Suppression is keyed to the VALUE, not the field, so the day a BDR types a
 * real special-handling instruction it appears. Re-measure before adding to
 * this map; a field that is constant across 123 accounts is a fact about the
 * book, and the book changes.
 */
const UNINFORMATIVE = new Map<string, string>([["Special Handling Instructions", "No"]]);

/**
 * Fields dropped whatever their value, because a briefing is better without them.
 *
 * "Less Than 90 Days" is a boolean sitting beside "Desired Go-Live Date", and
 * COUNTED over the 81 accounts carrying both on 2026-08-28 it disagrees with
 * that date on 38 of them, with a further 15 dates already in the past. The
 * first Orvia briefing generated with the handoff block printed the result:
 * "December 31, 2026, which the BDR flagged as less than 90 days from now",
 * four months out, in a section whose whole purpose is that the rep can rely on
 * it without opening Salesforce.
 *
 * The date is the fact and the boolean is a stale derivation of it, so there is
 * nothing to reconcile and nothing lost by dropping it. Keeping it would mean
 * asking the model to arbitrate between two CRM fields, which is a judgement it
 * cannot make and should not be handed.
 *
 * A go-live date in the PAST is deliberately still shown. That is a real fact
 * about a real record and the model handles it well on its own: the Cargosystems
 * briefing flagged a December 2024 target as already passed and told the rep to
 * confirm the real one, which is exactly right.
 */
const NEVER_SHOW = new Set<string>(["Less Than 90 Days"]);

export async function loadAccountContext(id: string): Promise<SalesforceAccountContext | null> {
  const map = await accountFieldMap();
  const select = ["Id", "Name", "Website", ...map.values()].join(", ");

  const q = await sfGet<{ records?: Array<Record<string, unknown>> }>(
    `/query?q=${encodeURIComponent(`SELECT ${select} FROM Account WHERE Id = '${soqlSafe(id)}' LIMIT 1`)}`,
  );
  const records = q.records ?? [];
  if (records.length !== 1) return null;
  const rec = records[0];

  const fields: SalesforceAccountContext["fields"] = [];
  for (const [label, api] of map) {
    const v = render(rec[api]);
    if (!v) continue;
    if (NEVER_SHOW.has(label)) continue;
    if (UNINFORMATIVE.get(label) === v.trim()) continue;
    fields.push({ label, value: v });
  }

  const accountId = String(rec.Id);
  let contacts: SalesforceAccountContext["contacts"] = [];
  try {
    const cq = await sfGet<{ records?: Array<Record<string, unknown>> }>(
      `/query?q=${encodeURIComponent(
        `SELECT Name, Title, Email FROM Contact WHERE AccountId = '${soqlSafe(accountId)}' ORDER BY LastModifiedDate DESC LIMIT 10`,
      )}`,
    );
    // Dedupe: duplicate contact rows are normal in an org this age, and the
    // same name twice in a briefing reads as a bug to the rep.
    const seen = new Set<string>();
    for (const c of cq.records ?? []) {
      const name = String(c.Name ?? "").trim();
      const email = render(c.Email);
      const key = (email ?? name).toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      contacts.push({ name, title: render(c.Title), email });
    }
  } catch {
    // Contacts are additive. Losing them should not lose the account context.
  }

  return {
    accountId,
    accountName: String(rec.Name ?? "").trim(),
    website: render(rec.Website),
    fields,
    contacts,
  };
}

/**
 * Search accounts by name fragment. Used by the crosswalk proposer, where a
 * human reviews the candidates, so it deliberately returns several rather than
 * insisting on one. Never call this from the briefing path: a fuzzy name match
 * is exactly the kind of guess that puts the wrong customer in front of a rep.
 */
export async function findAccountsByName(
  fragment: string,
  limit = 8,
): Promise<Array<{ id: string; name: string; website: string | null; contacts: number }>> {
  const q = soqlSafe(fragment).trim();
  if (q.length < 3) return [];
  const res = await sfGet<{ records?: Array<Record<string, unknown>> }>(
    `/query?q=${encodeURIComponent(
      `SELECT Id, Name, Website FROM Account WHERE Name LIKE '%${q}%' ORDER BY LastModifiedDate DESC LIMIT ${Math.max(1, Math.min(limit, 25))}`,
    )}`,
  );
  const out: Array<{ id: string; name: string; website: string | null; contacts: number }> = [];
  for (const r of res.records ?? []) {
    const id = String(r.Id);
    let contacts = 0;
    try {
      const c = await sfGet<{ totalSize?: number }>(
        `/query?q=${encodeURIComponent(`SELECT COUNT() FROM Contact WHERE AccountId = '${soqlSafe(id)}'`)}`,
      );
      contacts = c.totalSize ?? 0;
    } catch {
      /* count is decoration */
    }
    out.push({ id, name: String(r.Name ?? "").trim(), website: render(r.Website), contacts });
  }
  return out;
}

// ---------------------------------------------------------------------
// Resolution that cannot silently fail
// ---------------------------------------------------------------------

/**
 * The outcome of trying to find a customer's Salesforce Account.
 *
 * This exists because the previous entry point returned
 * `SalesforceAccountContext | null` and that null carried five different
 * meanings at once. Eduardo's Gezairi call is the example that forced it: the
 * only address on the invite was manele.khoury@gmail.com, the free-mail guard
 * correctly refused to match %@gmail.com, and the briefing therefore said
 * nothing about Gezairi at all. Account 001RN00000mNkLHYA0 named "Gezairi"
 * existed the whole time. "No account exists" and "no route from this invite to
 * an account" are different facts and only one of them is about the customer.
 *
 * Note which statuses authorize what. Reading is permitted on a name match,
 * because a labelled, human-reviewable block of BDR notes in a briefing beats a
 * blank page. WRITING is not: see resolveSalesforceWriteTarget in
 * lib/salesforce-scope.ts, which requires `confirmed`. A name match is evidence
 * enough to inform a rep and not evidence enough to edit a customer's CRM.
 */
export type AccountResolution =
  /** An email domain or exact contact address matched. The strong case. */
  | {
      status: "resolved_by_domain";
      accountId: string;
      accountName: string;
      confidence: "confirmed";
    }
  /** Reached only by company name. Good enough to brief from, not to write to. */
  | {
      status: "resolved_by_name";
      accountId: string;
      accountName: string;
      confidence: "review";
      /** The name we searched, so a human can judge the match. */
      matchedName: string;
    }
  /** Salesforce answered and nothing matched. A real fact about the customer. */
  | { status: "no_account"; searchedNames: string[] }
  /** Several candidates survived the guard. A human resolves this, never us. */
  | {
      status: "ambiguous";
      candidates: Array<{ id: string; name: string; website: string | null; contacts: number }>;
      searchedNames: string[];
    }
  /** The lookup threw. We know nothing. Never persisted, never briefed as absence. */
  | { status: "lookup_failed"; error: string; stage: "domain" | "name" }
  /** Nothing on the invite or the deal to search with. Not a Salesforce fact. */
  | { status: "no_identifier" };

/** Candidates whose name genuinely overlaps the one we searched for.
 *
 *  Salesforce `LIKE '%x%'` is fuzzy and will happily return a different
 *  customer: searching "IFF" matches "Griffiths". Same guard the Rolldog side
 *  uses in meeting-readiness, normalized on both sides and requiring one to be
 *  a prefix of the other, so "Gezairi" matches "Gezairi Group" and does not
 *  match "Gezairi" inside some unrelated string.
 */
function nameOverlaps(candidateName: string, searched: string): boolean {
  const a = normalizeName(candidateName);
  const b = normalizeName(searched);
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/**
 * Find a customer's Salesforce Account, saying exactly how it went.
 *
 * Order is deliberate. Domain first, because an email domain is a fact about
 * the counterparty. Name second, and only when the domain route could not
 * apply (free mail) or came back empty. A thrown error at either stage returns
 * `lookup_failed` and STOPS: it never falls through to the weaker strategy.
 * That fall-through is the exact bug that cost four briefings their BDR context
 * between two runs with nothing in the logs.
 */
export async function resolveAccount(args: {
  /** Customer email domain from the invite, if any. */
  domain?: string | null;
  /** Exact attendee addresses, which work even for consumer mail. */
  addresses?: ReadonlyArray<string>;
  /** The deal's account name. Tried before the subject: it is more stable. */
  dealAccountName?: string | null;
  /** Meeting subject, mined via accountFromSubject as the last identifier. */
  meetingSubject?: string | null;
}): Promise<AccountResolution> {
  const domain = (args.domain ?? "").trim().toLowerCase();
  const addresses = args.addresses ?? [];
  const freeMail = domain ? isFreeMailDomain(domain) : false;

  // 1. Domain and exact address. resolveAccountId throws on a real failure and
  //    returns null only for a genuine miss, which is what lets these two be
  //    told apart here.
  if (domain || addresses.length > 0) {
    try {
      const id = await resolveAccountId(domain, addresses, args.dealAccountName ?? null);
      if (id) {
        const ctx = await loadAccountContext(id);
        return {
          status: "resolved_by_domain",
          accountId: id,
          accountName: ctx?.accountName ?? "",
          confidence: "confirmed",
        };
      }
    } catch (err) {
      return {
        status: "lookup_failed",
        stage: "domain",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // 2. Name fallback. Reached when the domain was free mail (so the domain
  //    route was never usable) or when it resolved to nothing.
  const searchedNames = [
    (args.dealAccountName ?? "").trim(),
    (accountFromSubject(args.meetingSubject ?? null) ?? "").trim(),
  ].filter((n) => n.length >= 3);

  if (searchedNames.length === 0) {
    // Nothing to search with. If we never had a domain either, this is not a
    // statement about Salesforce at all.
    return domain && !freeMail ? { status: "no_account", searchedNames: [] } : { status: "no_identifier" };
  }

  const survivors = new Map<string, { id: string; name: string; website: string | null; contacts: number; via: string }>();
  for (const name of searchedNames) {
    let hits: Awaited<ReturnType<typeof findAccountsByName>>;
    try {
      hits = await findAccountsByName(name);
    } catch (err) {
      return {
        status: "lookup_failed",
        stage: "name",
        error: err instanceof Error ? err.message : String(err),
      };
    }
    for (const h of hits) {
      if (!nameOverlaps(h.name, name)) continue;
      if (!survivors.has(h.id)) survivors.set(h.id, { ...h, via: name });
    }
  }

  const list = [...survivors.values()];
  if (list.length === 0) return { status: "no_account", searchedNames };
  if (list.length > 1) {
    return {
      status: "ambiguous",
      candidates: list.map(({ id, name, website, contacts }) => ({ id, name, website, contacts })),
      searchedNames,
    };
  }

  const only = list[0];
  return {
    status: "resolved_by_name",
    accountId: only.id,
    accountName: only.name,
    confidence: "review",
    matchedName: only.via,
  };
}

/** One-line, human-readable account of a resolution. Used by the diagnostics. */
export function resolutionSummary(r: AccountResolution): string {
  switch (r.status) {
    case "resolved_by_domain":
      return `${r.accountName || r.accountId} (matched by email domain)`;
    case "resolved_by_name":
      return `${r.accountName} (matched by name "${r.matchedName}", needs a human to confirm)`;
    case "no_account":
      return r.searchedNames.length
        ? `no account (searched ${r.searchedNames.map((n) => `"${n}"`).join(", ")})`
        : "no account matched this domain";
    case "ambiguous":
      return `AMBIGUOUS, ${r.candidates.length} candidates: ${r.candidates.map((c) => `${c.id} ${c.name}`).join(" | ")}`;
    case "lookup_failed":
      return `LOOKUP FAILED at the ${r.stage} stage, this is not "no account": ${r.error}`;
    case "no_identifier":
      return "no company domain or name to search with";
  }
}

/**
 * Render for the briefing prompt. Explicitly attributed to the BDR rather than
 * presented as fact from a call: Juan reads these before discovery calls and
 * needs to know which claims a customer has actually made and which are a
 * colleague's notes he is about to test.
 */
export function accountContextLines(ctx: SalesforceAccountContext): string {
  const out: string[] = [];
  out.push(`Salesforce account: ${ctx.accountName}${ctx.website ? ` (${ctx.website})` : ""}`);
  out.push("Recorded by the BDR before this call, not confirmed by the customer to us:");
  if (ctx.fields.length === 0) {
    out.push("  (Sales Development section is empty)");
  } else {
    for (const f of ctx.fields) out.push(`  ${f.label}: ${f.value}`);
  }
  if (ctx.contacts.length > 0) {
    out.push("Known contacts on the account:");
    for (const c of ctx.contacts) {
      out.push(`  ${c.name}${c.title ? `, ${c.title}` : ""}${c.email ? ` <${c.email}>` : ""}`);
    }
  }
  return out.join("\n");
}

// =====================================================================
// Customer standing and opportunity situation
//
// Added for lib/meeting-context.ts. Everything above answers "what does
// Salesforce hold about this company"; this answers the two questions every
// downstream action actually needs before it decides anything:
//
//   Are they already a customer, and if so where are they in their life with
//   us (implementing, live, churned)?
//   What KIND of deal is the open opportunity, specifically is it a renewal?
//
// Both were guessed from the calendar title until now. Both are recorded in
// Salesforce, on fields confirmed present in Magaya's org by describe:
// Account.Customer_Since__c, Customer_Status__c, Implementati__c,
// Account_Active_Licenses__c, and Opportunity.Is_Renewal__c,
// Opportunity_Type__c, Type.
//
// Field-level security can hide any of them from the integration user, so both
// reads describe first and query only what is actually visible, the same way
// accountFieldMap does. A hidden field is "did not check", never "no".
// =====================================================================

type DescribeField = { name: string; type: string };

const _describeCache = new Map<string, { at: number; names: Set<string> }>();

/** Field API names visible to the integration user on an sobject. */
async function visibleFields(sobject: string): Promise<Set<string>> {
  const hit = _describeCache.get(sobject);
  if (hit && Date.now() - hit.at < FIELD_MAP_TTL_MS) return hit.names;
  const d = await sfGet<{ fields?: DescribeField[] }>(`/sobjects/${sobject}/describe`);
  const names = new Set((d.fields ?? []).map((f) => f.name));
  _describeCache.set(sobject, { at: Date.now(), names });
  return names;
}

export type CustomerStanding =
  | {
      status: "customer";
      /** ISO date they became a customer, when the org records one. */
      since: string | null;
      /** Magaya's own implementation status picklist, when populated. */
      implementation: string | null;
      activeLicenses: number | null;
      churnedOn: string | null;
      accountType: string | null;
      detail: string;
    }
  | { status: "prospect"; detail: string }
  /** Read failed, or every field that would answer it is hidden. */
  | { status: "unavailable"; detail: string };

/**
 * Is this account already a Magaya customer.
 *
 * "prospect" is only returned when the fields that would say otherwise were
 * READABLE and empty. If the read failed or the fields are hidden, this is
 * "unavailable", because telling a paying customer of six years that we think
 * they are a prospect is the single most expensive error in this product.
 */
export async function readCustomerStanding(accountId: string): Promise<CustomerStanding> {
  const id = soqlSafe(accountId);
  if (!id) return { status: "unavailable", detail: "no account id" };

  const CANDIDATES = [
    "Customer_Since__c",
    "Implementati__c",
    "Account_Active_Licenses__c",
    "Intacct_Customer_Churn_Date__c",
    "Type",
    "Active__c",
  ];

  let fields: string[];
  try {
    const visible = await visibleFields("Account");
    fields = CANDIDATES.filter((f) => visible.has(f));
  } catch (e) {
    return {
      status: "unavailable",
      detail: `Account describe failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (fields.length === 0) {
    return { status: "unavailable", detail: "no customer-standing field is visible to the integration user" };
  }

  let row: Record<string, unknown>;
  try {
    const q = await sfGet<{ records?: Array<Record<string, unknown>> }>(
      `/query?q=${encodeURIComponent(`SELECT ${fields.join(", ")} FROM Account WHERE Id = '${id}' LIMIT 1`)}`,
    );
    const rows = q.records ?? [];
    if (rows.length === 0) return { status: "unavailable", detail: "account not found" };
    row = rows[0];
  } catch (e) {
    return {
      status: "unavailable",
      detail: `account read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const str = (k: string): string | null => {
    const v = row[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const num = (k: string): number | null => (typeof row[k] === "number" ? (row[k] as number) : null);

  const since = str("Customer_Since__c");
  const licenses = num("Account_Active_Licenses__c");
  const churn = str("Intacct_Customer_Churn_Date__c");
  const accountType = str("Type");

  // Customer_Status__c is NOT evidence and is deliberately not read here.
  //
  // It carries 'Active' on 39,297 of Magaya's ~45,000 accounts, including every
  // one of Gezairi, Dunavant, Oceanbridge, IFF and Miracle Logistics, all of
  // which are prospects on a first discovery call. It describes whether the
  // RECORD is active, not whether the company buys from Magaya. Reading it as
  // customer evidence classified seven genuine discovery calls as expansion
  // conversations, which is the checklist-boolean mistake again: a field whose
  // values were assumed rather than checked.
  //
  // Account.Type is the field that means this. It splits 5,198 Customer against
  // 39,452 Prospect and agrees with Customer_Since__c and the licence count on
  // every account inspected.
  const evidence: string[] = [];
  if (accountType && /customer/i.test(accountType)) evidence.push(`account type ${accountType}`);
  if (since) evidence.push(`customer since ${since}`);
  if (licenses !== null && licenses > 0) evidence.push(`${licenses} active licence(s)`);
  // A churn date only counts alongside one of the above. On its own it would
  // make a record that once had a stray date look like a customer.
  if (churn && evidence.length > 0) evidence.push(`churned ${churn}`);

  if (evidence.length > 0) {
    return {
      status: "customer",
      since,
      implementation: str("Implementati__c"),
      activeLicenses: licenses,
      churnedOn: churn,
      accountType,
      detail: evidence.join(", "),
    };
  }

  return {
    status: "prospect",
    detail:
      accountType && /prospect/i.test(accountType)
        ? `Salesforce records this account as a Prospect, with no customer-since date and no active licence`
        : `Salesforce holds no customer-since date, no active licence and no customer account type (${fields.length} field(s) checked)`,
  };
}

export type OpportunitySituation =
  | {
      status: "found";
      id: string;
      name: string;
      stage: string;
      isRenewal: boolean | null;
      opportunityType: string | null;
      closeDate: string | null;
      amount: number | null;
      detail: string;
    }
  /** The account was read and has no open opportunity. */
  | { status: "none"; detail: string }
  | { status: "unavailable"; detail: string };

/**
 * The open opportunity on this account, with the two fields that change how a
 * call should be run: whether it is a renewal, and what type of deal it is.
 *
 * findOpenOpportunity in lib/salesforce-opportunity.ts answers a narrower
 * question for the write path and deliberately reads only Id, Name and Stage.
 * This is the read side and needs more, so it is separate rather than widening
 * a query the writer depends on.
 */
export async function readOpportunitySituation(accountId: string): Promise<OpportunitySituation> {
  const id = soqlSafe(accountId);
  if (!id) return { status: "unavailable", detail: "no account id" };

  const CANDIDATES = ["Is_Renewal__c", "Opportunity_Type__c", "Type", "CloseDate", "Amount"];
  let extra: string[];
  try {
    const visible = await visibleFields("Opportunity");
    extra = CANDIDATES.filter((f) => visible.has(f));
  } catch (e) {
    return {
      status: "unavailable",
      detail: `Opportunity describe failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  try {
    const soql =
      `SELECT Id, Name, StageName${extra.length ? ", " + extra.join(", ") : ""} FROM Opportunity ` +
      `WHERE AccountId = '${id}' AND IsClosed = false ORDER BY CreatedDate DESC LIMIT 1`;
    const q = await sfGet<{ records?: Array<Record<string, unknown>> }>(
      `/query?q=${encodeURIComponent(soql)}`,
    );
    const rows = q.records ?? [];
    if (rows.length === 0) {
      return { status: "none", detail: "no open opportunity on this account" };
    }
    const r = rows[0];
    const isRenewal = typeof r.Is_Renewal__c === "boolean" ? (r.Is_Renewal__c as boolean) : null;
    const oppType =
      (typeof r.Opportunity_Type__c === "string" && r.Opportunity_Type__c) ||
      (typeof r.Type === "string" && r.Type) ||
      null;
    const bits = [
      `stage ${String(r.StageName ?? "unknown")}`,
      isRenewal === true ? "flagged as a renewal" : isRenewal === false ? "not a renewal" : "renewal flag not readable",
      oppType ? `type ${oppType}` : "type not set",
    ];
    return {
      status: "found",
      id: String(r.Id),
      name: String(r.Name ?? ""),
      stage: String(r.StageName ?? ""),
      isRenewal,
      opportunityType: oppType,
      closeDate: typeof r.CloseDate === "string" ? r.CloseDate : null,
      amount: typeof r.Amount === "number" ? r.Amount : null,
      detail: bits.join(", "),
    };
  } catch (e) {
    return {
      status: "unavailable",
      detail: `opportunity read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * What the BDR already did, before the rep's first call.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One thing the BDR did with this prospect, ahead of the handoff. */
export type PriorActivity = {
  kind: "email" | "note";
  /** Who did it, for attribution in the briefing. A rep trusts a named source. */
  actor: string;
  at: string;
  subject: string;
  /** Headers stripped, whitespace collapsed, capped. */
  body: string;
};

/**
 * present  we read the account and found activity
 * empty    we read the account and there genuinely is none
 * unavailable  the read failed, which is NOT the same as none
 *
 * The third case is the whole point. A Salesforce timeout that returned an
 * empty array would otherwise brief the rep as "the BDR left you nothing",
 * which is this codebase's signature failure wearing a new hat.
 */
export type PriorActivityRead =
  | { status: "present"; items: PriorActivity[] }
  | { status: "empty" }
  | { status: "unavailable"; error: string };

const ACTIVITY_BODY_MAX = 1200;
const ACTIVITY_LIMIT = 6;

/**
 * Strip Salesforce's logged-email envelope.
 *
 * A Task created by Salesforce email logging carries the whole envelope in
 * Description: "Additional To: ... CC: ... BCC: ... Attachment: ... Subject:
 * ... Body: ...". The rep wants the body. Handing them the header block is
 * worse than handing them nothing, because they stop reading.
 */
function emailBody(description: string): string {
  const s = description.replace(/\r/g, "");
  const i = s.search(/(^|\n)\s*Body:\s*/i);
  const body = i >= 0 ? s.slice(s.indexOf(":", i) + 1) : s;
  return body
    .replace(/^\s*(Additional To|To|CC|BCC|Attachment|Subject):.*$/gim, "")
    .replace(/_{10,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Teams and Zoom paste their join blurb into Description. Not a note. */
function isMeetingChrome(text: string): boolean {
  return /microsoft teams meeting|teams\.microsoft\.com\/meet|zoom\.us\/j\/|meet\.google\.com|Meeting ID:|Passcode:/i.test(
    text,
  );
}

/**
 * Everything the BDR logged on this account before a given moment.
 *
 * Juan Lopez, 2026-08-28: "when we get the email with the briefing, we don't
 * really have any data. It's saying go gather all this information, because it
 * doesn't have any of the pre-qualification data. But there IS data the BDRs
 * are entering in Salesforce." He is right, and it was never read.
 *
 * Measured over 60 days before building this: 158 of 200 Tasks carry a real
 * Description and they are the BDR's own logged correspondence with the
 * prospect, body included. Events mostly carry Teams join chrome, with the
 * occasional one-line note. Salesforce Notes are not used at all: all 40
 * ContentNotes in that window were DealRipe's own recaps. So the email is the
 * source worth reading and the note field is the long tail.
 *
 * Description cannot be filtered in SOQL on either object, so this fetches and
 * filters here.
 */
export async function readPriorActivity(args: {
  accountId: string;
  /** Only what happened BEFORE this, so a briefing cannot cite its own call. */
  before: string;
}): Promise<PriorActivityRead> {
  try {
    const { token, instanceUrl } = await getSalesforceClient();
    const run = async (soql: string): Promise<Record<string, unknown>[]> => {
      const res = await fetch(
        `${instanceUrl}/services/data/v60.0/query?q=${encodeURIComponent(soql)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
      return ((await res.json()) as { records?: Record<string, unknown>[] }).records ?? [];
    };
    const before = new Date(args.before).toISOString();
    // Exclude what DealRipe itself wrote.
    //
    // salesforce-activity logs a call Task and a next-step Task on every
    // captured call, so without this the briefing quotes our own recap back to
    // the rep as "what the BDR already covered". Circular, and it teaches them
    // the section is worthless. Excluded by AUTHOR rather than by subject
    // pattern, because the pattern is ours to change and the author is not.
    const { getIntegrationUserId } = await import("./salesforce-activity");
    const ours = await getIntegrationUserId(instanceUrl, token).catch(() => null);
    const notOurs = ours ? ` AND CreatedById != '${ours}' ` : " ";
    const [tasks, events] = await Promise.all([
      run(
        `SELECT Owner.Name, Subject, Description, CreatedDate FROM Task ` +
          `WHERE WhatId = '${args.accountId}' AND CreatedDate < ${before}${notOurs}` +
          `ORDER BY CreatedDate DESC LIMIT 40`,
      ),
      run(
        `SELECT Owner.Name, Subject, Description, ActivityDate, CreatedDate FROM Event ` +
          `WHERE WhatId = '${args.accountId}' AND CreatedDate < ${before}${notOurs}` +
          `ORDER BY CreatedDate DESC LIMIT 40`,
      ),
    ]);

    const items: PriorActivity[] = [];
    const push = (r: Record<string, unknown>, kind: PriorActivity["kind"]) => {
      const raw = String(r.Description ?? "");
      const subject = String(r.Subject ?? "").trim();
      const body = kind === "email" ? emailBody(raw) : raw.replace(/\s+/g, " ").trim();
      // Meeting chrome and one-word stubs are noise. A briefing that quotes
      // "Microsoft Teams meeting Join:" teaches the rep to skip the section.
      if (body.length < 25 || isMeetingChrome(body)) return;
      items.push({
        kind,
        actor: String((r.Owner as { Name?: string } | undefined)?.Name ?? "someone at Magaya"),
        at: String(r.CreatedDate ?? "").slice(0, 10),
        subject: subject.replace(/^Email:\s*/i, ""),
        body: body.slice(0, ACTIVITY_BODY_MAX),
      });
    };
    for (const r of tasks) push(r, /^email:/i.test(String(r.Subject ?? "")) ? "email" : "note");
    for (const r of events) push(r, "note");

    if (items.length === 0) return { status: "empty" };
    return { status: "present", items: items.slice(0, ACTIVITY_LIMIT) };
  } catch (err) {
    return { status: "unavailable", error: err instanceof Error ? err.message : String(err) };
  }
}
