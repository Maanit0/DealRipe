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
import { isFreeMailDomain } from "./pilot-config";
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
async function resolveAccountId(domain: string, addresses: ReadonlyArray<string> = []): Promise<string | null> {
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
    try {
      const eq = await sfGet<{ records?: Array<{ AccountId?: string | null }> }>(
        `/query?q=${encodeURIComponent(
          `SELECT AccountId FROM Contact WHERE Email IN (${exact.map((e) => `'${e}'`).join(",")}) AND AccountId != null LIMIT 10`,
        )}`,
      );
      const ids = new Set((eq.records ?? []).map((r) => r.AccountId).filter(Boolean) as string[]);
      if (ids.size === 1) return [...ids][0];
    } catch {
      // fall through
    }
  }

  // 2. Contacts sharing the domain. Never for consumer mail: matching
  //    '%@gmail.com' returns whichever unrelated company happens to have a
  //    Gmail contact, and briefing one customer's qualification data on
  //    another customer's call is unrecoverable.
  if (!isFreeMailDomain(clean)) {
    try {
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
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        // A clear plurality is a duplicate-record problem, not a real
        // ambiguity. On a tie, keep going rather than giving up: the website
        // match below may still be decisive.
        if (ranked[0][1] > ranked[1][1]) return ranked[0][0];
      }
    } catch {
      // fall through
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
  return recs.length === 1 && recs[0].Id ? recs[0].Id : null;
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
    if (v) fields.push({ label, value: v });
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
