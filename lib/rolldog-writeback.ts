/**
 * Gated Rolldog write-back for the automatic pipeline.
 *
 * Thin, best-effort wrapper over crm-writer.syncDealToRolldog. It routes a
 * deal (by slug) to its live Rolldog opportunity id and pushes the stored
 * extractions. Everything is fail-closed and non-throwing so it can never
 * break transcript-sync:
 *
 *   - No opportunity id mapped for the deal  -> skip (not configured yet).
 *   - Opportunity not in PILOT_OPPORTUNITY_IDS -> ScopeViolationError is
 *     caught and reported as a skip (the security guard did its job).
 *   - Rolldog creds absent / pending          -> skip.
 *   - Any other error                         -> reported, not thrown.
 *
 * To go live: fill PILOT_DEAL_ROLLDOG_IDS (pilot-config) AND add the same id
 * to PILOT_OPPORTUNITY_IDS (crm-scope). Both, then deploy.
 */

import { runWithAuthorizedOpportunities, ScopeViolationError } from "./crm-scope";
import { syncDealToRolldog, type SyncResult } from "./crm-writer";
import { rolldogOppIdForDeal } from "./pilot-config";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

export type WriteBackResult = {
  written: boolean;
  opportunityId?: string;
  reason?: string;
  results?: SyncResult[];
};

export async function writeBackDealToRolldog(
  tenantSlug: string,
  dealExternalId: string,
): Promise<WriteBackResult> {
  const tenantId = await resolveTenantId(tenantSlug);
  const db = supabaseAdmin();
  const dealRow = await db
    .from("deals")
    .select("id, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId)
    .eq("external_id", dealExternalId)
    .maybeSingle();
  if (dealRow.error) {
    return { written: false, reason: `deal lookup failed: ${dealRow.error.message}` };
  }
  if (!dealRow.data) {
    return { written: false, reason: `deal '${dealExternalId}' not found` };
  }

  // Resolve which opportunity to write and whether it's authorized:
  //   - Hand-seeded pilot deal -> static PILOT_OPPORTUNITY_IDS map (authorized
  //     by the static allowlist, unchanged).
  //   - Auto-linked deal -> the confirmed/high match stored on the deal, which
  //     we authorize for this one write via runWithAuthorizedOpportunities.
  //     'review' / null links never write (fail-closed).
  const dealId = dealRow.data.id;
  const conf = dealRow.data.rolldog_link_confidence;
  const staticOpp = rolldogOppIdForDeal(dealExternalId);
  let opp: string | null = null;
  let runtimeAuth: readonly string[] = [];
  if (staticOpp) {
    opp = staticOpp;
  } else if (
    dealRow.data.rolldog_opportunity_id &&
    (conf === "confirmed" || conf === "high")
  ) {
    opp = dealRow.data.rolldog_opportunity_id;
    runtimeAuth = [opp];
  }
  if (!opp) {
    return {
      written: false,
      reason: `no confirmed Rolldog opportunity for '${dealExternalId}' (link: ${conf ?? "none"})`,
    };
  }

  try {
    const results = await runWithAuthorizedOpportunities(runtimeAuth, () =>
      syncDealToRolldog({
        tenantSlug,
        dealId,
        rolldogOpportunityId: opp,
      }),
    );
    // Stamp when DealRipe last wrote this record so the "rep last activity"
    // signal can attribute Rolldog's updated-at away from our own writes.
    // Best-effort: a failed stamp never fails the write-back.
    const stamp = await db
      .from("deals")
      .update({ dealripe_last_writeback_at: new Date().toISOString() })
      .eq("id", dealRow.data.id);
    if (stamp.error) {
      console.warn(
        `[writeback] wrote to opp ${opp} but failed to stamp dealripe_last_writeback_at: ${stamp.error.message}`,
      );
    }
    return { written: true, opportunityId: opp, results };
  } catch (err) {
    if (err instanceof ScopeViolationError) {
      return {
        written: false,
        opportunityId: opp,
        reason: `scope blocked: opportunity '${opp}' is not in PILOT_OPPORTUNITY_IDS`,
      };
    }
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : String(err);
    if (name === "RolldogPendingError" || /pending|not configured/i.test(msg)) {
      return { written: false, opportunityId: opp, reason: `Rolldog not configured: ${msg}` };
    }
    return { written: false, opportunityId: opp, reason: msg };
  }
}
