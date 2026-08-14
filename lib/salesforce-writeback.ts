/**
 * Type-aware writes to the Salesforce Account Sales Development section.
 *
 * Mark told the team DealRipe populates Salesforce for them. It did not, and
 * this is that. The constraint that shapes everything below is that a BDR
 * already wrote in these fields before the rep took the call, so this must add
 * to their work rather than replace it. Eduardo asked whether to overwrite or
 * enrich and nobody decided; "fill blanks, append where it fits, never
 * replace" is the version that does not need his answer to be safe.
 *
 * Three rules earn their keep:
 *
 * 1. BOOLEANS ARE ONLY EVER SET TRUE. Seven of these fields are checkboxes,
 *    and Salesforce cannot represent "unknown" in one. Writing false would
 *    assert a negative we have not established, into fields the CRO reads as
 *    qualification. An unchecked box already means "not established", so
 *    leaving it alone is both honest and correct.
 *
 * 2. PICKLISTS MATCH EXACTLY OR ARE SKIPPED. "Accounting System Used" has a
 *    fixed vocabulary. A call where someone says "we use Quickbooks online"
 *    maps to "QuickBooks Online" only if that string is in the picklist; near
 *    misses are dropped, never coerced, because a wrong value here is
 *    indistinguishable from a human's answer.
 *
 * 3. EXISTING TEXT IS NEVER TRUNCATED. The text areas cap at 500 and 255
 *    characters, so an append often will not fit alongside what the BDR wrote.
 *    When it does not fit, the write is skipped and reported. Nobody's
 *    sentence gets cut in half to make room for ours.
 */

import { accountFieldMeta, type AccountFieldMeta } from "./salesforce-context";
import { getSalesforceClient } from "./salesforce";

const API_VERSION = "v61.0";

/** What DealRipe proposes to do to one field. */
export type FieldWrite = {
  label: string;
  apiName: string;
  type: string;
  currentValue: string | null;
  /** The value we would send to Salesforce, already coerced to the field type. */
  newValue: string | number | boolean;
  /** Rendered for a human reading the preview. */
  display: string;
  mode: "fill_blank" | "append";
  evidence: string | null;
};

/**
 * How much of one Salesforce field our own prose may occupy, and the floor
 * below which we would rather write nothing.
 *
 * Both numbers exist because of Black Gold Logistics on 2026-08-12. Business
 * Issues held 305 characters of the rep's writing in a 500-character field and
 * our addition was 317, so the whole thing was skipped and the account learned
 * nothing from the call. Our 317 characters were the real problem: that is a
 * paragraph going into a field reps use as a one-liner, and it would have
 * overflowed a half-empty field too.
 *
 * MAX_CONTRIBUTION keeps us to roughly two sentences whatever the field allows.
 * MIN_CONTRIBUTION is the point below which a trimmed sentence stops being
 * worth reading, and a stub in a CRO's field is worse than a blank.
 *
 * The rep's existing text is still never touched. Only ours is trimmed.
 */
const MAX_CONTRIBUTION = 220;
const MIN_CONTRIBUTION = 80;

/**
 * Cut text to `max` at the last sentence end, falling back to a word boundary.
 *
 * A mid-word cut is what makes a CRM field look machine-filled, and the
 * ellipsis is the honest signal that there is more in the call record.
 */
function trimToSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const hard = text.slice(0, max);
  const stop = Math.max(hard.lastIndexOf(". "), hard.lastIndexOf("! "), hard.lastIndexOf("? "));
  if (stop >= Math.floor(max * 0.5)) return hard.slice(0, stop + 1).trimEnd();
  const soft = text.slice(0, Math.max(0, max - 3));
  const space = soft.lastIndexOf(" ");
  return `${(space >= Math.floor(max * 0.5) ? soft.slice(0, space) : soft).trimEnd()}...`;
}

export type FieldSkip = {
  label: string;
  apiName: string | null;
  reason: string;
};

export type WriteBackPlan = {
  accountId: string;
  accountName: string;
  writes: FieldWrite[];
  skips: FieldSkip[];
};

/**
 * A value DealRipe extracted for one Sales Development field, before it has
 * been checked against the field's real type.
 */
export type ProposedValue = {
  /** Field label as it appears in Salesforce. */
  label: string;
  /** Free-text answer from the call, or a boolean/number/date where we have one. */
  value: string | number | boolean | null;
  /** The customer's own words, carried into appended text so it is auditable. */
  evidence?: string | null;
  /**
   * How sure we are, 0 to 1. Booleans require high confidence because a
   * checkbox cannot later be walked back to "unknown".
   */
  confidence?: number;
};

const BOOLEAN_MIN_CONFIDENCE = 0.8;

/** Prefix matching the Rolldog write-back convention, so provenance is obvious. */
export function dealRipeStamp(callDate: string | Date): string {
  const d = typeof callDate === "string" ? new Date(callDate) : callDate;
  const label = Number.isNaN(d.getTime())
    ? "call"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" }) + " call";
  return `[DealRipe · ${label}]`;
}

function truthy(v: string | number | boolean | null): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === null) return null;
  const s = String(v).trim().toLowerCase();
  if (["yes", "true", "confirmed", "y"].includes(s)) return true;
  if (["no", "false", "not confirmed", "n"].includes(s)) return false;
  return null;
}

/** Case-insensitive exact match against the picklist vocabulary. */
function matchPicklist(raw: string, allowed: ReadonlyArray<string>): string | null {
  const s = raw.trim().toLowerCase();
  return allowed.find((a) => a.trim().toLowerCase() === s) ?? null;
}

/**
 * The first number in a sentence, or null.
 *
 * This used to strip every non-digit and parse what was left, which turns
 * "about 30 users across two offices" into 302 and "10 to 15 seats" into 1015.
 * Extractions are phrased by a model in the customer's own words, so multi-
 * number answers are the norm rather than the exception, and a silently wrong
 * user count in a customer's CRM is worse than a blank one.
 *
 * A range takes its lower bound: "10 to 15 users" is 10. Understating is
 * recoverable by a rep glancing at it; overstating flatters the deal.
 */
function firstNumber(raw: string): number | null {
  const m = raw.replace(/,(?=\d{3}\b)/g, "").match(/\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fit a stated revenue figure into Magaya's band picklist.
 *
 * Annual_Company_Revenue__c is a picklist of ranges ("1 Million to 10 Million"),
 * and a customer says "we did about eight million last year". Exact string
 * matching can never succeed on that, so the field would sit at 0% forever
 * while looking like it was mapped.
 *
 * Returns null when no figure can be read, which leaves the field blank rather
 * than guessing a band. A wrong revenue band is a wrong qualification.
 */
function revenueBand(raw: string, allowed: ReadonlyArray<string>): string | null {
  const s = raw.toLowerCase();
  const n = firstNumber(s);
  if (n === null) return null;

  // Normalise to millions. "8 million", "8m", "8,000,000" and "800k" all have
  // to land in the same unit before any band can be chosen.
  let millions: number;
  if (/\b(million|mill\b|mm\b|m\b)/.test(s)) millions = n;
  else if (/\b(billion|bn\b|b\b)/.test(s)) millions = n * 1000;
  else if (/\b(thousand|k\b)/.test(s)) millions = n / 1000;
  else if (n >= 1_000_000) millions = n / 1_000_000;
  else if (n >= 1000) millions = n / 1_000_000;
  else return null; // a bare small number is not a revenue figure

  const band =
    millions < 1 ? "0 to 1 Million"
    : millions < 10 ? "1 Million to 10 Million"
    : millions < 20 ? "10 Million to 20 Million"
    : millions < 50 ? "20 Million to 50 Million"
    : millions < 100 ? "50 Million to 100 Million"
    : "100 Million or More";

  return matchPicklist(band, allowed);
}

function toIsoDate(raw: string | number | boolean): string | null {
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Turn extracted answers into a concrete, type-checked plan. Reads the account
 * first so "fill blank" and "append" are decided against what is actually
 * there, not against what we last saw.
 */
export async function planAccountWriteBack(args: {
  accountId: string;
  accountName: string;
  proposed: ReadonlyArray<ProposedValue>;
  callDate: string | Date;
}): Promise<WriteBackPlan> {
  const meta = await accountFieldMeta();
  const stamp = dealRipeStamp(args.callDate);

  // Current values, so an append never has to guess what it is appending to.
  const names = [...meta.values()].map((f) => f.name);
  const { token, instanceUrl } = await getSalesforceClient();
  const soql = `SELECT Id, ${names.join(", ")} FROM Account WHERE Id = '${args.accountId.replace(/[^a-zA-Z0-9]/g, "")}' LIMIT 1`;
  const res = await fetch(`${instanceUrl}/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`current-value read failed (${res.status}) for ${args.accountId}`);
  const current = ((await res.json()) as { records?: Array<Record<string, unknown>> }).records?.[0] ?? {};

  const writes: FieldWrite[] = [];
  const skips: FieldSkip[] = [];

  for (const p of args.proposed) {
    const f: AccountFieldMeta | undefined = meta.get(p.label);
    if (!f) {
      skips.push({ label: p.label, apiName: null, reason: "field not visible to the integration user" });
      continue;
    }
    if (!f.updateable) {
      skips.push({ label: p.label, apiName: f.name, reason: "field is not updateable by this user" });
      continue;
    }
    if (p.value === null || String(p.value).trim() === "") {
      continue; // nothing extracted; not a skip worth reporting
    }

    const existingRaw = current[f.name];
    const existing =
      existingRaw === null || existingRaw === undefined || existingRaw === ""
        ? null
        : typeof existingRaw === "boolean"
          ? existingRaw
            ? "Yes"
            : "No"
          : String(existingRaw);

    switch (f.type) {
      case "boolean": {
        const b = truthy(p.value);
        if (b !== true) {
          skips.push({
            label: p.label,
            apiName: f.name,
            reason: b === false ? "would set false; DealRipe only ever checks a box, never unchecks it" : "not a clear yes",
          });
          break;
        }
        if ((p.confidence ?? 1) < BOOLEAN_MIN_CONFIDENCE) {
          skips.push({ label: p.label, apiName: f.name, reason: `confidence ${(p.confidence ?? 0).toFixed(2)} below ${BOOLEAN_MIN_CONFIDENCE} for a checkbox` });
          break;
        }
        if (existingRaw === true) break; // already true, nothing to do
        writes.push({
          label: p.label,
          apiName: f.name,
          type: f.type,
          currentValue: existing,
          newValue: true,
          display: "checked",
          mode: "fill_blank",
          evidence: p.evidence ?? null,
        });
        break;
      }

      case "picklist": {
        // Revenue is a band picklist and the answer is a figure in the
        // customer's words, so exact matching can never succeed on it.
        const v =
          f.name === "Annual_Company_Revenue__c"
            ? revenueBand(String(p.value), f.picklistValues)
            : matchPicklist(String(p.value), f.picklistValues);
        if (!v) {
          skips.push({
            label: p.label,
            apiName: f.name,
            reason: `"${String(p.value).slice(0, 40)}" is not one of the allowed values`,
          });
          break;
        }
        if (existing) {
          skips.push({ label: p.label, apiName: f.name, reason: `already set to "${existing}"; picklists are never overwritten` });
          break;
        }
        writes.push({ label: p.label, apiName: f.name, type: f.type, currentValue: existing, newValue: v, display: v, mode: "fill_blank", evidence: p.evidence ?? null });
        break;
      }

      case "multipicklist": {
        const parts = String(p.value)
          .split(/[;,]/)
          .map((s) => matchPicklist(s, f.picklistValues))
          .filter((s): s is string => !!s);
        if (parts.length === 0) {
          skips.push({ label: p.label, apiName: f.name, reason: `no part of "${String(p.value).slice(0, 40)}" matches the allowed values` });
          break;
        }
        // Union with whatever is already selected, so a BDR's choice survives.
        const had = existing ? existing.split(";").map((s) => s.trim()).filter(Boolean) : [];
        const merged = [...new Set([...had, ...parts])];
        if (merged.length === had.length) break; // nothing new
        writes.push({
          label: p.label,
          apiName: f.name,
          type: f.type,
          currentValue: existing,
          newValue: merged.join(";"),
          display: merged.join("; "),
          mode: had.length ? "append" : "fill_blank",
          evidence: p.evidence ?? null,
        });
        break;
      }

      case "date": {
        const iso = toIsoDate(p.value);
        if (!iso) {
          skips.push({ label: p.label, apiName: f.name, reason: `"${String(p.value).slice(0, 40)}" is not a date` });
          break;
        }
        if (existing) {
          skips.push({ label: p.label, apiName: f.name, reason: `already set to ${existing}; a date the customer gave a human is not ours to move` });
          break;
        }
        writes.push({ label: p.label, apiName: f.name, type: f.type, currentValue: existing, newValue: iso, display: iso, mode: "fill_blank", evidence: p.evidence ?? null });
        break;
      }

      case "double":
      case "int":
      case "currency": {
        const n = firstNumber(String(p.value));
        if (n === null || n <= 0) {
          skips.push({ label: p.label, apiName: f.name, reason: `"${String(p.value).slice(0, 40)}" is not a number` });
          break;
        }
        if (existing) {
          skips.push({ label: p.label, apiName: f.name, reason: `already set to ${existing}` });
          break;
        }
        writes.push({ label: p.label, apiName: f.name, type: f.type, currentValue: existing, newValue: n, display: String(n), mode: "fill_blank", evidence: p.evidence ?? null });
        break;
      }

      // textarea, string, phone, url, everything else text-shaped
      default: {
        const limit = f.length ?? 255;
        const body = String(p.value).trim();

        // Two characters for the blank line that separates us from their text.
        const room = existing ? limit - existing.length - 2 : limit;
        const budget = Math.min(MAX_CONTRIBUTION, room - stamp.length - 1);

        // Below the floor there is no honest version of the sentence, so skip
        // rather than write a stub. The reason still reports the arithmetic,
        // because "no room" without the numbers sent me looking at env vars.
        if (budget < MIN_CONTRIBUTION) {
          skips.push({
            label: p.label,
            apiName: f.name,
            reason:
              `no room: ${existing ? `${existing.length} of ${limit} chars already used` : `field holds ${limit} chars`}, ` +
              `leaving ${Math.max(0, budget)} for us and ${MIN_CONTRIBUTION} is the floor. Existing text is never truncated.`,
          });
          break;
        }

        // Fit OUR contribution to the room, in descending order of how much we
        // would like to keep: the quote goes before the sentence does.
        const withEvidence = `${body}${p.evidence ? ` "${p.evidence}"` : ""}`;
        const contribution =
          withEvidence.length <= budget ? withEvidence : trimToSentence(body, budget);
        const line = `${stamp} ${contribution}`;

        if (!existing) {
          writes.push({
            label: p.label,
            apiName: f.name,
            type: f.type,
            currentValue: null,
            newValue: line,
            display: line,
            mode: "fill_blank",
            evidence: p.evidence ?? null,
          });
          break;
        }

        // Do not repeat ourselves on a second call.
        if (existing.includes(body.slice(0, 60))) break;

        writes.push({
          label: p.label,
          apiName: f.name,
          type: f.type,
          currentValue: existing,
          newValue: `${existing}\n\n${line}`,
          display: line,
          mode: "append",
          evidence: p.evidence ?? null,
        });
      }
    }
  }

  return { accountId: args.accountId, accountName: args.accountName, writes, skips };
}

/**
 * Execute a plan. Separate from planning on purpose: the plan is reviewable and
 * this is not. Returns the fields written.
 */
export async function applyAccountWriteBack(plan: WriteBackPlan): Promise<{ written: string[]; error: string | null }> {
  if (plan.writes.length === 0) return { written: [], error: null };

  const body: Record<string, unknown> = {};
  for (const w of plan.writes) body[w.apiName] = w.newValue;

  const { token, instanceUrl } = await getSalesforceClient();
  const res = await fetch(`${instanceUrl}/services/data/${API_VERSION}/sobjects/Account/${plan.accountId}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { written: [], error: `PATCH ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}` };
  }
  return { written: plan.writes.map((w) => w.apiName), error: null };
}
