/**
 * Canonical per-deal context, the single source of truth every generator should
 * read (pre-call briefing, recap, weekly digest, forecast, the deal-state card).
 *
 * Source hierarchy, deliberate:
 *   1. Calls are the primary, unbiased truth. field_extractions holds the
 *      call-verified qualification; that IS the current truth.
 *   2. Rolldog is a baseline + cross-check, never an overwrite. It provides the
 *      day-0 seed and a CRM stage we treat as a floor, not the driver.
 *   3. The effective stage is calls-first: the furthest stage the calls confirm,
 *      falling back to the CRM/nominal stage only when the calls are silent.
 *
 * So a deal with no Rolldog opportunity (or a stale one) is qualified entirely
 * from what was said on calls, which is exactly what we want.
 */

import { attendeesFrom } from "./generate-briefing";
import { deriveDealState, inferStageKey, type DealStateGap } from "./deal-state";
import type { ExtractionMap } from "./briefing-magaya";
import { getFrameworkForDeal, type Framework } from "./framework";
import { runWithAuthorizedOpportunities } from "./crm-scope";
import { isFreeMailDomain, rolldogOppIdForDeal } from "./pilot-config";
import { resolveSalesforceSnapshots } from "./salesforce-stage";
import { accountContextLines, loadAccountContext, resolveAccount } from "./salesforce-context";
import { readRolldogSummary, stageKeyFromSummary } from "./rolldog-summary";
import { buildBriefingHistory } from "./briefing-history";
import { buildRolldogNarrative } from "./rolldog-narrative";
import { getStageGateSummary, stageGateLines, type StageGateSummary } from "./stage-gates";
import type { ExtractionResult } from "./scotsman";
import type { Contact } from "./seed-data";
import { getDealForTenant } from "./supabase-queries";
import { supabaseAdmin } from "./supabase";

const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled", "placeholder", "capture_failed"]);

/**
 * How old a Rolldog opportunity can be before its Salesforce intake notes stop
 * being worth briefing from. Roughly one sales cycle: past this the BDR wrote
 * about a situation the calls have long since overtaken.
 */
const BDR_CONTEXT_MAX_OPP_AGE_DAYS = 60;

export type DealContext = {
  dealId: string;
  externalId: string | null;
  account: string;
  framework: Framework;
  /** Call-verified qualification: the current truth. */
  extraction: ExtractionResult;
  /** Stage from the deal row / seed (may be a default like SQL0). */
  nominalStageKey: string;
  /** Stage from Rolldog, if the deal has an opportunity. Null otherwise. */
  crmStageKey: string | null;
  /**
   * Why crmStageKey is what it is. Same reasoning as crmContextStatus: a null
   * stage because the deal has no opportunity and a null stage because Rolldog
   * would not answer are opposite facts that produced the same briefing.
   */
  crmStageStatus:
    /** Rolldog answered and the stage name parsed. */
    | "present"
    /** Rolldog answered but its stage name carries no recognizable SQL number. */
    | "unparsed"
    /** The deal has no Rolldog opportunity to read a stage from. */
    | "no_opportunity"
    /** The read failed. We do not know this deal's CRM stage. */
    | "unavailable";
  /** The stage to qualify/brief against: calls-first, CRM as fallback floor. */
  effectiveStageKey: string;
  confirmed: number;
  total: number;
  reachedStageKey: string | null;
  topGaps: DealStateGap[];
  nextStepAnswer: string | null;
  closeDate: string | null;
  /** Attendee string derived from contacts, for briefing headers. */
  attendees: string;
  contacts: Contact[];
  /** Most recent captured call date (real DealRipe activity). */
  lastCallDate: string | null;
  /**
   * Meetings on this deal that were SCHEDULED and that DealRipe could not
   * capture. Not no-shows: as far as we know these conversations happened and
   * we have no record of them.
   *
   * Without this a briefing says "first conversation DealRipe has data on" and
   * the rep reads "first conversation", which on 2026-08-24 was wrong for
   * Ativzla: Ariel had a meeting with the same roster on 08-20 that died in a
   * Teams lobby. The gaps in that briefing were unknown, not unasked, and those
   * are opposite instructions to give a rep walking into a room.
   */
  uncapturedCalls: Array<{ date: string; reason: string }>;
  /**
   * Salesforce Sales Development context, rendered for the briefing prompt.
   *
   * Present while we have no captured calls of our own, whatever the CRM says.
   * Null once we have heard the customer ourselves, because their words beat a
   * colleague's summary. Old intake notes carry an age caveat rather than being
   * withheld: thin context is worse than dated context when we hold nothing.
   */
  crmContext: string | null;
  /**
   * Why crmContext is what it is.
   *
   * "absent" and "unavailable" both produce a null crmContext and a thinner
   * briefing, but they mean opposite things: one is a company genuinely not in
   * Salesforce, the other is a lookup that failed. Collapsing them is what let
   * four briefings quietly lose their BDR context between two runs with no code
   * change and nothing in the logs. Callers that can retry or warn should.
   */
  crmContextStatus:
    | "present"
    /** An account matched but its Sales Development fields are all empty. */
    | "empty"
    /** No Salesforce account matched this domain at all. */
    | "no_account"
    | "unavailable"
    /** Skipped because the customer's own words already beat a colleague's notes. */
    | "have_own_calls"
    /** Skipped because there is no company domain to resolve (consumer mail). */
    | "no_company_domain"
    /**
     * Reached only by company name, not by email domain.
     *
     * This is the Gezairi case. The invite carried manele.khoury@gmail.com and
     * nothing else, the free-mail guard correctly refused to match %@gmail.com,
     * and the account named "Gezairi" was found by name instead. The context is
     * real and worth briefing from, and the briefing says how it was reached so
     * a rep can discount it if the match looks wrong.
     */
    | "present_by_name"
    /** Several accounts matched the name. We refuse to pick; a human does. */
    | "ambiguous";
  /**
   * The rep's own stage checklist from Rolldog, and how it compares to what the
   * calls confirm. Null when the deal has no opportunity or the read failed;
   * an unreadable checklist must never render as an empty one.
   */
  stageGates: StageGateSummary | null;
  /**
   * Why stageGates is what it is.
   *
   * A deal with no opportunity, a deal whose opportunity carries no checklist,
   * and a checklist read that failed all arrive as null. Only the last is a
   * problem, and it is the one that briefs a deal with three stages ticked as
   * though no work had been done on it.
   */
  stageGatesStatus: "present" | "no_opportunity" | "no_checklist" | "unavailable";
  /**
   * Contacts on the matched Salesforce account, for putting a real name and
   * title against a calendar attendee. Empty when no account matched.
   */
  crmContacts: Array<{ name: string; title: string | null; email: string | null }>;
  /**
   * What the last calls established, what we still owe, and what we asked for
   * and did not get. Null on a genuinely first conversation.
   */
  history: string | null;
  /**
   * What the rep wrote in Rolldog's Situation, Timeline, Budget, Competition
   * and People tabs. Their own account of the deal, which outranks a BDR intake
   * form and is where recorded concerns actually live. Null when the deal has
   * no opportunity, the rep has written nothing, or the read failed.
   */
  rolldogNarrative: string | null;
};

export async function getDealContext(
  tenantId: string,
  dealId: string,
  opts?: {
    /**
     * Treat this instant as "now" when assembling prior-call history.
     *
     * Briefings leave this unset: they run before a call, so every call so far
     * is every call before this one. Recaps set it to the call's own start, so
     * a recap for an older call cannot cite a later one as history.
     */
    asOf?: string | null;
  },
): Promise<DealContext | null> {
  const deal = await getDealForTenant(tenantId, dealId);
  if (!deal) return null;
  const framework = await getFrameworkForDeal(dealId);
  if (!framework) return null;

  const extraction = deal.extraction as ExtractionResult;
  const db = supabaseAdmin();

  // External id (for the Rolldog mapping) + most recent captured call.
  const row = await db
    .from("deals")
    .select("external_id, rolldog_opportunity_id")
    .eq("id", dealId)
    .maybeSingle();
  const externalId = row.data?.external_id ?? null;

  // Rolldog stage is a cross-check/floor, best-effort. Never drives the truth.
  //
  // Consult the LINKED opportunity first. Reading only the static pilot map
  // meant every deal linked by the reconciler stayed invisible: GHY sat at
  // SQL3 Proposal Validation and was briefed as a first touchpoint, and TOC at
  // SQL2 was briefed as an opening discovery call, because the stage never
  // reached the prompt. The map is now the fallback, not the only source.
  let crmStageKey: string | null = null;
  const opp =
    row.data?.rolldog_opportunity_id ??
    (externalId ? rolldogOppIdForDeal(externalId) : null) ??
    null;
  let oppCreatedAt: string | null = null;

  // The rep's checklist. Independent of the summary read below, and deliberately
  // fetched even when that one fails: they answer different questions and one
  // being unavailable is no reason to discard the other.
  let stageGates: StageGateSummary | null = null;
  let stageGatesStatus: DealContext["stageGatesStatus"] = opp ? "unavailable" : "no_opportunity";
  if (opp) {
    try {
      stageGates = await getStageGateSummary(opp, extraction as unknown as ExtractionMap);
      // getStageRequirements returns null only on a 404, and throws on every
      // other failure. So a null that got here is Rolldog saying this
      // opportunity genuinely has no checklist, which is an answer.
      stageGatesStatus = stageGates ? "present" : "no_checklist";
    } catch (err) {
      console.warn(
        `[deal-context] stage-gate read failed for opportunity ${opp}, briefing will not see the rep's checklist: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let crmStageStatus: DealContext["crmStageStatus"] = opp ? "unavailable" : "no_opportunity";
  /** The close date the CRM holds right now, as opposed to the cached column. */
  let liveCloseDate: string | null = null;
  if (opp) {
    try {
      // Authorize this one opportunity for the duration of the read. The scope
      // guard is fail-closed and only the static pilot ids pass by default, so
      // without this every opportunity the reconciler linked throws and the
      // deal briefs as though it has no CRM record at all. The wrapper is
      // per-call and per-opportunity: nothing else becomes readable.
      const read = await runWithAuthorizedOpportunities([opp], () => readRolldogSummary(opp));
      if (read.status === "ok") {
        crmStageKey = stageKeyFromSummary(read.summary);
        liveCloseDate = read.summary.closeDate ?? null;
        // Rolldog answered. A null key here is a stage name we could not parse,
        // which is a different thing from Rolldog not answering, and only the
        // second is worth chasing.
        crmStageStatus = crmStageKey ? "present" : "unparsed";
      } else {
        console.warn(
          `[deal-context] Rolldog summary read failed for opportunity ${opp}, briefing will not see this deal's CRM stage: ${read.error}`,
        );
      }
      // A failed read leaves the age unknown, which is correct: it falls
      // through to "no opportunity age", and the BDR-notes test below then
      // depends only on whether we have our own calls, which is the safer
      // default when Rolldog is unreadable.
      oppCreatedAt = read.summary?.createdAt ?? null;
    } catch (err) {
      // The scope guard, not the network. readRolldogSummary catches its own
      // read failures, so anything arriving here is authorization refusing the
      // opportunity, and "unavailable" is the honest label for it.
      console.warn(
        `[deal-context] Rolldog summary read blocked for opportunity ${opp}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Salesforce answers for the deals with no Rolldog opportunity, which at this
  // stage of the pilot is most of them. One extra round trip, and only on the
  // deals where Rolldog gave us nothing, so a Rolldog deal pays nothing for it.
  if (!liveCloseDate) {
    try {
      const snaps = await resolveSalesforceSnapshots(tenantId, [dealId]);
      const read = snaps.get(dealId);
      if (read?.status === "read") liveCloseDate = read.snapshot.closeDate ?? null;
    } catch (err) {
      // Falls back to the cached column, which is what it did before. Logged
      // because a briefing quietly carrying a stale date is how this bug began.
      console.warn(
        `[deal-context] Salesforce close-date read failed for ${dealId}, briefing falls back to the cached column: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Prefer the checklist's own current-stage-position over the stage parsed from
  // the opportunity summary. It is the same fact from a more precise source: the
  // checklist states the position numerically, while the summary's stage name
  // has to be pattern-matched, and one of the six stages ("SQL - Develop
  // Opportunity (Qualify)") carries no digit for a pattern to find.
  const effectiveStageKey = inferStageKey(
    framework,
    extraction,
    stageGates?.crmStageKey ?? crmStageKey ?? deal.stageKey,
  );
  const ds = deriveDealState(framework, extraction, effectiveStageKey);

  // Most recent real (non-no-show) captured call.
  let lastCallDate: string | null = null;
  const uncapturedCalls: Array<{ date: string; reason: string }> = [];
  try {
    const nowIso = new Date().toISOString();
    const calls = await db
      .from("calls")
      .select("scheduled_start, call_date, outcome, capture_class")
      .eq("tenant_id", tenantId)
      .eq("deal_id", dealId)
      .lte("scheduled_start", nowIso);
    // Supabase reports failure in the result, not by throwing, so without this
    // a failed query walks straight into the loop over `?? []` and lands as
    // "this deal has never had a call". That is not a thin answer, it is the
    // wrong one, and it also flips the BDR-context branch below.
    if (calls.error) throw new Error(calls.error.message);
    for (const c of calls.data ?? []) {
      // A capture failure is not a no-show. The meeting most likely ran and we
      // were locked out of it, so it is history the rep has and we do not.
      if (c.outcome === "capture_failed") {
        const when = c.scheduled_start ?? c.call_date;
        if (when) uncapturedCalls.push({ date: when, reason: c.capture_class ?? "not captured" });
        continue;
      }
      if (c.outcome && NO_CONTENT.has(c.outcome)) continue;
      const when = c.scheduled_start ?? c.call_date;
      if (when && (!lastCallDate || new Date(when).getTime() > new Date(lastCallDate).getTime())) {
        lastCallDate = when;
      }
    }
  } catch (err) {
    console.warn(
      `[deal-context] call-history read failed for deal ${dealId}, this deal will look like it has never had a call: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // The rep's own notes in Rolldog. getDealRoom has been able to read these for
  // months and nothing ever called it, so deals briefed off a BDR intake form
  // while the rep's account of the same deal sat one call away.
  let rolldogNarrative: string | null = null;
  if (opp) {
    try {
      rolldogNarrative = await buildRolldogNarrative(opp);
    } catch (err) {
      console.warn(
        `[deal-context] Rolldog narrative read failed for opportunity ${opp}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // What happened last time. The recaps read specific and the briefings read
  // vague for one reason: a recap is written with the transcript in hand and the
  // briefing only ever saw a snapshot of the record.
  let history: string | null = null;
  try {
    history = await buildBriefingHistory(tenantId, dealId, { asOf: opts?.asOf ?? null });
  } catch (err) {
    // Best-effort: a thin briefing beats no briefing. But a null history is
    // rendered as a genuinely first conversation, so a failure here does not
    // just omit context, it asserts the opposite of the truth on a deal with
    // months of calls behind it.
    console.warn(
      `[deal-context] history read failed for deal ${dealId}, it will brief as a first conversation: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Salesforce BDR context. Best-effort in the strongest sense: Salesforce
  // being slow or unreachable must never stop a briefing being generated, it
  // just makes it thinner.
  const oppAgeDays =
    oppCreatedAt && Number.isFinite(Date.parse(oppCreatedAt))
      ? (Date.now() - Date.parse(oppCreatedAt)) / 86_400_000
      : null;
  // What supersedes a BDR's notes is OUR OWN CALLS, not the passage of time.
  //
  // An age test was tried and removed: suppressing the notes on opportunities
  // older than sixty days left five of Alexandra's briefings reading "brand new
  // account, zero prior qualification data" for accounts where we held usable
  // intake notes and had captured nothing ourselves. Stale context only misleads
  // when something fresher contradicts it, and with no captured calls there is
  // nothing fresher. Age is kept as a label on the block, not as a gate.
  const haveOurOwnCalls = lastCallDate !== null;
  const bdrNotesAgeNote =
    oppAgeDays !== null && oppAgeDays > BDR_CONTEXT_MAX_OPP_AGE_DAYS
      ? ` This was recorded roughly ${Math.round(oppAgeDays / 30)} months ago, so treat it as history rather than current fact.`
      : "";

  let crmContext: string | null = null;
  let crmContacts: DealContext["crmContacts"] = [];
  // Why we skipped, not just that we did. One bucket for every skip reason made
  // a consumer-mail deal report "we have our own calls", which sent me looking
  // for an extraction bug that did not exist. A status that can be misread is
  // worse than no status.
  let crmContextStatus: DealContext["crmContextStatus"] = haveOurOwnCalls
    ? "have_own_calls"
    : "no_company_domain";
  if (!haveOurOwnCalls && externalId?.startsWith("auto:")) {
    const tail = externalId.slice("auto:".length);
    const domain = tail.includes("@") ? (tail.split("@")[1] ?? "") : tail;
    const addresses = tail.includes("@") ? [tail] : [];

    // Resolution moved behind resolveAccount so the free-mail case stops being
    // a dead end. The old code required a non-free-mail domain to even try,
    // which is why a Gezairi invite carrying only a gmail.com address produced
    // a briefing with no Salesforce context and no explanation, while an
    // account named "Gezairi" sat in Salesforce the whole time.
    const resolution = await resolveAccount({
      domain,
      addresses,
      dealAccountName: deal.account,
      meetingSubject: null,
    });

    switch (resolution.status) {
      case "resolved_by_domain":
      case "resolved_by_name": {
        try {
          const sf = await loadAccountContext(resolution.accountId);
          if (sf) crmContacts = sf.contacts;
          const rendered = sf ? accountContextLines(sf) : "";
          if (rendered) {
            // Name matches are labelled in the prompt itself. A rep reading
            // "matched by company name" can discount it; a rep reading an
            // unlabelled block cannot.
            const provenance =
              resolution.status === "resolved_by_name"
                ? `\n(This account was matched to the customer by company name, not by their email domain, so confirm it is the right company before relying on it.)`
                : "";
            crmContext = rendered + bdrNotesAgeNote + provenance;
            crmContextStatus = resolution.status === "resolved_by_name" ? "present_by_name" : "present";
          } else {
            // Keep these apart. One "absent" bucket reported Milsped as "account
            // matched, its BDR fields are empty" on the same screen as "no account
            // found", which is a diagnostic contradicting itself. No account is a
            // matching problem worth chasing; an empty account is Magaya's data
            // and nothing for us to fix.
            crmContextStatus = sf ? "empty" : "no_account";
          }
        } catch (err) {
          crmContextStatus = "unavailable";
          console.warn(
            `[deal-context] SALESFORCE ACCOUNT READ FAILED for ${resolution.accountId}, briefing will be thinner than it should be: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        break;
      }
      case "ambiguous":
        // Deliberately no context. Picking one of several same-named accounts
        // is how one customer's qualification data ends up in front of another
        // customer, which is unrecoverable.
        crmContextStatus = "ambiguous";
        console.warn(
          `[deal-context] ${resolution.candidates.length} Salesforce accounts match ${deal.account}; briefing without CRM context until a human picks one.`,
        );
        break;
      case "lookup_failed":
        crmContextStatus = "unavailable";
        console.warn(
          `[deal-context] SALESFORCE LOOKUP FAILED at the ${resolution.stage} stage for ${deal.account}, briefing will be thinner than it should be: ${resolution.error}`,
        );
        break;
      case "no_account":
        crmContextStatus = "no_account";
        break;
      case "no_identifier":
        crmContextStatus = "no_company_domain";
        break;
    }
  }

  return {
    dealId,
    externalId,
    account: deal.account,
    framework,
    extraction,
    nominalStageKey: deal.stageKey,
    crmStageKey,
    crmStageStatus,
    effectiveStageKey,
    confirmed: ds.confirmed,
    total: ds.total,
    reachedStageKey: ds.reachedStageKey,
    topGaps: ds.topGaps,
    nextStepAnswer: ds.nextStepAnswer,
    // LIVE FIRST, CACHED ONLY AS A FALLBACK.
    //
    // deals.rep_forecast_close_date is a cached column and goes stale the
    // moment a rep edits the CRM. On 2026-08-23 the IFF briefing told Eduardo
    // "close date was August 17 and has already passed" while Salesforce held
    // September 21, which Eduardo himself had set three days earlier. A rep who
    // reads a date they personally changed stops trusting the whole briefing,
    // and it is the same email that carries the questions we want them to ask.
    //
    // Rolldog is preferred where the deal has an opportunity, since that is
    // where the sales team lives. Salesforce answers for the deals that have no
    // Rolldog opportunity yet, which is most of them at this stage of the
    // pilot: Magaya does not create one until after the discovery call.
    closeDate: liveCloseDate ?? deal.repForecastCloseDate ?? null,
    attendees: attendeesFrom(deal),
    contacts: deal.contacts,
    lastCallDate,
    uncapturedCalls: uncapturedCalls.sort((a, b) => a.date.localeCompare(b.date)),
    crmContext,
    crmContextStatus,
    stageGates,
    stageGatesStatus,
    crmContacts,
    history,
    rolldogNarrative,
  };
}

/** The briefing input, straight from the canonical context. Ensures the
 *  briefing uses the calls-first stage and the call-verified extraction. */
export function briefingStateFromContext(ctx: DealContext): {
  account: string;
  stageKey: string;
  closeDate?: string;
  attendees: string;
  framework: Framework;
  extraction: ExtractionMap;
  crmContext?: string;
  stageGates?: string | null;
  history?: string;
  rolldogNarrative?: string | null;
  uncapturedCalls?: Array<{ date: string; reason: string }>;
} {
  return {
    account: ctx.account,
    stageKey: ctx.effectiveStageKey,
    closeDate: ctx.closeDate || undefined,
    attendees: ctx.attendees,
    framework: ctx.framework,
    extraction: ctx.extraction as unknown as ExtractionMap,
    crmContext: ctx.crmContext ?? undefined,
    stageGates: ctx.stageGates ? stageGateLines(ctx.stageGates) : null,
    history: ctx.history ?? undefined,
    rolldogNarrative: ctx.rolldogNarrative,
    uncapturedCalls: ctx.uncapturedCalls,
  };
}
