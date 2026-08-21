/**
 * WHY the forecast changed, with a name on it.
 *
 * Dean Hickman-Smith, CRO at Testlio, 2026-08-20, describing what every
 * forecast dashboard fails at:
 *
 *   "What dashboards are very bad at is looking at the WHY things are
 *    changing. It gives you a snapshot of now, a snapshot of yesterday. It
 *    doesn't call out: the reason the forecast is weakened in North America is
 *    because Jared pulled this deal into Q4, and the reason he did that was
 *    because of this, this and this."
 *
 * He then described losing two good deals overnight, opening Salesforce after
 * two days on the road, and having to phone people to discover that a rep had
 * moved a deal to Q4 for CRM hygiene while the VP still believed it would land
 * in Q3. The CRO's board commit included that deal.
 *
 * Salesforce holds every fact needed to have told him, and no view assembles
 * them: OpportunityFieldHistory carries the field, the old and new values, the
 * timestamp AND CreatedBy, so "who moved it" has always been one column away.
 *
 * WHAT THIS ADDS THAT THE HISTORY ALONE DOES NOT
 *
 * The history says a close date moved. It cannot say whether the move was
 * honest. DealRipe can, because it has the calls: a date pushed on a deal where
 * no close date was ever validated with the customer is a different event from
 * one pushed after the customer named a new date out loud. Every row here
 * carries the change AND what the calls say about it, which is the whole
 * difference between a changelog and a reason.
 *
 * SCOPE
 *
 * Only deals DealRipe tracks, joined by salesforce_account_id at `confirmed`.
 * A change on an account we cannot attribute to a deal is not reported as a
 * change with no deal; it is not reported at all, and the count of what was
 * skipped is returned so a reader knows the difference.
 */

import { computeDealFlags, type Flag } from "./deal-flags";
import { assessDeal, computeBuyerSignals, type BuyerSignals } from "./deal-signals-buyer";
import { getSalesforceClient } from "./salesforce";
import { runWithAuthorizedAccounts } from "./salesforce-scope";
import { supabaseAdmin } from "./supabase";

const API = "v60.0";

/** The four fields that move a forecast. Nothing else is worth waking a CRO for. */
const WATCHED = ["CloseDate", "StageName", "ForecastCategoryName", "Amount"] as const;
type WatchedField = (typeof WATCHED)[number];

const FIELD_LABEL: Record<WatchedField, string> = {
  CloseDate: "close date",
  StageName: "stage",
  ForecastCategoryName: "forecast band",
  Amount: "amount",
};

const BAND_RANK: Record<string, number> = { Omitted: 0, Pipeline: 1, Expect: 2, Commit: 3 };

export type ForecastChange = {
  dealId: string;
  account: string;
  /** The person who made the change, from CreatedBy.Name. The point of this
   *  module: a change with no name on it is a weather report. */
  actor: string;
  at: string;
  field: WatchedField;
  fieldLabel: string;
  from: string | null;
  to: string | null;
  /** Which way this moves the number the CRO carries. */
  direction: "weakens" | "strengthens" | "neutral";
  /** One line: what the change was, in a leader's words. */
  headline: string;
  /**
   * What the CALLS say about this change, or why we cannot say.
   *
   * Three-way, because "the evidence contradicts this" and "we have no
   * evidence" must never render as the same sentence. That distinction is the
   * whole reason this codebase exists.
   */
  evidence:
    | { verdict: "supports"; text: string }
    | { verdict: "contradicts"; text: string }
    | { verdict: "no_evidence"; text: string };
};

export type ForecastWhy = {
  changes: ForecastChange[];
  /** Salesforce changes on accounts we could not map to a tracked deal. Counted
   *  rather than dropped, so a short list is legible as short rather than
   *  as complete. */
  unattributed: number;
  window: { sinceIso: string; untilIso: string };
  /** Set when Salesforce could not be read at all. An empty `changes` with this
   *  null means nothing moved; with this set it means we did not look. */
  unavailable: string | null;
};

type HistoryRow = {
  OpportunityId: string;
  Field: string;
  OldValue: unknown;
  NewValue: unknown;
  CreatedDate: string;
  CreatedBy?: { Name?: string } | null;
  Opportunity?: { AccountId?: string; Name?: string } | null;
};

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

/** Does this move the CRO's number up or down. */
function directionOf(field: WatchedField, from: string | null, to: string | null): ForecastChange["direction"] {
  if (field === "CloseDate") {
    if (!from || !to) return "neutral";
    const a = Date.parse(from);
    const b = Date.parse(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "neutral";
    return b > a ? "weakens" : b < a ? "strengthens" : "neutral";
  }
  if (field === "ForecastCategoryName") {
    const a = BAND_RANK[from ?? ""] ?? null;
    const b = BAND_RANK[to ?? ""] ?? null;
    if (a === null || b === null) return "neutral";
    return b < a ? "weakens" : b > a ? "strengthens" : "neutral";
  }
  if (field === "Amount") {
    const a = Number(from);
    const b = Number(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return "neutral";
    return b < a ? "weakens" : b > a ? "strengthens" : "neutral";
  }
  // Stage: only a close is unambiguous. A forward stage move is not
  // automatically good news, and saying so would be the optimism this whole
  // read exists to strip out.
  if (/closed lost/i.test(to ?? "")) return "weakens";
  if (/closed won/i.test(to ?? "")) return "strengthens";
  return "neutral";
}

function headlineOf(c: Omit<ForecastChange, "headline" | "evidence">): string {
  const days =
    c.field === "CloseDate" && c.from && c.to
      ? Math.round((Date.parse(c.to) - Date.parse(c.from)) / 86_400_000)
      : null;
  if (c.field === "CloseDate" && days !== null) {
    return days >= 0
      ? `${c.actor} pushed the close date out ${days} days, ${c.from} to ${c.to}`
      : `${c.actor} pulled the close date in ${Math.abs(days)} days, ${c.from} to ${c.to}`;
  }
  if (c.field === "Amount") {
    return `${c.actor} changed the amount from ${c.from ?? "blank"} to ${c.to ?? "blank"}`;
  }
  return `${c.actor} moved the ${c.fieldLabel} from ${c.from ?? "blank"} to ${c.to ?? "blank"}`;
}

/**
 * What the calls say about this specific change.
 *
 * Each branch answers a question a leader would actually ask on seeing the
 * change, and each returns `no_evidence` rather than a guess when the signal
 * could not be read. A confident sentence built on an unread signal is the
 * failure mode this project is named after.
 */
function evidenceFor(
  c: Omit<ForecastChange, "headline" | "evidence">,
  s: BuyerSignals,
  flags: Flag[],
): ForecastChange["evidence"] {
  if (c.field === "CloseDate") {
    const gaps = s.criticalGapsOpen;
    if (gaps.status !== "read") {
      return { verdict: "no_evidence", text: `no captured call to check the date against (${gaps.reason})` };
    }
    const dateNeverSet = gaps.value.some((g) => g.includes("close date"));
    const slips = s.closeDateSlips.status === "read" ? s.closeDateSlips.value : null;
    if (dateNeverSet) {
      return {
        verdict: "contradicts",
        text:
          `no call has ever validated a close date with this customer` +
          (slips !== null && slips >= 2 ? `, and this is push number ${slips + 1}` : "") +
          `. The new date is the rep's estimate, not the customer's.`,
      };
    }
    return { verdict: "supports", text: "the calls did establish a date with the customer, so this is a real revision" };
  }

  if (c.field === "ForecastCategoryName") {
    if (c.direction === "strengthens") {
      const buyer = s.economicBuyerEngaged;
      if (buyer.status !== "read") return { verdict: "no_evidence", text: `could not check who has been on the calls (${buyer.reason})` };
      if (!buyer.value) {
        return { verdict: "contradicts", text: `raised to ${c.to} and ${buyer.evidence}` };
      }
      return { verdict: "supports", text: `raised to ${c.to}, and ${buyer.evidence}` };
    }
    if (c.direction === "weakens") {
      // The Jared case exactly. A band dropped on a deal the buyer is still
      // engaged with is hygiene, not a real loss of confidence, and the CRO's
      // number just moved for a reason nobody wrote down.
      const stalling = flags.some((f) => f.id === "losing_momentum");
      if (stalling) {
        return { verdict: "supports", text: "the buyer has gone quiet, so the downgrade matches what the calls show" };
      }
      const next = s.nextMeetingBooked;
      if (next.status === "read" && next.value) {
        return {
          verdict: "contradicts",
          text: `dropped to ${c.to} while ${next.evidence}. Worth asking whether this is CRM hygiene rather than a real change in confidence.`,
        };
      }
      return { verdict: "no_evidence", text: "nothing in the calls explains the downgrade either way" };
    }
    return { verdict: "no_evidence", text: "band moved sideways" };
  }

  if (c.field === "StageName") {
    if (/closed lost/i.test(c.to ?? "")) {
      const days = s.daysSinceLastCall.status === "read" ? s.daysSinceLastCall.value : null;
      return days === null
        ? { verdict: "no_evidence", text: "no captured call on this deal" }
        : { verdict: "supports", text: `last captured conversation was ${days} days ago` };
    }
    // A WON deal is not something to disagree with. The first version fell
    // through to the gates branch and told a leader DealRipe DISAGREES with
    // Speed International closing won because five qualification gates were
    // still open. The gates being open on a won deal is a fact about our
    // extraction coverage, not about the deal.
    if (/closed won/i.test(c.to ?? "")) {
      const gaps = s.criticalGapsOpen;
      const open = gaps.status === "read" ? gaps.value.length : null;
      return {
        verdict: "supports",
        text:
          open && open > 0
            ? `won with ${open} gate(s) never established on a call, which is worth knowing about how this one was sold`
            : "won",
      };
    }
    const gaps = s.criticalGapsOpen;
    if (gaps.status !== "read") return { verdict: "no_evidence", text: "no captured call to check the stage against" };
    return gaps.value.length > 0
      ? { verdict: "contradicts", text: `advanced with ${gaps.value.length} qualification gate(s) still open` }
      : { verdict: "supports", text: "the decisive gates are settled on the calls" };
  }

  // AMOUNT, and the rule that stopped this section overclaiming.
  //
  // Open gates are not a contradiction of an amount. The first version said
  // "DealRipe DISAGREES: 5 qualification gates are still open" about a rep
  // typing a number into a blank field, which is not disagreement, it is
  // context wearing a verdict's clothes. A section whose verdicts are wrong is
  // worse than one with no verdicts, because a leader argues with it once and
  // then stops reading it.
  //
  // Only one amount change is genuinely checkable: a number moving on a deal
  // where no call ever established a budget.
  const gaps = s.criticalGapsOpen;
  if (gaps.status !== "read") return { verdict: "no_evidence", text: "no captured call to check against" };
  const noBudget = gaps.value.some((g) => g.includes("budget"));
  if (c.field === "Amount" && noBudget) {
    return {
      verdict: "contradicts",
      text: `no call has established a budget with this customer, so this figure is ours rather than theirs`,
    };
  }
  return gaps.value.length > 0
    ? { verdict: "no_evidence", text: `nothing on the calls speaks to this. ${gaps.value.length} gate(s) remain open on the deal` }
    : { verdict: "supports", text: "the decisive gates are settled on the calls" };
}

/**
 * Every forecast-moving change in the window, attributed and judged.
 *
 * Reads through runWithAuthorizedAccounts like every other Salesforce read, so
 * an account outside the pilot throws rather than silently widening scope.
 */
export async function getForecastWhy(args: {
  tenantId: string;
  sinceIso: string;
  untilIso?: string;
}): Promise<ForecastWhy> {
  const untilIso = args.untilIso ?? new Date().toISOString();
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, salesforce_account_id, salesforce_link_confidence, outcome_label")
    .eq("tenant_id", args.tenantId);
  if (dealsRes.error) {
    return { changes: [], unattributed: 0, window: { sinceIso: args.sinceIso, untilIso }, unavailable: dealsRes.error.message };
  }

  const byAccount = new Map<string, { id: string; account: string }>();
  for (const d of (dealsRes.data ?? []) as Array<{
    id: string;
    account: string;
    salesforce_account_id: string | null;
    salesforce_link_confidence: string | null;
  }>) {
    if (d.salesforce_link_confidence === "confirmed" && d.salesforce_account_id) {
      // First deal wins. Two deals on one account is rare and picking either is
      // better than reporting the change twice.
      if (!byAccount.has(d.salesforce_account_id)) byAccount.set(d.salesforce_account_id, { id: d.id, account: d.account });
    }
  }
  const accountIds = [...byAccount.keys()];
  if (accountIds.length === 0) {
    return { changes: [], unattributed: 0, window: { sinceIso: args.sinceIso, untilIso }, unavailable: null };
  }

  let rows: HistoryRow[] = [];
  try {
    const { token, instanceUrl } = await getSalesforceClient();
    rows = await runWithAuthorizedAccounts(accountIds, async () => {
      const out: HistoryRow[] = [];
      // Chunked: a SOQL IN list has a practical ceiling and the pilot is
      // already past it at 90-odd accounts.
      for (let i = 0; i < accountIds.length; i += 60) {
        const chunk = accountIds.slice(i, i + 60);
        const inList = chunk.map((a) => `'${a.replace(/'/g, "")}'`).join(",");
        const soql =
          `SELECT OpportunityId, Opportunity.AccountId, Opportunity.Name, Field, OldValue, NewValue, ` +
          `CreatedDate, CreatedBy.Name FROM OpportunityFieldHistory ` +
          `WHERE Field IN (${WATCHED.map((f) => `'${f}'`).join(",")}) ` +
          `AND CreatedDate >= ${args.sinceIso} AND CreatedDate <= ${untilIso} ` +
          `AND Opportunity.AccountId IN (${inList}) ORDER BY CreatedDate DESC`;
        const r = await fetch(`${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) throw new Error(`field history ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
        out.push(...(((await r.json()) as { records?: HistoryRow[] }).records ?? []));
      }
      return out;
    });
  } catch (err) {
    return {
      changes: [],
      unattributed: 0,
      window: { sinceIso: args.sinceIso, untilIso },
      unavailable: err instanceof Error ? err.message : String(err),
    };
  }

  let unattributed = 0;
  const staged: Array<Omit<ForecastChange, "headline" | "evidence">> = [];
  for (const row of rows) {
    const acct = row.Opportunity?.AccountId;
    const deal = acct ? byAccount.get(acct) : undefined;
    if (!deal) {
      unattributed += 1;
      continue;
    }
    const field = row.Field as WatchedField;
    if (!WATCHED.includes(field)) continue;
    const from = str(row.OldValue);
    const to = str(row.NewValue);
    // A "change" with neither end is a Salesforce artifact, not an event.
    if (from === null && to === null) continue;
    staged.push({
      dealId: deal.id,
      account: deal.account,
      actor: row.CreatedBy?.Name ?? "someone",
      at: row.CreatedDate,
      field,
      fieldLabel: FIELD_LABEL[field],
      from,
      to,
      direction: directionOf(field, from, to),
    });
  }

  // Signals are computed ONCE per deal, not once per change. A rep doing a
  // hygiene pass produces four changes on one deal in ninety seconds.
  const signalsByDeal = new Map<string, { signals: BuyerSignals; flags: Flag[] }>();
  for (const dealId of new Set(staged.map((c) => c.dealId))) {
    try {
      const signals = await computeBuyerSignals({ tenantId: args.tenantId, dealId });
      signalsByDeal.set(dealId, { signals, flags: computeDealFlags({ signals, assessment: assessDeal(signals) }) });
    } catch {
      // Left absent, which evidenceFor reports as no_evidence rather than as
      // agreement.
    }
  }

  const changes: ForecastChange[] = staged.map((c) => {
    const sig = signalsByDeal.get(c.dealId);
    return {
      ...c,
      headline: headlineOf(c),
      evidence: sig
        ? evidenceFor(c, sig.signals, sig.flags)
        : { verdict: "no_evidence" as const, text: "the deal's signals could not be computed" },
    };
  });

  // Weakening first, then most recent. A CRO opening this wants the reason the
  // number went down, and wants it before anything else on the page.
  const weight = { weakens: 0, neutral: 1, strengthens: 2 };
  changes.sort((a, b) => weight[a.direction] - weight[b.direction] || Date.parse(b.at) - Date.parse(a.at));

  return { changes, unattributed, window: { sinceIso: args.sinceIso, untilIso }, unavailable: null };
}
