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
  crmContextStatus: "present" | "absent" | "unavailable" | "not_applicable";
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

  const effectiveStageKey = inferStageKey(
    framework,
    extraction,
    crmStageKey ?? deal.stageKey,
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
  let crmContextStatus: DealContext["crmContextStatus"] = "not_applicable";
  if (!haveOurOwnCalls && externalId?.startsWith("auto:")) {
    const tail = externalId.slice("auto:".length);
    const domain = tail.includes("@") ? (tail.split("@")[1] ?? "") : tail;
    const addresses = tail.includes("@") ? [tail] : [];
    if (domain && !isFreeMailDomain(domain)) {
      try {
        const sf = await getAccountContextByDomain(domain, addresses);
        const rendered = sf ? accountContextLines(sf) : "";
        if (rendered) {
          crmContext = rendered + bdrNotesAgeNote;
          crmContextStatus = "present";
        } else {
          // Either no account matched, or the account matched but every Sales
          // Development field on it is empty. Both are genuine absence, and
          // both are common and fine.
          crmContextStatus = "absent";
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
} {
  return {
    account: ctx.account,
    stageKey: ctx.effectiveStageKey,
    closeDate: ctx.closeDate || undefined,
    attendees: ctx.attendees,
    framework: ctx.framework,
    extraction: ctx.extraction as unknown as ExtractionMap,
    crmContext: ctx.crmContext ?? undefined,
  };
}
