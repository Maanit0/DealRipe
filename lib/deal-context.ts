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
import { accountContextLines, getAccountContextByDomain } from "./salesforce-context";
import { getRolldogSummary, stageKeyFromSummary } from "./rolldog-summary";
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
    | "no_company_domain";
  /**
   * The rep's own stage checklist from Rolldog, and how it compares to what the
   * calls confirm. Null when the deal has no opportunity or the read failed;
   * an unreadable checklist must never render as an empty one.
   */
  stageGates: StageGateSummary | null;
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
  if (opp) {
    try {
      stageGates = await getStageGateSummary(opp, extraction as unknown as ExtractionMap);
    } catch (err) {
      console.warn(
        `[deal-context] stage-gate read failed for opportunity ${opp}, briefing will not see the rep's checklist: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (opp) {
    try {
      // Authorize this one opportunity for the duration of the read. The scope
      // guard is fail-closed and only the static pilot ids pass by default, so
      // without this every opportunity the reconciler linked throws and the
      // deal briefs as though it has no CRM record at all. The wrapper is
      // per-call and per-opportunity: nothing else becomes readable.
      const summary = await runWithAuthorizedOpportunities([opp], () => getRolldogSummary(opp));
      crmStageKey = stageKeyFromSummary(summary);
      // Null summary means the opportunity could not be read. Leaving the age
      // unknown is correct: it falls through to "no opportunity age", and the
      // BDR-notes test below then depends only on whether we have our own
      // calls, which is the safer default when Rolldog is unreadable.
      oppCreatedAt = summary?.createdAt ?? null;
    } catch {
      /* best-effort */
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
  try {
    const nowIso = new Date().toISOString();
    const calls = await db
      .from("calls")
      .select("scheduled_start, call_date, outcome")
      .eq("tenant_id", tenantId)
      .eq("deal_id", dealId)
      .lte("scheduled_start", nowIso);
    for (const c of calls.data ?? []) {
      if (c.outcome && NO_CONTENT.has(c.outcome)) continue;
      const when = c.scheduled_start ?? c.call_date;
      if (when && (!lastCallDate || new Date(when).getTime() > new Date(lastCallDate).getTime())) {
        lastCallDate = when;
      }
    }
  } catch {
    /* best-effort */
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
    history = await buildBriefingHistory(tenantId, dealId);
  } catch {
    /* best-effort: a thin briefing beats no briefing */
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
    if (domain && !isFreeMailDomain(domain)) {
      try {
        const sf = await getAccountContextByDomain(domain, addresses);
        if (sf) crmContacts = sf.contacts;
        const rendered = sf ? accountContextLines(sf) : "";
        if (rendered) {
          crmContext = rendered + bdrNotesAgeNote;
          crmContextStatus = "present";
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
          `[deal-context] SALESFORCE LOOKUP FAILED for ${domain}, briefing will be thinner than it should be: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
    effectiveStageKey,
    confirmed: ds.confirmed,
    total: ds.total,
    reachedStageKey: ds.reachedStageKey,
    topGaps: ds.topGaps,
    nextStepAnswer: ds.nextStepAnswer,
    closeDate: deal.repForecastCloseDate || null,
    attendees: attendeesFrom(deal),
    contacts: deal.contacts,
    lastCallDate,
    crmContext,
    crmContextStatus,
    stageGates,
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
  };
}
