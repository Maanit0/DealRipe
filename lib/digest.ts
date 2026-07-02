/**
 * The pilot digest: "what needs your attention," per deal.
 *
 * Diffs the two most recent deal_signal_snapshots (latest vs prior) to
 * surface what changed, the live risks, and one coaching prompt Mark can
 * take into a rep conversation. This is the keystone of the CRO home view
 * and the rep weekly recap.
 *
 * With only one snapshot (a deal's first day) there is nothing to diff, so
 * "changed" reads "Baseline captured."
 */

import type { DealSignals } from "./snapshot";
import { supabaseAdmin } from "./supabase";

const RISK_LABELS: Record<string, string> = {
  economic_buyer_not_engaged: "Economic buyer not engaged",
  competitor_unknown: "No competitor identified",
  close_date_unvalidated: "Close date not validated by the customer",
  stalled_in_stage: "Stalled in stage",
};

const RISK_PRIORITY = [
  "economic_buyer_not_engaged",
  "close_date_unvalidated",
  "competitor_unknown",
  "stalled_in_stage",
];

const COACHING: Record<string, string> = {
  economic_buyer_not_engaged:
    "No economic buyer appears on any call. Ask the rep who signs this and when they get in the room.",
  close_date_unvalidated:
    "The close date is the rep's, not the customer's. Ask the rep to get the customer to confirm it.",
  competitor_unknown:
    "No competitor surfaced. Ask the rep who else the customer is evaluating and why.",
  stalled_in_stage:
    "This deal has been sitting in stage. Ask the rep what specifically is blocking the next gate.",
};

export type DigestEntry = {
  dealId: string;
  account: string;
  stage: string;
  amount: number;
  forecast: { probability: number; confirmed: number; total: number };
  changed: string[];
  risks: string[];
  coaching: string;
  attention: number; // higher = needs Mark more
};

function diffSignals(prior: DealSignals | null, latest: DealSignals): string[] {
  if (!prior) return ["Baseline captured. Changes show from the next snapshot."];
  const out: string[] = [];

  if (prior.stage !== latest.stage) {
    out.push(`Stage moved ${prior.stage} to ${latest.stage}.`);
  }

  const priorAnswered = new Set(prior.answered);
  const newlyAnswered = latest.answered.filter((k) => !priorAnswered.has(k));
  if (newlyAnswered.length > 0) {
    out.push(
      `Confirmed ${newlyAnswered.length} new field${newlyAnswered.length === 1 ? "" : "s"}: ${newlyAnswered.join(", ")}.`,
    );
  }

  const priorRisks = new Set(prior.risks);
  const latestRisks = new Set(latest.risks);
  for (const r of latest.risks) {
    if (!priorRisks.has(r)) out.push(`New risk: ${RISK_LABELS[r] ?? r}.`);
  }
  for (const r of prior.risks) {
    if (!latestRisks.has(r)) out.push(`Cleared: ${RISK_LABELS[r] ?? r}.`);
  }

  if (out.length === 0) out.push("No change since the last snapshot.");
  return out;
}

function coachingFor(risks: string[]): string {
  for (const r of RISK_PRIORITY) {
    if (risks.includes(r) && COACHING[r]) return COACHING[r];
  }
  return "On track. Confirm the next-stage gate items are progressing.";
}

function attentionScore(latest: DealSignals): number {
  let score = latest.risks.length * 10;
  if (latest.risks.includes("economic_buyer_not_engaged")) score += 20;
  const rank = latest.stage.match(/(\d+)/);
  if (rank && parseInt(rank[1], 10) >= 4 && latest.risks.length > 0) score += 15;
  return score;
}

/** Build the digest for one deal from its snapshot history. */
export async function getDealDigest(
  dealId: string,
  account: string,
): Promise<DigestEntry | null> {
  const db = supabaseAdmin();
  const res = await db
    .from("deal_signal_snapshots")
    .select("snapshot_date, signals, dealripe_forecast")
    .eq("deal_id", dealId)
    .order("snapshot_date", { ascending: false })
    .limit(2);
  if (res.error) throw new Error(`snapshot read failed: ${res.error.message}`);
  const rows = res.data ?? [];
  if (rows.length === 0) return null;

  const latest = rows[0].signals as unknown as DealSignals;
  const prior = rows.length > 1 ? (rows[1].signals as unknown as DealSignals) : null;
  const fc = (rows[0].dealripe_forecast ?? {}) as {
    probability?: number;
    confirmed?: number;
    total?: number;
  };

  return {
    dealId,
    account,
    stage: latest.stage,
    amount: latest.amount,
    forecast: {
      probability: fc.probability ?? 0,
      confirmed: fc.confirmed ?? 0,
      total: fc.total ?? 0,
    },
    changed: diffSignals(prior, latest),
    risks: latest.risks.map((r) => RISK_LABELS[r] ?? r),
    coaching: coachingFor(latest.risks),
    attention: attentionScore(latest),
  };
}

/** Build the digest across all of a tenant's deals, ranked by attention. */
export async function getPilotDigest(
  tenantId: string,
): Promise<DigestEntry[]> {
  const db = supabaseAdmin();
  const dealsRes = await db
    .from("deals")
    .select("id, account")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(`deals read failed: ${dealsRes.error.message}`);

  const entries: DigestEntry[] = [];
  for (const d of dealsRes.data ?? []) {
    const e = await getDealDigest(d.id, d.account);
    if (e) entries.push(e);
  }
  entries.sort((a, b) => b.attention - a.attention);
  return entries;
}
