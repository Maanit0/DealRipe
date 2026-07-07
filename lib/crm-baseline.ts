/**
 * Day-0 CRM baseline capture.
 *
 * At pilot start we freeze what the connected CRM (Rolldog) reports for each
 * pilot deal. This snapshot is the "before" picture: it lets the pilot show
 * the CRM's day-0 state versus what DealRipe verifies from calls over 90 days,
 * and it seeds first-call briefings with reported-but-unverified context.
 *
 * Hard rule: everything captured here is REFERENCE ONLY. It is never merged
 * into the verified ledger and never marks a SQL gate as confirmed. The gate
 * ledger lives in field_extractions and fills only from captured calls.
 */

import type { Framework } from "./framework";
import { getFrameworkForDeal } from "./framework";
import type { DealRoom } from "./rolldog";
import { getDealRoom } from "./rolldog";
import { buildExtractionFromRolldog } from "./rolldog-briefing-context";
import { summaryFromCore, stageKeyFromSummary, type RolldogSummary } from "./rolldog-summary";
import { supabaseAdmin } from "./supabase";
import type { Json } from "./database.types";

/**
 * The frozen baseline payload. `reportedFields` mirrors buildExtractionFromRolldog:
 * which framework fields the CRM claims to hold (status "Yes" with the reported
 * value) versus blank (status "Unknown"). These are UNVERIFIED: a "Yes" here
 * means "the CRM reports this, verify it on a call," not "confirmed."
 */
export type CrmBaseline = {
  capturedAt: string;
  source: "rolldog";
  verified: false;
  summary: RolldogSummary;
  stageKey: string | null;
  nextStep: unknown;
  closeDate: string | null;
  reportedFields: Record<string, unknown>;
};

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v;
  if (typeof v === "number") return String(v);
  return null;
}

/** Pure builder: turn a Rolldog deal room + framework into the frozen payload. */
export function buildCrmBaseline(framework: Framework, room: DealRoom): CrmBaseline {
  const summary = summaryFromCore(room.core as Record<string, unknown>);
  const core = room.core as Record<string, unknown>;
  return {
    capturedAt: new Date().toISOString(),
    source: "rolldog",
    verified: false,
    summary,
    stageKey: stageKeyFromSummary(summary),
    nextStep: core["next-step"] ?? null,
    closeDate: str(core["close-date"]),
    reportedFields: buildExtractionFromRolldog(framework, room) as Record<string, unknown>,
  };
}

/**
 * Read Rolldog for one pilot deal and freeze its day-0 baseline into
 * deal_crm_baseline (one row per deal; re-running upserts). Returns the
 * payload written, or null if the deal has no framework.
 */
export async function captureCrmBaseline(args: {
  tenantId: string;
  dealId: string;
  opportunityId: string;
}): Promise<CrmBaseline | null> {
  const framework = await getFrameworkForDeal(args.dealId);
  if (!framework) return null;

  const room = await getDealRoom(args.opportunityId);
  const baseline = buildCrmBaseline(framework, room);

  const db = supabaseAdmin();
  const res = await db.from("deal_crm_baseline").upsert(
    {
      tenant_id: args.tenantId,
      deal_id: args.dealId,
      rolldog_opportunity_id: args.opportunityId,
      captured_at: baseline.capturedAt,
      payload: baseline as unknown as Json,
    },
    { onConflict: "deal_id" },
  );
  if (res.error) {
    throw new Error(`deal_crm_baseline upsert failed for deal ${args.dealId}: ${res.error.message}`);
  }
  return baseline;
}

/** Read a deal's frozen baseline, or null if none captured yet. */
export async function getCrmBaseline(dealId: string): Promise<CrmBaseline | null> {
  const db = supabaseAdmin();
  const res = await db
    .from("deal_crm_baseline")
    .select("payload")
    .eq("deal_id", dealId)
    .maybeSingle();
  if (res.error) throw new Error(`deal_crm_baseline read failed: ${res.error.message}`);
  return (res.data?.payload as unknown as CrmBaseline) ?? null;
}
