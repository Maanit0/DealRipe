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

import { createHash } from "node:crypto";

import { runWithAuthorizedOpportunities, runWithCallContext, ScopeViolationError } from "./crm-scope";
import { syncDealToRolldog, type SyncResult } from "./crm-writer";
import { rolldogOppIdForDeal } from "./pilot-config";
import { createActivity } from "./rolldog";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

export type WriteBackResult = {
  written: boolean;
  opportunityId?: string;
  reason?: string;
  results?: SyncResult[];
};

/**
 * Log a no-show to Rolldog as a single activity in the interactions tab, so the
 * CRM records that a scheduled meeting did not happen. Same gating as the deal
 * write-back (only a confirmed/high Rolldog-linked opportunity), scope-enforced
 * via createActivity, and call-linked so it surfaces in coverage. Idempotent:
 * if an activity was already written for this call it does nothing, so a
 * re-ingest of the same no-show never double-logs. Best-effort, never throws.
 */
export async function logNoShowToRolldog(
  tenantSlug: string,
  opts: { callId: string },
): Promise<WriteBackResult> {
  const tenantId = await resolveTenantId(tenantSlug);
  const db = supabaseAdmin();

  // Resolve the deal (and call date) from the call itself, so this works in the
  // no-conversation branch before the extraction result exists.
  const callRow = await db
    .from("calls")
    .select("deal_id, scheduled_start, call_date")
    .eq("tenant_id", tenantId)
    .eq("id", opts.callId)
    .maybeSingle();
  if (callRow.error || !callRow.data?.deal_id) {
    return { written: false, reason: `call ${opts.callId} not found or has no deal` };
  }
  const callDate = callRow.data.scheduled_start ?? callRow.data.call_date ?? null;

  const dealRow = await db
    .from("deals")
    .select("id, external_id, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId)
    .eq("id", callRow.data.deal_id)
    .maybeSingle();
  if (dealRow.error || !dealRow.data) {
    return { written: false, reason: `deal for call ${opts.callId} not found` };
  }
  const dealExternalId = dealRow.data.external_id ?? "";

  const conf = dealRow.data.rolldog_link_confidence;
  const staticOpp = rolldogOppIdForDeal(dealExternalId);
  let opp: string | null = null;
  let runtimeAuth: readonly string[] = [];
  if (staticOpp) {
    opp = staticOpp;
  } else if (dealRow.data.rolldog_opportunity_id && (conf === "confirmed" || conf === "high")) {
    opp = dealRow.data.rolldog_opportunity_id;
    runtimeAuth = [opp];
  }
  if (!opp) {
    return { written: false, reason: `no confirmed Rolldog opportunity for '${dealExternalId}' (link: ${conf ?? "none"})` };
  }

  // Idempotency: skip if an activity was already written for this call. A
  // no-show call has no other activity write, so any prior one is this no-show.
  const prior = await db
    .from("crm_access_log")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("operation", "write")
    .eq("allowed", true)
    .eq("call_id", opts.callId)
    .contains("fields", ["activities"])
    .limit(1);
  if ((prior.data ?? []).length > 0) {
    return { written: false, opportunityId: opp, reason: "no-show activity already logged for this call" };
  }

  const dateStr = fmtCallDate(callDate);
  const title = "No-show: customer did not attend";
  const notes = `[DealRipe${dateStr ? ` · ${dateStr} call` : ""}] No conversation was captured; the customer did not attend the scheduled meeting. DealRipe drafted a follow-up for the rep.`;

  try {
    await runWithAuthorizedOpportunities(runtimeAuth, () =>
      runWithCallContext(opts.callId, () => createActivity(opp as string, { title, notes })),
    );
    return { written: true, opportunityId: opp };
  } catch (err) {
    if (err instanceof ScopeViolationError) {
      return { written: false, opportunityId: opp, reason: `scope blocked: '${opp}' not in PILOT_OPPORTUNITY_IDS` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/pending|not configured/i.test(msg)) {
      return { written: false, opportunityId: opp, reason: `Rolldog not configured: ${msg}` };
    }
    return { written: false, opportunityId: opp, reason: msg };
  }
}

function fmtCallDate(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  } catch {
    return "";
  }
}

export async function writeBackDealToRolldog(
  tenantSlug: string,
  dealExternalId: string,
  opts: { nextAction?: string; callId?: string | null; force?: boolean } = {},
): Promise<WriteBackResult> {
  const tenantId = await resolveTenantId(tenantSlug);
  const db = supabaseAdmin();
  const dealRow = await db
    .from("deals")
    .select("id, rolldog_opportunity_id, rolldog_link_confidence, dealripe_last_write_hash, dealripe_last_next_step")
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

  // Change detection: compose (dry-run) to see what WOULD be written, hash the
  // notes payloads, and compare against the last write. This keeps Rolldog always
  // up to date, a re-ingest that confirms a new gate writes the delta, while a
  // re-ingest of the same transcript writes nothing. The next-step activity (an
  // append, not an overwrite) is re-created only when the recommendation changed,
  // so we never stack duplicate to-dos. force bypasses all of this.
  const nextAction = opts.nextAction?.trim() || undefined;
  const lastHash = dealRow.data.dealripe_last_write_hash ?? "";
  const lastNextStep = dealRow.data.dealripe_last_next_step ?? "";
  let notesHash = lastHash;
  let writeNextStep = true;
  if (!opts.force) {
    try {
      const preview = await syncDealToRolldog({ tenantSlug, dealId, rolldogOpportunityId: opp, dryRun: true, nextAction });
      const notesBody = preview
        .filter((r) => r.status === "preview" && r.method !== "writeNextStep" && r.payload)
        .map((r) => `${r.method}=${r.payload}`)
        .join("\n");
      notesHash = createHash("sha1").update(notesBody).digest("hex");
      const nextChanged = !!nextAction && nextAction !== lastNextStep;
      if (notesHash === lastHash && !nextChanged) {
        return { written: false, opportunityId: opp, reason: "no change since last write (idempotent skip)" };
      }
      // Only (re)create the next-step activity when it actually changed.
      writeNextStep = nextChanged;
    } catch {
      // If change detection fails, fall through to a normal write (correctness
      // over de-duplication).
      writeNextStep = true;
    }
  }

  try {
    const results = await runWithAuthorizedOpportunities(runtimeAuth, () =>
      runWithCallContext(opts.callId, () =>
        syncDealToRolldog({
          tenantSlug,
          dealId,
          rolldogOpportunityId: opp,
          // Suppress the next-step create when the recommendation is unchanged, so
          // an unchanged reprocess never adds a duplicate to-do. force always writes it.
          nextAction: opts.force || writeNextStep ? nextAction : undefined,
        }),
      ),
    );
    // Record what we wrote so the next reprocess can detect a no-op, and stamp the
    // write time for the "rep last activity" signal. Best-effort; never fails the write.
    const stamp = await db
      .from("deals")
      .update({
        dealripe_last_writeback_at: new Date().toISOString(),
        dealripe_last_write_hash: notesHash,
        dealripe_last_next_step: opts.force || writeNextStep ? nextAction ?? lastNextStep : lastNextStep,
      })
      .eq("id", dealRow.data.id);
    if (stamp.error) {
      console.warn(
        `[writeback] wrote to opp ${opp} but failed to stamp write state: ${stamp.error.message}`,
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
