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

import { ScopeViolationError } from "./crm-scope";
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
  const opp = rolldogOppIdForDeal(dealExternalId);
  if (!opp) {
    return { written: false, reason: `no Rolldog opportunity id mapped for '${dealExternalId}'` };
  }

  const tenantId = await resolveTenantId(tenantSlug);
  const db = supabaseAdmin();
  const dealRow = await db
    .from("deals")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("external_id", dealExternalId)
    .maybeSingle();
  if (dealRow.error) {
    return { written: false, opportunityId: opp, reason: `deal lookup failed: ${dealRow.error.message}` };
  }
  if (!dealRow.data) {
    return { written: false, opportunityId: opp, reason: `deal '${dealExternalId}' not found` };
  }

  try {
    const results = await syncDealToRolldog({
      tenantSlug,
      dealId: dealRow.data.id,
      rolldogOpportunityId: opp,
    });
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
