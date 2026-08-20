/**
 * The read across a whole portfolio, batched so a page can render it.
 *
 * scripts/deal-read-report.ts computes this one deal at a time, which is fine
 * for a terminal and far too slow for a request. The expensive parts are the
 * Salesforce round trips, and every one of them batches by ACCOUNT rather than
 * by deal: one SOQL per 120 accounts instead of one per deal. Doing that once
 * up front and handing the results down turns 114 sequential deals into three
 * queries plus bounded-parallel Supabase reads.
 *
 * Both the page and the script go through here, so a leader looking at the
 * screen and a founder running the script cannot see different numbers about
 * the same deal. That is the whole reason this is a shared module rather than a
 * second implementation.
 */

import { computeDealFlags, type Flag } from "./deal-flags";
import { assessDeal, computeBuyerSignals, type BuyerSignals, type DealAssessment } from "./deal-signals-buyer";
import { resolveSalesforceSnapshots, type SalesforceSnapshot } from "./salesforce-stage";
import {
  closeDateSlipsFor,
  HISTORY_BEGINS,
  loadCloseDateHistoryForAccounts,
  loadOpportunityCreationForAccounts,
} from "./salesforce-stage-history";
import { supabaseAdmin } from "./supabase";

export type DealRead = {
  dealId: string;
  account: string;
  repEmail: string | null;
  signals: BuyerSignals;
  assessment: DealAssessment;
  crm: SalesforceSnapshot | null;
  flags: Flag[];
};

/**
 * How many deals to compute at once.
 *
 * Each deal costs about six Supabase reads plus the attendance pass, so this is
 * a throughput knob rather than a correctness one. Eight keeps a 114-deal
 * portfolio inside a page render without opening enough connections to matter.
 */
const CONCURRENCY = 8;

export async function loadPortfolioRead(args: {
  tenantId: string;
  /** Omit for every open deal. */
  dealIds?: string[];
  now?: Date;
}): Promise<DealRead[]> {
  const db = supabaseAdmin();

  let q = db
    .from("deals")
    .select("id, account, rep_email, outcome_label, salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", args.tenantId);
  if (args.dealIds && args.dealIds.length > 0) q = q.in("id", args.dealIds);
  const res = await q;
  if (res.error) throw new Error(`deals read failed: ${res.error.message}`);

  const deals = ((res.data ?? []) as Array<{
    id: string;
    account: string;
    rep_email: string | null;
    outcome_label: string | null;
    salesforce_account_id: string | null;
    salesforce_link_confidence: string | null;
  }>)
    // A resolved deal has no read worth making. Deliberately not filtered when
    // the caller named specific ids: asking for one deal by id means you want
    // it, closed or not.
    .filter((d) => (args.dealIds && args.dealIds.length > 0 ? true : !d.outcome_label));

  if (deals.length === 0) return [];

  // Only a confirmed link may contribute a CRM reading. Same gate as
  // everywhere else: a weaker link may point at another company.
  const accountIds = [
    ...new Set(
      deals
        .filter((d) => d.salesforce_link_confidence === "confirmed" && d.salesforce_account_id)
        .map((d) => d.salesforce_account_id as string),
    ),
  ];

  const since = `${HISTORY_BEGINS}T00:00:00Z`;
  const [crmByDeal, closeHist, opps] = await Promise.all([
    resolveSalesforceSnapshots(args.tenantId, deals.map((d) => d.id)),
    loadCloseDateHistoryForAccounts(accountIds, since),
    loadOpportunityCreationForAccounts(accountIds),
  ]);

  const out: DealRead[] = [];
  for (let i = 0; i < deals.length; i += CONCURRENCY) {
    const batch = deals.slice(i, i + CONCURRENCY);
    const done = await Promise.all(
      batch.map(async (d): Promise<DealRead> => {
        const acc = d.salesforce_link_confidence === "confirmed" ? d.salesforce_account_id : null;
        const slips =
          acc && closeHist.status === "read" && !("error" in opps)
            ? closeDateSlipsFor({
                moves: closeHist.byAccount.get(acc) ?? [],
                opportunities: opps.get(acc) ?? [],
              })
            : undefined;
        const signals = await computeBuyerSignals({
          tenantId: args.tenantId,
          dealId: d.id,
          now: args.now,
          closeDateSlips: slips,
        });
        const assessment = assessDeal(signals);
        const read = crmByDeal.get(d.id);
        const crm = read?.status === "read" ? read.snapshot : null;
        return {
          dealId: d.id,
          account: d.account,
          repEmail: d.rep_email,
          signals,
          assessment,
          crm,
          flags: computeDealFlags({ signals, assessment, crm, now: args.now }),
        };
      }),
    );
    out.push(...done);
  }

  // Deals that need a person first, then the rest. A leader opening this reads
  // top down and should not have to sort.
  const momentumRank = { stalling: 0, unknown: 1, steady: 2, advancing: 3 } as const;
  const worst = (r: DealRead) => (r.flags.some((f) => f.severity === "critical") ? 0 : 1);
  out.sort(
    (a, b) =>
      worst(a) - worst(b) ||
      momentumRank[a.assessment.momentum] - momentumRank[b.assessment.momentum] ||
      b.flags.length - a.flags.length ||
      a.account.localeCompare(b.account),
  );
  return out;
}
