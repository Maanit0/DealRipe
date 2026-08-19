/**
 * Outcome label sync: resolve each deal's Salesforce outcome, stamp the deal,
 * and backfill outcome_label onto the calibration tables
 * (deal_signal_snapshots, prescribed_actions).
 *
 * HISTORY, because the shape of the old bug is the reason this file is worth
 * reading before changing it. This used to pass `deals.external_id` to
 * getOpportunityOutcome as a Salesforce Opportunity id. external_id is
 * DealRipe's own auto-created key (`auto:cbxglobal.com`), so zero of 108 deals
 * ever resolved, and getOpportunityOutcome's assertScopedRead refused each one
 * against SALESFORCE_PILOT_OPPORTUNITY_IDS (an empty set) before any network
 * call. The cron ran green every morning, logged 101 refusals, counted them as
 * `errors`, and produced "0 won, 0 lost" for weeks. Nobody read the errors
 * because the totals looked like a quiet pipeline.
 *
 * The deal-to-opportunity decision now lives in lib/salesforce-outcome.ts and
 * is deliberately conservative: an open opportunity means still in play, and a
 * close that predates our first captured call is the account's history rather
 * than this deal's result.
 *
 * Read-only on the CRM side. Supabase writes:
 *   - deals.outcome_label, outcome_recorded_at, and (if the migration
 *     supabase/add-outcome-detail.sql has been run) outcome_opportunity_id,
 *     outcome_close_date, outcome_reason, outcome_amount
 *   - deal_signal_snapshots.outcome_label (where null)
 *   - prescribed_actions.outcome_label (where null)
 *
 * Idempotent: deals with outcome_label already set are skipped entirely.
 */

import {
  describeOutcome,
  loadOpportunitiesForAccounts,
  resolveDealOutcome,
  type DealOutcome,
} from "./salesforce-outcome";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

export type OutcomeSyncCounts = {
  scanned: number;
  /** Deals we successfully reached a verdict for, of any kind. */
  resolved: number;
  stillOpen: number;
  closedWon: number;
  closedLost: number;
  /** Account has only closes that predate our first call. Not an error. */
  onlyHistorical: number;
  /** Live, but something closed on the account after our first call. Counted
   *  in stillOpen as well, and never labelled. */
  openWithRecentClose: number;
  /** No salesforce_account_id, or the account carries no opportunity. */
  noTarget: number;
  /** We could not read. Never conflated with an absence. */
  unavailable: number;
  errors: number;
  snapshotsBackfilled: number;
  prescriptionsBackfilled: number;
  /** True when the detail columns are missing, so labels were written without
   *  the opportunity id, close date and loss reason. */
  detailColumnsMissing: boolean;
};

export type OutcomeSyncOptions = {
  /** When false, resolve and report but write nothing. */
  apply?: boolean;
  /** Called once per deal with the verdict, for scripts that want a table. */
  onDeal?: (row: {
    account: string;
    outcome: DealOutcome;
    /** What actually happened to the row. "skipped" covers every status that
     *  is deliberately not labelled. A caller must never print "written" off
     *  the outcome alone: the write can still fail after the verdict. */
     write: "dry-run" | "written" | "failed" | "skipped";
  }) => void;
};

/** PostgREST reports an unknown column as PGRST204 with a schema-cache
 *  message, not as Postgres's "column ... does not exist". Accept both. */
function isMissingColumn(err: { code?: string; message: string }): boolean {
  if (err.code === "PGRST204") return true;
  return /could not find the '.*' column|column .* does not exist/i.test(err.message);
}

export async function syncOutcomes(
  tenantSlug: string,
  opts: OutcomeSyncOptions = {},
): Promise<OutcomeSyncCounts> {
  const apply = opts.apply !== false;
  const counts: OutcomeSyncCounts = {
    scanned: 0,
    resolved: 0,
    stillOpen: 0,
    closedWon: 0,
    closedLost: 0,
    onlyHistorical: 0,
    openWithRecentClose: 0,
    noTarget: 0,
    unavailable: 0,
    errors: 0,
    snapshotsBackfilled: 0,
    prescriptionsBackfilled: 0,
    detailColumnsMissing: false,
  };

  const tenantId = await resolveTenantId(tenantSlug);
  const db = supabaseAdmin();

  // Candidate deals: linked to Salesforce and not already labelled. A deal
  // with no salesforce_account_id has nothing to resolve against, so it is
  // excluded here rather than counted as an error every morning.
  const deals = await db
    .from("deals")
    .select("id, account, salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", tenantId)
    .is("outcome_label", null)
    .eq("salesforce_link_confidence", "confirmed")
    .not("salesforce_account_id", "is", null);
  if (deals.error) {
    throw new Error(
      `[outcome-sync] deals list failed for tenant ${tenantSlug}: ${deals.error.message}`,
    );
  }
  const rows = (deals.data ?? []) as Array<{
    id: string;
    account: string;
    salesforce_account_id: string | null;
    salesforce_link_confidence: string | null;
  }>;
  counts.scanned = rows.length;
  if (rows.length === 0) return counts;

  // Earliest captured call per deal. This is what makes a close "ours": a
  // Magaya account can carry closes back to 2017, and labelling one of those
  // as the result of a call we ran last week would invent an outcome.
  const firstCall = new Map<string, string>();
  const calls = await db
    .from("calls")
    .select("deal_id, scheduled_start")
    .in("deal_id", rows.map((r) => r.id))
    .not("scheduled_start", "is", null);
  if (calls.error) {
    // A failed read here would silently turn every deal into only_historical,
    // which is exactly the mistake this file exists to stop making.
    throw new Error(`[outcome-sync] call history read failed: ${calls.error.message}`);
  }
  for (const c of (calls.data ?? []) as Array<{ deal_id: string; scheduled_start: string }>) {
    const d = c.scheduled_start.slice(0, 10);
    const prev = firstCall.get(c.deal_id);
    if (!prev || d < prev) firstCall.set(c.deal_id, d);
  }

  const accountIds = rows
    .map((r) => r.salesforce_account_id)
    .filter((x): x is string => Boolean(x));
  const oppsByAccount = await loadOpportunitiesForAccounts(accountIds);

  for (const row of rows) {
    const outcome = resolveDealOutcome({
      salesforceAccountId: row.salesforce_account_id,
      firstCallDate: firstCall.get(row.id) ?? null,
      opportunitiesByAccount: oppsByAccount,
    });
    const report = (write: "dry-run" | "written" | "failed" | "skipped") =>
      opts.onDeal?.({ account: row.account, outcome, write });

    switch (outcome.status) {
      case "open":
        counts.resolved++;
        counts.stillOpen++;
        report("skipped");
        continue;
      case "open_with_recent_close":
        // Deliberately NOT labelled. The relationship is live, so telling the
        // digest it closed would be worse than losing one training row. The
        // close is reported so the learning loop can pick it up separately.
        counts.resolved++;
        counts.stillOpen++;
        counts.openWithRecentClose++;
        report("skipped");
        console.log(
          `[outcome-sync] ${row.account}: ${describeOutcome(outcome)} (left unlabelled, still live)`,
        );
        continue;
      case "only_historical":
        counts.resolved++;
        counts.onlyHistorical++;
        report("skipped");
        continue;
      case "no_account":
      case "no_opportunity":
        counts.resolved++;
        counts.noTarget++;
        report("skipped");
        continue;
      case "unavailable":
        counts.unavailable++;
        report("skipped");
        console.warn(`[outcome-sync] ${row.account}: ${outcome.reason}`);
        continue;
    }

    counts.resolved++;
    const label: "won" | "lost" = outcome.status;
    if (label === "won") counts.closedWon++;
    else counts.closedLost++;
    if (!apply) {
      report("dry-run");
      continue;
    }

    const core = {
      outcome_label: label,
      outcome_recorded_at: new Date().toISOString(),
    };
    const detail = {
      ...core,
      outcome_opportunity_id: outcome.opportunityId,
      outcome_close_date: outcome.closeDate,
      outcome_reason: outcome.lossReason,
      outcome_amount: outcome.amount,
    };

    let stamp = await db.from("deals").update(detail).eq("id", row.id);
    if (stamp.error && isMissingColumn(stamp.error)) {
      // The detail migration has not been run. Still record the label, and say
      // loudly what was dropped rather than failing the deal.
      //
      // Match on PostgREST's own code, not on prose. The first version of this
      // tested the message against /column .* does not exist/, which is the
      // Postgres wording; PostgREST actually returns PGRST204 "Could not find
      // the 'outcome_amount' column of 'deals' in the schema cache", so the
      // fallback never fired and six deals failed instead of degrading.
      counts.detailColumnsMissing = true;
      stamp = await db.from("deals").update(core).eq("id", row.id);
    }
    if (stamp.error) {
      counts.errors++;
      report("failed");
      console.error(`[outcome-sync] deal stamp failed for ${row.account}: ${stamp.error.message}`);
      continue;
    }
    report("written");
    console.log(`[outcome-sync] ${row.account}: ${describeOutcome(outcome)}`);

    // Backfill calibration tables. Failures do not block the deal stamp; the
    // next run retries the orphans because outcome_label IS NULL on them.
    const snap = await db
      .from("deal_signal_snapshots")
      .update({ outcome_label: label })
      .eq("deal_id", row.id)
      .is("outcome_label", null)
      .select("id");
    if (snap.error) {
      counts.errors++;
      console.error(`[outcome-sync] snapshot backfill failed for ${row.account}: ${snap.error.message}`);
    } else {
      counts.snapshotsBackfilled += snap.data?.length ?? 0;
    }

    const presc = await db
      .from("prescribed_actions")
      .update({ outcome_label: label })
      .eq("deal_id", row.id)
      .is("outcome_label", null)
      .select("id");
    if (presc.error) {
      counts.errors++;
      console.error(`[outcome-sync] prescription backfill failed for ${row.account}: ${presc.error.message}`);
    } else {
      counts.prescriptionsBackfilled += presc.data?.length ?? 0;
    }
  }

  if (counts.detailColumnsMissing) {
    console.warn(
      "[outcome-sync] outcome detail columns missing: labels written without opportunity id, close date or loss reason. Run supabase/add-outcome-detail.sql",
    );
  }
  return counts;
}

/**
 * Fill outcome detail onto deals that were labelled before
 * supabase/add-outcome-detail.sql existed.
 *
 * syncOutcomes is idempotent on outcome_label, so a deal labelled during the
 * window when the detail columns were missing would keep its won/lost and
 * never gain the opportunity id, close date, loss reason or amount. This is
 * the recovery path for exactly that ordering.
 *
 * Re-resolves from Salesforce rather than trusting the stored label, and
 * reports a disagreement instead of overwriting: if the account now says
 * something different from what we recorded, that is worth a human look, not a
 * silent correction.
 */
export async function refillOutcomeDetail(tenantSlug: string): Promise<{
  candidates: number;
  filled: number;
  disagreed: { account: string; stored: string; resolved: string }[];
  columnsMissing: boolean;
  errors: number;
}> {
  const out = {
    candidates: 0,
    filled: 0,
    disagreed: [] as { account: string; stored: string; resolved: string }[],
    columnsMissing: false,
    errors: 0,
  };
  const tenantId = await resolveTenantId(tenantSlug);
  const db = supabaseAdmin();

  const res = await db
    .from("deals")
    .select("id, account, salesforce_account_id, outcome_label, outcome_opportunity_id")
    .eq("tenant_id", tenantId)
    .not("outcome_label", "is", null)
    .is("outcome_opportunity_id", null)
    .not("salesforce_account_id", "is", null);
  if (res.error) {
    if (isMissingColumn(res.error)) {
      out.columnsMissing = true;
      return out;
    }
    throw new Error(`[outcome-sync] refill list failed: ${res.error.message}`);
  }
  const rows = (res.data ?? []) as Array<{
    id: string;
    account: string;
    salesforce_account_id: string | null;
    outcome_label: "won" | "lost";
  }>;
  out.candidates = rows.length;
  if (rows.length === 0) return out;

  const firstCall = new Map<string, string>();
  const calls = await db
    .from("calls")
    .select("deal_id, scheduled_start")
    .in("deal_id", rows.map((r) => r.id))
    .not("scheduled_start", "is", null);
  if (calls.error) throw new Error(`[outcome-sync] refill call read failed: ${calls.error.message}`);
  for (const c of (calls.data ?? []) as Array<{ deal_id: string; scheduled_start: string }>) {
    const d = c.scheduled_start.slice(0, 10);
    const prev = firstCall.get(c.deal_id);
    if (!prev || d < prev) firstCall.set(c.deal_id, d);
  }

  const opps = await loadOpportunitiesForAccounts(
    rows.map((r) => r.salesforce_account_id).filter((x): x is string => Boolean(x)),
  );

  for (const row of rows) {
    const outcome = resolveDealOutcome({
      salesforceAccountId: row.salesforce_account_id,
      firstCallDate: firstCall.get(row.id) ?? null,
      opportunitiesByAccount: opps,
    });
    if (outcome.status !== "won" && outcome.status !== "lost") {
      out.disagreed.push({
        account: row.account,
        stored: row.outcome_label,
        resolved: describeOutcome(outcome),
      });
      continue;
    }
    if (outcome.status !== row.outcome_label) {
      out.disagreed.push({
        account: row.account,
        stored: row.outcome_label,
        resolved: describeOutcome(outcome),
      });
      continue;
    }
    const upd = await db
      .from("deals")
      .update({
        outcome_opportunity_id: outcome.opportunityId,
        outcome_close_date: outcome.closeDate,
        outcome_reason: outcome.lossReason,
        outcome_amount: outcome.amount,
      })
      .eq("id", row.id);
    if (upd.error) {
      if (isMissingColumn(upd.error)) {
        out.columnsMissing = true;
        return out;
      }
      out.errors++;
      console.error(`[outcome-sync] refill failed for ${row.account}: ${upd.error.message}`);
      continue;
    }
    out.filled++;
    console.log(`[outcome-sync] refilled ${row.account}: ${describeOutcome(outcome)}`);
  }
  return out;
}
