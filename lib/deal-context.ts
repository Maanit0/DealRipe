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
import { isFreeMailDomain, rolldogOppIdForDeal } from "./pilot-config";
import { accountContextLines, getAccountContextByDomain } from "./salesforce-context";
import { getRolldogSummary, stageKeyFromSummary } from "./rolldog-summary";
import type { ExtractionResult } from "./scotsman";
import type { Contact } from "./seed-data";
import { getDealForTenant } from "./supabase-queries";
import { supabaseAdmin } from "./supabase";

const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled", "placeholder", "capture_failed"]);

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
   * Only fetched for deals with NO Rolldog opportunity, which is exactly the
   * case where DealRipe has little or nothing of its own: a first discovery
   * call booked by a BDR. Alexandra has 19 counterparties in that state this
   * week. Null once a deal is in Rolldog, because by then the calls are the
   * better source and the BDR's pre-call notes are stale.
   */
  crmContext: string | null;
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
    .select("external_id")
    .eq("id", dealId)
    .maybeSingle();
  const externalId = row.data?.external_id ?? null;

  // Rolldog stage is a cross-check/floor, best-effort. Never drives the truth.
  let crmStageKey: string | null = null;
  const opp = externalId ? rolldogOppIdForDeal(externalId) : null;
  if (opp) {
    try {
      crmStageKey = stageKeyFromSummary(await getRolldogSummary(opp));
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

  // Salesforce BDR context, for deals that have no Rolldog opportunity yet.
  // Best-effort in the strongest sense: Salesforce being slow or unreachable
  // must never stop a briefing being generated, it just makes it thinner.
  let crmContext: string | null = null;
  if (!opp && externalId?.startsWith("auto:")) {
    const tail = externalId.slice("auto:".length);
    const domain = tail.includes("@") ? (tail.split("@")[1] ?? "") : tail;
    const addresses = tail.includes("@") ? [tail] : [];
    if (domain && !isFreeMailDomain(domain)) {
      try {
        const sf = await getAccountContextByDomain(domain, addresses);
        if (sf) crmContext = accountContextLines(sf);
      } catch (err) {
        console.warn(
          `[deal-context] salesforce context unavailable for ${domain}: ${err instanceof Error ? err.message : String(err)}`,
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
