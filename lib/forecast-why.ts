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

/**
 * How recently a call must have happened for a close-date push to be plausibly
 * informed by it.
 *
 * Fourteen days rather than something tighter, because a rep often updates the
 * CRM well after the conversation that changed their mind. The question this
 * answers is not "did they update promptly", it is "could anything the customer
 * said have caused this", and a fortnight is generous to the rep on purpose:
 * the claim we make when it fails is that NOTHING was learned, which needs to
 * be safe.
 */
const DAYS_A_PUSH_CAN_BE_INFORMED_BY = 14;

/**
 * Two changes closer together than this are one editing session, not two
 * decisions, so the second one's baseline reaches back past the first.
 */
const SAME_SESSION_MS = 2 * 86_400_000;

function joinList(xs: string[]): string {
  if (xs.length === 0) return "";
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

function capitalise(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/**
 * A gap phrased as what the deal NEEDS, not as what it lacks.
 *
 * criticalGapsOpen states absences ("no executive or economic buyer engaged"),
 * which is right where it is listing what is missing and wrong the moment a
 * sentence says "the new date still needs ...". That rendered as "still needs no
 * executive or economic buyer engaged", which is not English and, worse, says
 * the opposite of what is meant.
 */
function asRequirement(gap: string): string {
  const g = gap.replace(/ \(never raised on any call\)/, "");
  if (g.includes("economic buyer")) return "an economic buyer on a call";
  if (g.includes("budget")) return "a budget";
  if (g.includes("decision process")) return "a mapped decision process";
  if (g.includes("close date")) return "a date the customer agrees to";
  if (g.includes("competitor")) return "a named competitor";
  return g;
}

export type ForecastChange = {
  dealId: string;
  /**
   * When the same field last changed on this opportunity, if it has before.
   *
   * The window this opens is the whole point of the section: it lets us report
   * what happened on the deal BETWEEN the last time the rep set this value and
   * the time they changed it, without ever guessing why they changed it.
   */
  previousChangeAt?: string | null;
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

/**
 * Several deals closed by one person in one sitting.
 *
 * Not a property of any single deal, so it cannot be computed inside
 * evidenceFor and is passed in.
 */
type LossBatch = { count: number; spanMinutes: number };

/**
 * How close together two closes must be to be the same sitting.
 *
 * Fifteen minutes rather than the ninety seconds the known sweep actually
 * took, because a person working through a list pauses. The threshold only has
 * to separate "working a list" from "two deals died this week".
 */
const SWEEP_WINDOW_MIN = 15;

/** Below this it is a coincidence, not a sweep. */
const SWEEP_MIN_DEALS = 3;

/**
 * Group Closed Lost changes into sittings, keyed by the change that belongs to
 * each. Grouped per ACTOR: two managers closing deals the same afternoon are
 * two events, not one.
 */
function detectLossBatches(
  staged: ReadonlyArray<Omit<ForecastChange, "headline" | "evidence">>,
): Map<Omit<ForecastChange, "headline" | "evidence">, LossBatch> {
  const out = new Map<Omit<ForecastChange, "headline" | "evidence">, LossBatch>();
  const losses = staged.filter((c) => c.field === "StageName" && /closed lost/i.test(c.to ?? ""));
  const byActor = new Map<string, typeof losses>();
  for (const l of losses) (byActor.get(l.actor) ?? byActor.set(l.actor, []).get(l.actor)!).push(l);

  for (const list of byActor.values()) {
    const ordered = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    let run: typeof ordered = [];
    const flush = () => {
      // One deal can carry several StageName rows; the sweep is about how many
      // distinct DEALS were closed, not how many rows were written.
      const deals = new Set(run.map((r) => r.dealId));
      if (deals.size >= SWEEP_MIN_DEALS) {
        const span = Math.max(
          1,
          Math.round((Date.parse(run[run.length - 1].at) - Date.parse(run[0].at)) / 60_000),
        );
        for (const r of run) out.set(r, { count: deals.size, spanMinutes: span });
      }
      run = [];
    };
    for (const l of ordered) {
      if (run.length === 0) {
        run = [l];
        continue;
      }
      const gapMin = (Date.parse(l.at) - Date.parse(run[run.length - 1].at)) / 60_000;
      if (gapMin <= SWEEP_WINDOW_MIN) run.push(l);
      else {
        flush();
        run = [l];
      }
    }
    flush();
  }
  return out;
}

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
  batch: LossBatch | null,
): ForecastChange["evidence"] {
  if (c.field === "CloseDate") {
    // WE DO NOT KNOW WHY THE REP MOVED THE DATE, and we must not pretend to.
    //
    // Three earlier versions of this got that wrong in escalating ways. The
    // first asserted "no call has ever validated a close date", true on most of
    // the book and therefore background rather than a reason. The second added
    // Magaya's push base rate, which describes the population and gives a
    // leader nothing to coach. The third assembled buyer signals and presented
    // them AS the reason, which is the worst of the three: it reads as
    // causation and DealRipe cannot see inside a rep's head.
    //
    // What is knowable, exactly, is what happened on the deal BETWEEN the last
    // time this date was set and the moment it moved. Stating that and stopping
    // is unbiased, is sourced entirely from records, and is usually more
    // damning than any guess: the common answer is that nothing happened at all.
    // A leader reads "nothing changed since the last date was set" and draws
    // their own conclusion, which is theirs to draw.
    const since = c.previousChangeAt ? Date.parse(c.previousChangeAt) : null;
    const now = Date.now();

    const callDays = s.daysSinceLastCall.status === "read" ? s.daysSinceLastCall.value : null;
    const custDays = s.daysSinceCustomerReply.status === "read" ? s.daysSinceCustomerReply.value : null;
    const booked = s.nextMeetingBooked.status === "read" ? s.nextMeetingBooked.value : null;
    const waiting = s.awaitingReply.status === "read" && s.awaitingReply.value;
    const waitedDays = s.daysSinceOurMessage.status === "read" ? s.daysSinceOurMessage.value : null;

    // A signal falls INSIDE the window when it is more recent than the previous
    // change. Null `since` means this is the first recorded change, so there is
    // no window and we say so rather than inventing one.
    const inWindow = (days: number | null): boolean | null => {
      if (days === null || since === null) return null;
      return now - days * 86_400_000 >= since;
    };

    const happened: string[] = [];
    const didNot: string[] = [];

    const spoke = inWindow(callDays);
    if (spoke === true) happened.push(`a call ${callDays} days ago`);
    else if (spoke === false) didNot.push("no conversation");

    const wrote = inWindow(custDays);
    if (wrote === true) happened.push(`the customer wrote ${custDays} days ago`);
    else if (wrote === false) didNot.push("no message from the customer");

    if (booked === false) didNot.push("nothing booked since");
    if (waiting && waitedDays !== null && waitedDays >= 5) {
      didNot.push(`our message of ${waitedDays} days ago still unanswered`);
    }

    if (since === null) {
      return {
        verdict: "no_evidence",
        text: "first recorded change to this date, so there is no previous setting to measure against",
      };
    }

    const windowDays = Math.max(1, Math.round((Date.parse(c.at) - since) / 86_400_000));
    const window = `${windowDays} day${windowDays === 1 ? "" : "s"}`;

    if (happened.length === 0) {
      return {
        verdict: "contradicts",
        text: `nothing happened on this deal in the ${window} between the last date being set and this one: ${joinList(didNot)}`,
      };
    }
    if (didNot.length === 0) {
      return {
        verdict: "supports",
        text: `in the ${window} since the last date was set: ${joinList(happened)}`,
      };
    }
    return {
      verdict: "no_evidence",
      text: `in the ${window} since the last date was set: ${joinList(happened)}, but ${joinList(didNot)}`,
    };
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
      // A REP MARKING A DEAL LOST IS USUALLY TELLING THE TRUTH, so this agrees
      // by default and the burden is on disagreeing. Optimism runs the other
      // way: reps inflate bands and push dates, they do not invent losses,
      // because a loss is a costly admission and it comes out of their number.
      //
      // Two things are still worth saying, and both are cheap to be wrong
      // about in the safe direction.

      // ONE: the buyer had not actually gone anywhere. A deal closed while a
      // meeting is on the calendar or the customer wrote days ago is a rep or a
      // manager giving up on something still live, and it is the only shape of
      // premature loss worth interrupting a CRO for.
      const next = s.nextMeetingBooked;
      const mailDays = s.daysSinceCustomerReply.status === "read" ? s.daysSinceCustomerReply.value : null;
      if (next.status === "read" && next.value) {
        return { verdict: "contradicts", text: `closed lost while ${next.evidence}` };
      }
      if (mailDays !== null && mailDays <= 7) {
        return {
          verdict: "contradicts",
          text: `closed lost, and the customer wrote ${mailDays} day(s) ago. Worth asking before this counts as a loss.`,
        };
      }

      // TWO: this is one of several closed at once, which is a fact about the
      // DATA rather than about the deal.
      //
      // Already learned here the expensive way and never detected automatically
      // until now: Mitch Nemmers closed Dpworld, GUYWBD, Air Americas and
      // Extrum within 90 seconds of each other at 2026-08-07T18:28, and
      // Successchb on 08-11, every one reason No Decision / Non-Responsive.
      // That is a VP running a hygiene sweep over deals that went dark, not
      // five competitive losses. Read as five, DealRipe-observed deals appear
      // to lose at 71% against Magaya's 77% historical win rate. Both figures
      // are noise, and the learning loop must count the sweep once.
      const days = s.daysSinceLastCall.status === "read" ? s.daysSinceLastCall.value : null;
      if (batch && batch.count >= 3) {
        return {
          verdict: "supports",
          text:
            `one of ${batch.count} deals ${c.actor} closed within ${batch.spanMinutes} minute(s). ` +
            `That is a hygiene sweep rather than ${batch.count} separate losses, and it should count once.`,
        };
      }
      return days === null
        ? { verdict: "no_evidence", text: "no captured call on this deal, so nothing here confirms or questions the loss" }
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
      previousChangeAt: null,
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

  // Fill in each change's predecessor on the same opportunity and field. The
  // rows arrive newest-first, so the NEXT matching row is the previous change.
  // A BASELINE HAS TO BE FAR ENOUGH BACK TO MEAN SOMETHING.
  //
  // A rep correcting a date twice in one sitting produces two rows minutes
  // apart, and taking the nearer one as the baseline yields "nothing happened
  // in the 1 days between the last date being set and this one", which is both
  // meaningless and slightly absurd. Fmgloballogistics did exactly that.
  //
  // Same rule as detectLossBatches: consecutive edits inside one session are
  // one action, so the baseline skips back past them to the last time this
  // value was genuinely settled.
  const seenKey = new Map<string, Array<Omit<ForecastChange, "headline" | "evidence">>>();
  for (const c of staged) {
    const key = `${c.dealId}:${c.field}`;
    (seenKey.get(key) ?? seenKey.set(key, []).get(key)!).push(c);
  }
  for (const list of seenKey.values()) {
    // Newest first, as the SOQL returned them.
    for (let i = 0; i < list.length; i++) {
      const at = Date.parse(list[i].at);
      let j = i + 1;
      while (j < list.length && at - Date.parse(list[j].at) < SAME_SESSION_MS) j += 1;
      list[i].previousChangeAt = j < list.length ? list[j].at : null;
    }
  }

  const batches = detectLossBatches(staged);
  const changes: ForecastChange[] = staged.map((c) => {
    const sig = signalsByDeal.get(c.dealId);
    return {
      ...c,
      headline: headlineOf(c),
      evidence: sig
        ? evidenceFor(c, sig.signals, sig.flags, batches.get(c) ?? null)
        : { verdict: "no_evidence" as const, text: "the deal's signals could not be computed" },
    };
  });

  // Weakening first, then most recent. A CRO opening this wants the reason the
  // number went down, and wants it before anything else on the page.
  const weight = { weakens: 0, neutral: 1, strengthens: 2 };
  changes.sort((a, b) => weight[a.direction] - weight[b.direction] || Date.parse(b.at) - Date.parse(a.at));

  return { changes, unattributed, window: { sinceIso: args.sinceIso, untilIso }, unavailable: null };
}
