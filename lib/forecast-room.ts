/**
 * Forecast Room data, computed from a tenant's REAL deals + snapshots.
 *
 * This is the non-magaya (demo) counterpart to the pipeline-changes dashboard:
 * the CRO's weekly view of the number. Everything here is derived from the live
 * seeded data (deals, field_extractions, contacts, calls) so the Forecast Room
 * reflects the same truth as the pipeline and the deal pages, not a static deck.
 *
 * DealRipe's weighted forecast tempers each rep's probability by how much of the
 * framework the calls actually confirm (the same read the snapshot stores), so a
 * deal the rep calls Commit but has not qualified lands softer here. The gap to a
 * quarter target, the week's forecast moves, and the ranked "what closes the gap"
 * actions all fall out of that.
 */

import { repName } from "./display-names";
import { loadFramework } from "./framework";
import { frameworkProgress } from "./framework-stages";
import { getPipelineChanges, type DealChangeRecord } from "./pipeline-changes";
import { getDealsForTenant } from "./supabase-queries";
import { getTasks, type TaskItem } from "./tasks";

// A sensible quarter target for the demo tenant (the number the CRO is carrying).
const QUARTER_TARGET_USD = 2_500_000;
const QUARTER_LABEL = "Q3 2026";
const STAGE_LABELS: Record<string, string> = {
  SQL0: "Lead",
  SQL1: "Develop Opportunity",
  SQL2: "Solution Finalization",
  SQL3: "Proposal Validation",
  SQL4: "Negotiations",
  SQL5: "Agreement Formalization",
};
// Forecast-accuracy constants for the calibration tile (DealRipe vs rep commit).
const CALIBRATION = {
  drAccuracyPct: 90,
  repAccuracyPct: 63,
  drDeviationUsd: 36_000,
  dealsTrainedOn: 184,
};

export type ForecastHealth = "at_risk" | "stalled" | "healthy";

export type ForecastRoomDeal = {
  dealId: string;
  account: string;
  industry: string;
  stageKey: string;
  stageLabel: string;
  arr: number;
  repProb: number; // 0..1, the rep's forecast probability
  drProb: number; // 0..1, DealRipe's read (rep tempered by qualification)
  repProbPct: number;
  drProbPct: number;
  deltaPts: number; // drProbPct - repProbPct
  repCategory: string;
  drCategory: string;
  closeDate: string | null;
  repName: string;
  repEmail: string | null;
  gatesConfirmed: number;
  gatesTotal: number;
  health: ForecastHealth;
  reason: string; // why DealRipe reads it the way it does
  agreedNextStep: string | null;
};

export type ForecastRoomAction = {
  dealId: string;
  account: string;
  title: string;
  detail: string | null;
  actionType: string | null;
  closeProbLiftPts: number;
  weightedLiftUsd: number;
  confidence: "High" | "Medium";
  confidenceNote: string;
  prescribed: boolean;
};

export type ForecastRoom = {
  weekOf: string;
  quarterTargetUsd: number;
  quarterLabel: string;
  /** True when a real quarter target is known (demo tenant). When false (the live
   *  pilot, no target given), the summary leads with overcommit, not gap-to-target. */
  hasTarget: boolean;
  /** Sum of open-deal ARR, for the "Total pipeline" tile when there is no target. */
  pipelineTotalUsd: number;
  repWeightedUsd: number;
  drWeightedUsd: number;
  gapToTargetUsd: number;
  overcommitUsd: number;
  deals: ForecastRoomDeal[];
  changed: ForecastRoomDeal[];
  actions: ForecastRoomAction[];
  calibration: typeof CALIBRATION;
  reps: Array<{ email: string; name: string }>;
};

function categoryOf(p: number): string {
  return p >= 0.7 ? "Commit" : p >= 0.4 ? "Expect" : "Pipeline";
}

// The live pilot forecasts in CRM categories (Commit/Expect/Pipeline/Omitted), not
// probabilities. Map each to a representative probability so the room can weight and
// compare rep vs DealRipe. Used only when a deal has no seeded probability (magaya).
function categoryToProb(cat: string | null | undefined): number {
  switch ((cat ?? "").toLowerCase()) {
    case "commit":
      return 0.85;
    case "expect":
      return 0.5;
    case "pipeline":
      return 0.25;
    case "omit":
    case "omitted":
      return 0.05;
    default:
      return 0.25;
  }
}

// Demo-tenant (keelson) reasons: each is specific to that one account and pulls
// from a DIFFERENT signal type (calendar, email, a call moment, a no-show, an org
// change), so the forecast reads like DealRipe watched the actual deal, not a
// generic "no economic buyer" line repeated across the pipeline. Keyed by account,
// so it only ever applies to the fictional keelson deals; magaya is untouched.
const DEMO_REASONS: Record<string, string> = {
  "Cascade Freight Systems":
    "Elena Voss, the VP Operations who signs anything over 250K, declined last week's working-session invite. The deal is still single-threaded on ops manager Ray Delgado.",
  "Delmar Customs Brokerage":
    "Marcus Hale, Delmar's president and economic buyer, no-showed the scoping call and has not answered the follow-up email in nine days. Budget was never put on a call.",
  "Pacific Cargo Group":
    "Sandra Ng, the ops director, named Pacific's incumbent WMS as a live alternative on the demo, and no competitive counter has been scheduled since.",
  "Summit Logistics":
    "Dana Whitfield, Summit's new Director of Operations, only just took the deal over, and procurement is still not engaged at day 62, past the day-60 mark these deals usually clear by.",
  "Vantage Supply Chain":
    "Every touch is with Maya Okonkwo, the VP Supply Chain and sole contact; no second stakeholder has joined a call or replied to email, and the last activity was five days ago.",
  "Anchor Freight Forwarding":
    "Every gate is confirmed with a quote from Tom Bianchi, the COO, and legal is cleared. DealRipe holds a small discount only until the signing date is locked.",
  // Deals advancing cleanly: DealRipe reads them HIGHER than the conservative rep.
  "Harborview Freight":
    "Harborview's CFO, Nadia Brandt, joined last week's call and every gate but legal is confirmed. Rep Priya still has this at Expect; DealRipe reads the qualification as a clean Commit.",
  "Tidewater Distribution":
    "A second stakeholder joined Tuesday's call and budget was confirmed on the record. The deal is qualifying faster than the rep's Pipeline call reflects.",
};

// Demo-tenant DealRipe probability override (0..1). Only set for the well-qualified
// deals the rep is under-calling, so DealRipe can read them ABOVE the rep and the
// room shows deals moving cleanly to the right (positive deltas), not only risk.
export const DEMO_DR_PROB: Record<string, number> = {
  "Harborview Freight": 0.8,
  "Tidewater Distribution": 0.6,
};

// Demo-tenant action detail: the "what closes the gap" copy, written the way a
// best rep would coach it, what worked on similar accounts and the commitment to
// leave with. Keyed by account, keelson-only.
const DEMO_ACTION_DETAIL: Record<string, string> = {
  "Cascade Freight Systems":
    "Ask Ray to broker a 30-minute working session with Elena this week. Reps who win the VP-signoff deals get the economic buyer in the room before the proposal ages out; frame it as a short risk review, not a sales call. Leave with a date on Elena's calendar.",
  "Delmar Customs Brokerage":
    "Call Marcus directly instead of emailing again. After a no-show the move that works is a two-line note with two concrete time windows and a reason to meet; nine days of silence is where these quietly die. Leave with a re-booked call and a budget number.",
  "Pacific Cargo Group":
    "Send Sandra a side-by-side of Keelson versus her incumbent WMS on the two lanes she demoed. Competitive deals turn when you name the switching cost first and don't let the incumbent frame it. Leave with a hands-on trial on their own shipment data, not another demo.",
  "Summit Logistics":
    "Re-ground Dana as the new owner and get procurement engaged this week. These deals clear procurement by day 60 and you're at 62 with no thread open. Leave with an intro to the procurement contact and a mapped approval path.",
  "Anchor Freight Forwarding":
    "Lock the signing date with Tom while every gate is green. The risk now is drift, not qualification; the best reps put the signature on the calendar the same call terms are agreed. Leave with a signing call on the books before the quarter rolls.",
  "Vantage Supply Chain":
    "Close the legal-review gate with Maya and get a second stakeholder on the next call. She signs, but a single-threaded deal this size slips; widen it while she is warm. Leave with legal cleared and one more name on the deal.",
  "Harborview Freight":
    "Nothing is broken here; protect the close. Get the signing date on the calendar this week while the CFO is engaged, the way the best reps lock a clean deal before it drifts. Leave with a signing date.",
  "Tidewater Distribution":
    "This is advancing; press the advantage. Confirm the budget in writing and set the proposal review while the second stakeholder is warm. Leave with a proposal-review date on the calendar.",
};

export async function getForecastRoom(
  tenantId: string,
  opts?: { quarterTargetUsd?: number | null },
): Promise<ForecastRoom> {
  const quarterTargetUsd = opts?.quarterTargetUsd ?? null;
  const hasTarget = quarterTargetUsd != null;
  const untilIso = new Date().toISOString();
  const sinceIso = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const [deals, framework, pc, tasks] = await Promise.all([
    getDealsForTenant(tenantId),
    loadFramework(tenantId).catch(() => null),
    getPipelineChanges(tenantId, { sinceIso, untilIso }),
    getTasks(tenantId),
  ]);

  const recById = new Map<string, DealChangeRecord>(pc.deals.map((r) => [r.dealId, r]));

  const roomDeals: ForecastRoomDeal[] = deals.map((d) => {
    const prog = framework ? frameworkProgress(framework, d.extraction) : { confirmed: 0, total: 0 };
    const completion = prog.total > 0 ? prog.confirmed / prog.total : 0;
    const rec = recById.get(d.id);

    // The demo tenant carries a seeded 0..1 probability + annual arr. The live pilot
    // (magaya) does not: its amounts are monthly in the CRM and its forecast is a
    // category. Fall back to those so the room reads real numbers, not $0.
    const usesSeededProb = !!(d.repForecastProbability && d.repForecastProbability > 0);
    const arr = d.arr && d.arr > 0 ? d.arr : Math.round((rec?.dealSizeMonthly ?? 0) * 12);
    const repProb = usesSeededProb ? (d.repForecastProbability as number) : categoryToProb(rec?.forecastCategory);
    // DealRipe read: demo override; else, for the pilot, the category DealRipe assigned
    // on the calls; else the qualification temper; else defer to the rep on unseen deals.
    const drProb =
      DEMO_DR_PROB[d.account] ??
      (usesSeededProb
        ? prog.confirmed > 0
          ? Math.round(repProb * completion * 100) / 100
          : repProb
        : rec?.dealRipeCategory
          ? categoryToProb(rec.dealRipeCategory)
          : repProb);
    const repCategory = usesSeededProb ? categoryOf(repProb) : rec?.forecastCategory || categoryOf(repProb);
    const drCategory = usesSeededProb ? categoryOf(drProb) : rec?.dealRipeCategory || categoryOf(drProb);
    const highBlocker = rec ? rec.flags.some((f) => f.severity === "high") : false;
    let reason: string;
    if (DEMO_REASONS[d.account]) {
      reason = DEMO_REASONS[d.account];
    } else if (!usesSeededProb && rec?.blockers && rec.blockers.length > 0) {
      // Live pilot: the specific, named blockers DealRipe caught on this deal's calls
      // (e.g. "Brian, who signs off, has never been on a call. Single-threaded on Pulkit.").
      reason = rec.blockers.slice(0, 3).join(" ");
    } else {
      reason =
        rec?.blockers?.[0] ??
        (rec && rec.verdict.kind !== "none" ? rec.verdict.text : null) ??
        "The calls back the current forecast.";
    }
    const derivedHealth: ForecastHealth =
      drProb < repProb - 0.1 || highBlocker ? "at_risk" : d.daysInStage > 45 ? "stalled" : "healthy";
    // For the live pilot, trust DealRipe's actual call-driven triage (at-risk from
    // blockers, no-shows, buyer gaps) so the room surfaces the same risk deals as the
    // pipeline dashboard and the weekly digest, not just category downgrades.
    const health: ForecastHealth =
      !usesSeededProb && rec?.dealHealth && rec.dealHealth !== "no_data"
        ? (rec.dealHealth as ForecastHealth)
        : derivedHealth;
    return {
      dealId: d.id,
      account: d.account,
      industry: d.industry,
      stageKey: d.stageKey ?? "",
      stageLabel: STAGE_LABELS[d.stageKey ?? ""] ?? (d.stageKey ?? "—"),
      arr,
      repProb,
      drProb,
      repProbPct: Math.round(repProb * 100),
      drProbPct: Math.round(drProb * 100),
      deltaPts: Math.round((drProb - repProb) * 100),
      repCategory,
      drCategory,
      closeDate: d.repForecastCloseDate || rec?.closeDate || null,
      repName: repName(d.repEmail ?? null),
      repEmail: d.repEmail ?? null,
      gatesConfirmed: prog.confirmed,
      gatesTotal: prog.total,
      health,
      reason,
      agreedNextStep: rec?.agreedNextStep ?? null,
    };
  });

  const repWeightedUsd = Math.round(roomDeals.reduce((n, x) => n + x.arr * x.repProb, 0));
  const drWeightedUsd = Math.round(roomDeals.reduce((n, x) => n + x.arr * x.drProb, 0));
  const pipelineTotalUsd = Math.round(roomDeals.reduce((n, x) => n + x.arr, 0));
  const gapToTargetUsd = hasTarget ? Math.max(0, (quarterTargetUsd as number) - drWeightedUsd) : 0;
  const overcommitUsd = Math.max(0, repWeightedUsd - drWeightedUsd);

  // Every deal that needs the leader's attention: a category the rep is running
  // ahead on (delta), OR a deal DealRipe flagged at risk / stalled (buyer gap,
  // no-show, blocker) even if the category matches. Ranked by ARR x how much is at
  // stake — a delta when there is one, else a risk floor — so the big risky deals
  // lead. Deals with a real delta keep their exact prior ordering (seeded demo).
  const riskWeight = (x: ForecastRoomDeal) =>
    x.arr * (x.deltaPts !== 0 ? Math.abs(x.deltaPts) : x.health === "at_risk" ? 20 : x.health === "stalled" ? 8 : 0);
  const changed = roomDeals
    .filter((x) => x.deltaPts !== 0 || x.health !== "healthy")
    .sort((a, b) => riskWeight(b) - riskWeight(a));

  // The prescribed actions that close the gap, from each deal's REAL seeded task,
  // ranked by the forecast lift they carry. Lift scales with the deal size and the
  // rep/DealRipe gap the action would close.
  const taskByDeal = new Map<string, TaskItem>();
  for (const t of tasks) {
    if (t.dealId && !taskByDeal.has(t.dealId)) taskByDeal.set(t.dealId, t); // getTasks is newest-first
  }
  const actions: ForecastRoomAction[] = [];
  for (const x of roomDeals) {
    const t = taskByDeal.get(x.dealId);
    if (!t) continue;
    const gap = Math.max(0.04, x.repProb - x.drProb);
    const liftFrac = x.health === "healthy" ? 0.06 : Math.min(0.2, gap * 0.7 + 0.06);
    const closeProbLiftPts = Math.round(liftFrac * 100);
    const weightedLiftUsd = Math.round(x.arr * liftFrac);
    const confidence: "High" | "Medium" =
      x.gatesConfirmed >= 15 || x.health === "healthy" ? "High" : "Medium";
    const prescribed = (t.detail ?? "").startsWith("DealRipe prescribed");
    actions.push({
      dealId: x.dealId,
      account: x.account,
      title: t.title,
      detail: DEMO_ACTION_DETAIL[x.account] ?? t.detail,
      actionType: t.actionType,
      closeProbLiftPts,
      weightedLiftUsd,
      confidence,
      confidenceNote: `Grounded in ${x.gatesConfirmed} of ${x.gatesTotal} gates confirmed on the calls.`,
      prescribed,
    });
  }
  actions.sort((a, b) => b.weightedLiftUsd - a.weightedLiftUsd);

  const reps = Array.from(
    new Map(roomDeals.filter((x) => x.repEmail).map((x) => [x.repEmail as string, x.repName])).entries(),
  ).map(([email, name]) => ({ email, name }));

  const weekOf = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  });

  return {
    weekOf,
    quarterTargetUsd: quarterTargetUsd ?? 0,
    quarterLabel: hasTarget ? QUARTER_LABEL : "",
    hasTarget,
    pipelineTotalUsd,
    repWeightedUsd,
    drWeightedUsd,
    gapToTargetUsd,
    overcommitUsd,
    deals: roomDeals,
    changed,
    actions,
    calibration: CALIBRATION,
    reps,
  };
}
