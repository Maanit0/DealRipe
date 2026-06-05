/**
 * Outcome label sync: pull Closed status from Salesforce for the tenant's
 * deals, stamp the deal, and backfill outcome_label onto the calibration
 * tables (deal_signal_snapshots, prescribed_actions).
 *
 * Idempotent: deals with outcome_label already set are skipped entirely.
 * Safe to run repeatedly (cron does so every morning).
 *
 * Read-only on the CRM side. The only Supabase writes are:
 *   - deals.outcome_label, deals.outcome_recorded_at
 *   - deal_signal_snapshots.outcome_label (where null)
 *   - prescribed_actions.outcome_label (where null)
 *
 * Salesforce errors are logged per deal but do not abort the run; the
 * next sync picks them back up.
 */

import {
  SalesforceAuthError,
  SalesforceError,
  SalesforceNotFoundError,
  getOpportunityOutcome,
} from "./salesforce";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

export type OutcomeSyncCounts = {
  scanned: number;
  fetched: number;
  stillOpen: number;
  closedWon: number;
  closedLost: number;
  errors: number;
  snapshotsBackfilled: number;
  prescriptionsBackfilled: number;
};

export async function syncOutcomes(
  tenantSlug: string,
): Promise<OutcomeSyncCounts> {
  const counts: OutcomeSyncCounts = {
    scanned: 0,
    fetched: 0,
    stillOpen: 0,
    closedWon: 0,
    closedLost: 0,
    errors: 0,
    snapshotsBackfilled: 0,
    prescriptionsBackfilled: 0,
  };

  const tenantId = await resolveTenantId(tenantSlug);
  const db = supabaseAdmin();

  // Candidate deals: tenant, has an external_id (Salesforce 18-char id),
  // and outcome_label not yet set. Pulling only the columns we need.
  const deals = await db
    .from("deals")
    .select("id, external_id")
    .eq("tenant_id", tenantId)
    .not("external_id", "is", null)
    .is("outcome_label", null);
  if (deals.error) {
    throw new Error(
      `[outcome-sync] deals list failed for tenant ${tenantSlug}: ${deals.error.message}`,
    );
  }

  for (const row of deals.data ?? []) {
    counts.scanned += 1;
    if (!row.external_id) continue;

    let outcome;
    try {
      outcome = await getOpportunityOutcome(tenantSlug, row.external_id);
      counts.fetched += 1;
    } catch (err) {
      counts.errors += 1;
      const tag = errorTag(err);
      console.error(
        `[outcome-sync] fetch failed for deal=${row.id} ext=${row.external_id} (${tag}): ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    if (!outcome.isClosed) {
      counts.stillOpen += 1;
      continue;
    }

    const label: "won" | "lost" = outcome.isWon ? "won" : "lost";
    if (label === "won") counts.closedWon += 1;
    else counts.closedLost += 1;

    const stamp = await db
      .from("deals")
      .update({
        outcome_label: label,
        outcome_recorded_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (stamp.error) {
      counts.errors += 1;
      console.error(
        `[outcome-sync] deal stamp failed for ${row.id}: ${stamp.error.message}`,
      );
      continue;
    }

    // Backfill calibration tables. Failures here do not block the deal
    // stamp itself — the next cron run will retry the orphans because
    // outcome_label IS NULL on those rows.
    const snapBackfill = await db
      .from("deal_signal_snapshots")
      .update({ outcome_label: label })
      .eq("deal_id", row.id)
      .is("outcome_label", null)
      .select("id");
    if (snapBackfill.error) {
      counts.errors += 1;
      console.error(
        `[outcome-sync] snapshot backfill failed for deal=${row.id}: ${snapBackfill.error.message}`,
      );
    } else {
      counts.snapshotsBackfilled += snapBackfill.data?.length ?? 0;
    }

    const prescBackfill = await db
      .from("prescribed_actions")
      .update({ outcome_label: label })
      .eq("deal_id", row.id)
      .is("outcome_label", null)
      .select("id");
    if (prescBackfill.error) {
      counts.errors += 1;
      console.error(
        `[outcome-sync] prescription backfill failed for deal=${row.id}: ${prescBackfill.error.message}`,
      );
    } else {
      counts.prescriptionsBackfilled += prescBackfill.data?.length ?? 0;
    }
  }

  return counts;
}

function errorTag(err: unknown): string {
  if (err instanceof SalesforceNotFoundError) return "NOT_FOUND";
  if (err instanceof SalesforceAuthError) return "AUTH";
  if (err instanceof SalesforceError) return `HTTP_${err.status}`;
  if (err instanceof Error) return err.name;
  return "UNKNOWN";
}
