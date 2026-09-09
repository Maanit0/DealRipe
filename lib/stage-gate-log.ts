/**
 * Record WHEN the rep ticked a Rolldog stage-requirement item.
 *
 * DealRipe has read this checklist since the pilot began and stored none of it.
 * lib/deal-context.ts fetches it, renders it into a briefing prompt and drops
 * it, so the one thing the checklist knows that nothing else does -- that the
 * rep confirmed the signing authority on a Tuesday, two days after a call --
 * has been discarded every four hours for two months.
 *
 * Rolldog has no history endpoint. Every tick that happens today is gone
 * tomorrow, which is why this shipped ahead of work worth more.
 *
 * WHAT IT DELIBERATELY DOES NOT LOG. A re-observation that changes nothing. The
 * snapshot table is the cautionary tale: deal_signal_snapshots writes a
 * capturedAt into its own payload, so a byte comparison of consecutive days
 * differs always and 47 "changes" over 48 days were really 8. An event log that
 * fires on every read is a read log.
 *
 * A FALSE IS UNSET, NOT "NO". Rolldog gives one boolean per item with no third
 * state. Only a positive tick carries information, which is why to_ticked=false
 * is recorded as "the tick was removed" and never as the rep answering no.
 * Reading a false as a recorded negative once produced a briefing telling a
 * paying customer in onboarding that Magaya was not their selected vendor.
 *
 * Nothing reads this yet, and that is stated rather than hidden.
 */

import { runWithAuthorizedOpportunities } from "./crm-scope";
import { rolldogOppIdForDeal } from "./pilot-config";
import { getStageRequirements, type RolldogStageRequirements } from "./rolldog";
import { stageKeyForPosition } from "./stage-gates";
import { supabaseAdmin } from "./supabase";

/**
 * The four spellings lib/deal-context.ts already uses. Reused rather than
 * redefined so a reader joining this table to a DealContext does not have to
 * translate between two vocabularies for the same fact.
 */
export type ChecklistReadStatus = "present" | "no_opportunity" | "no_checklist" | "unavailable";

export type GateSweepResult = {
  dealId: string;
  opportunityId: string | null;
  status: ChecklistReadStatus;
  /** Null unless status is "present". Never 0 for a read that failed. */
  tickedCount: number | null;
  totalCount: number | null;
  /** Events this sweep would write, or wrote. */
  changes: GateChange[];
  skippedRecentlyRead: boolean;
  error?: string;
};

export type GateChange = {
  rolldogId: number;
  itemName: string;
  stageKey: string | null;
  /** Null on the first observation of an item, which is not the same as false. */
  fromTicked: boolean | null;
  toTicked: boolean;
};

/** How long a checklist read stays fresh. See the note on cost below. */
const RESWEEP_AFTER_HOURS = 12;

type DealRow = { id: string; external_id: string | null; rolldog_opportunity_id: string | null };

function opportunityFor(d: DealRow): string | null {
  const opp = (d.external_id ? rolldogOppIdForDeal(d.external_id) : null) ?? d.rolldog_opportunity_id;
  return opp ? String(opp) : null;
}

/** Flatten Rolldog's stage-nested payload into one item list. */
function itemsOf(raw: RolldogStageRequirements): GateChange[] {
  const out: GateChange[] = [];
  for (const stage of raw.stages ?? []) {
    const stageKey = Number.isFinite(stage.position) ? stageKeyForPosition(stage.position) : null;
    for (const item of stage.attributes ?? []) {
      out.push({
        rolldogId: item.id,
        itemName: (item.name ?? "").trim(),
        stageKey,
        fromTicked: null,
        toTicked: item.value === true,
      });
    }
  }
  return out;
}

/**
 * The last state we recorded for each item on one deal.
 *
 * Read from the event log itself rather than from a separate current-state
 * table, so there is exactly one place a tick is recorded and no second copy to
 * drift. Keyed on rolldog_id, never on the name: the live payload contains a
 * leading space in " Create Initial Close Plan and Presented" and a typo in
 * "Validate Who Negotiate and Signs".
 */
async function lastKnown(dealId: string): Promise<Map<number, boolean>> {
  const res = await supabaseAdmin()
    .from("rolldog_gate_events")
    .select("rolldog_id, to_ticked, observed_at")
    .eq("deal_id", dealId)
    .order("observed_at", { ascending: true });
  // THROWS rather than returning empty. An empty map means "we have never seen
  // this deal", and the differ treats that as first observation: every already
  // ticked item would be rewritten as a fresh from_ticked=null event and the
  // real trajectory replaced with today's date. A failed read presented as no
  // prior state is exactly the mistake this module exists to stop, so it must
  // not be the mistake this module makes.
  if (res.error) throw new Error(`prior gate state unreadable for deal ${dealId}: ${res.error.message}`);
  const out = new Map<number, boolean>();
  // Ascending, so the last write for an id wins.
  for (const r of res.data ?? []) out.set(Number(r.rolldog_id), r.to_ticked === true);
  return out;
}

/**
 * Sweep one deal's checklist and record what moved.
 *
 * THE AUTHORIZATION SHAPE MATTERS AND IS COPIED FROM lib/snapshot.ts:195-203.
 * runWithAuthorizedOpportunities is AsyncLocalStorage-based, so authorization
 * does not survive into a detached promise, a queued job or a worker. The read
 * therefore happens INSIDE the wrapper and the Supabase writes happen after it,
 * which is safe because the writes need no Rolldog authorization. Nothing is
 * deferred and nothing is queued.
 *
 * One opportunity per call, never a batch array: passing several would widen
 * authorization for the whole callback.
 */
export async function sweepDealChecklist(args: {
  tenantId: string;
  deal: DealRow;
  /** Skip the read when this deal was swept inside the window. */
  respectRateGate?: boolean;
  apply: boolean;
}): Promise<GateSweepResult> {
  const db = supabaseAdmin();
  const dealId = args.deal.id;
  const oppId = opportunityFor(args.deal);

  if (!oppId) {
    if (args.apply) await recordRead(args.tenantId, dealId, null, "no_opportunity", null);
    return { dealId, opportunityId: null, status: "no_opportunity", tickedCount: null, totalCount: null, changes: [], skippedRecentlyRead: false };
  }

  if (args.respectRateGate !== false) {
    const since = new Date(Date.now() - RESWEEP_AFTER_HOURS * 3600_000).toISOString();
    const recent = await db
      .from("rolldog_checklist_reads")
      .select("id")
      .eq("deal_id", dealId)
      .gte("read_at", since)
      .limit(1);
    if ((recent.data ?? []).length > 0) {
      return { dealId, opportunityId: oppId, status: "present", tickedCount: null, totalCount: null, changes: [], skippedRecentlyRead: true };
    }
  }

  let raw: RolldogStageRequirements | null;
  try {
    raw = await runWithAuthorizedOpportunities([oppId], () => getStageRequirements(oppId));
  } catch (err) {
    // getStageRequirements returns null ONLY on 404 and throws on everything
    // else, deliberately, so a checklist we could not read is never mistaken
    // for one that is empty. That distinction has to survive being stored.
    const error = err instanceof Error ? err.message : String(err);
    if (args.apply) await recordRead(args.tenantId, dealId, oppId, "unavailable", null, error);
    return { dealId, opportunityId: oppId, status: "unavailable", tickedCount: null, totalCount: null, changes: [], skippedRecentlyRead: false, error };
  }

  if (!raw) {
    if (args.apply) await recordRead(args.tenantId, dealId, oppId, "no_checklist", null);
    return { dealId, opportunityId: oppId, status: "no_checklist", tickedCount: null, totalCount: null, changes: [], skippedRecentlyRead: false };
  }

  const items = itemsOf(raw);
  const prior = await lastKnown(dealId);
  const seeding = prior.size === 0;

  const changes: GateChange[] = [];
  for (const item of items) {
    const before = prior.get(item.rolldogId);
    if (before === undefined) {
      // First observation. An unticked item is not an event: recording every
      // false on first sight would write ~31 rows per deal that say nothing
      // happened. Only a tick is worth a floor.
      if (item.toTicked) changes.push({ ...item, fromTicked: null });
      continue;
    }
    if (before !== item.toTicked) changes.push({ ...item, fromTicked: before });
  }

  const tickedCount = items.filter((i) => i.toTicked).length;
  if (args.apply) {
    if (changes.length > 0) {
      const rows = changes.map((c) => ({
        tenant_id: args.tenantId,
        deal_id: dealId,
        opportunity_id: oppId,
        rolldog_id: c.rolldogId,
        item_name: c.itemName || null,
        stage_key: c.stageKey,
        from_ticked: c.fromTicked,
        to_ticked: c.toTicked,
        source: seeding ? "seed" : "sweep",
      }));
      const ins = await db.from("rolldog_gate_events").insert(rows);
      if (ins.error) {
        // Best effort by design: instrumentation must never fail the sweep it
        // rides on. The read row still gets written, so the gap is visible.
        console.error(`[stage-gate-log] event write failed (deal=${dealId}): ${ins.error.message}`);
      }
    }
    await recordRead(args.tenantId, dealId, oppId, "present", {
      ticked: tickedCount,
      total: items.length,
      position: raw.currentStagePosition,
    });
  }

  return { dealId, opportunityId: oppId, status: "present", tickedCount, totalCount: items.length, changes, skippedRecentlyRead: false };
}

async function recordRead(
  tenantId: string,
  dealId: string,
  oppId: string | null,
  status: ChecklistReadStatus,
  counts: { ticked: number; total: number; position: number | null } | null,
  error?: string,
): Promise<void> {
  const res = await supabaseAdmin().from("rolldog_checklist_reads").insert({
    tenant_id: tenantId,
    deal_id: dealId,
    opportunity_id: oppId,
    status,
    // NULL unless present. A failed read must never store a zero, which would
    // read downstream as "the rep has ticked nothing".
    ticked_count: counts?.ticked ?? null,
    total_count: counts?.total ?? null,
    current_stage_position: counts?.position ?? null,
    error: error ?? null,
  });
  if (res.error) console.error(`[stage-gate-log] read-status write failed (deal=${dealId}): ${res.error.message}`);
}

/**
 * Sweep every live deal in the tenant.
 *
 * Resolved deals are excluded for the same reason lib/snapshot.ts excludes
 * them: a deal that has closed has no more ticks to record, and eleven of them
 * accrued 213 pointless snapshots before anyone noticed.
 *
 * ON COST. Every assertScopedRead writes a crm_access_log row whether it passes
 * or fails, and snapshot already performs one scoped read per linked
 * opportunity per run. Reading the checklist on the same cadence would double
 * that volume for a list a human ticks a few times a month, so the sweep is
 * gated to once per opportunity per 12 hours.
 */
export async function sweepAllChecklists(args: {
  tenantId: string;
  apply: boolean;
  dealIds?: string[];
  respectRateGate?: boolean;
}): Promise<GateSweepResult[]> {
  const db = supabaseAdmin();

  // PREFLIGHT, before a single Rolldog call. This module can be deployed before
  // supabase/add-rolldog-gate-events.sql has been applied by hand, and without
  // this check the sweep would read ~63 opportunities every four hours, write a
  // crm_access_log row for each, and discard all of it. Throwing costs one
  // round trip and is visible in the cron response; the silent version is 378
  // wasted scoped reads a day that look exactly like a working feature.
  const probe = await db.from("rolldog_gate_events").select("id").limit(1);
  if (probe.error) {
    throw new Error(
      `rolldog_gate_events is not readable, skipping the sweep rather than reading Rolldog for nothing: ${probe.error.message}. ` +
        `Apply supabase/add-rolldog-gate-events.sql.`,
    );
  }

  let q = db
    .from("deals")
    .select("id, external_id, rolldog_opportunity_id, outcome_label")
    .eq("tenant_id", args.tenantId);
  if (args.dealIds?.length) q = q.in("id", args.dealIds);
  const res = await q;
  if (res.error) throw new Error(`deal read failed: ${res.error.message}`);

  const deals = (res.data ?? []).filter((d) => args.dealIds?.length || !d.outcome_label) as Array<DealRow & { outcome_label: string | null }>;

  const out: GateSweepResult[] = [];
  await Promise.all(
    deals.map(async (deal) => {
      try {
        out.push(await sweepDealChecklist({ tenantId: args.tenantId, deal, apply: args.apply, respectRateGate: args.respectRateGate }));
      } catch (err) {
        out.push({
          dealId: deal.id,
          opportunityId: opportunityFor(deal),
          status: "unavailable",
          tickedCount: null,
          totalCount: null,
          changes: [],
          skippedRecentlyRead: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  return out;
}
