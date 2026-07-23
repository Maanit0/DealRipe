/**
 * Exact-content preview of what DealRipe writes to Rolldog for a deal. Runs the
 * real writer in dry-run mode, which composes the same payloads it sends (same
 * stamp, same capping, same field mapping) without any network write. Used by
 * the coverage view and activity log so you can see the precise text and target
 * field, formatting and all, that landed in Rolldog. Read-only, no scope needed
 * (dry-run never calls the write methods).
 */

import { cache } from "react";

import { syncDealToRolldog } from "./crm-writer";
import { rolldogOppIdForDeal } from "./pilot-config";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

export type RolldogFieldWrite = {
  /** Logical sub-resource: budget / timeline / situation / competitors / people / activities. */
  subResource: string;
  /** Human label. */
  label: string;
  /** Where it lands in Rolldog, for the UI subtitle. */
  target: string;
  /** The exact composed content DealRipe writes. */
  payload: string;
};

const META: Record<string, { subResource: string; label: string; target: string }> = {
  writeBudget: { subResource: "budget", label: "Budget", target: "Opportunity › Budget › notes" },
  writeTimeline: { subResource: "timeline", label: "Timeline", target: "Opportunity › Timeline" },
  writeSituation: { subResource: "situation", label: "Situation", target: "Opportunity › Situation" },
  writeCompetitionNotes: { subResource: "competitors", label: "Competition", target: "Opportunity › Competitors › notes" },
  writeParticipantNotes: { subResource: "people", label: "People", target: "Opportunity › People › notes" },
  writeNextStep: { subResource: "activities", label: "Next step", target: "Opportunity › Interactions tab (activity)" },
};

function cleanPayload(method: string, raw: string): string {
  // The writer prefixes notes payloads with "notes:\n"; strip it for display.
  // Situation/timeline come through as JSON, which we leave as-is (it is exactly
  // the structured body sent). The next-step payload is left verbatim.
  if (method === "writeBudget" || method === "writeCompetitionNotes" || method === "writeParticipantNotes") {
    return raw.replace(/^notes:\s*\n?/, "").trim();
  }
  return raw.trim();
}

/**
 * The composed Rolldog writes for a deal, in the exact form DealRipe sends.
 * Memoized per request so a deal that appears twice (e.g. two calls) is composed
 * once. Returns [] on any failure.
 */
export const getRolldogWritePreview = cache(
  async (
    tenantSlug: string,
    dealId: string,
    rolldogOpportunityId: string,
    nextAction?: string,
  ): Promise<RolldogFieldWrite[]> => {
    try {
      const results = await syncDealToRolldog({
        tenantSlug,
        dealId,
        rolldogOpportunityId,
        dryRun: true,
        nextAction,
      });
      const out: RolldogFieldWrite[] = [];
      for (const r of results) {
        if (r.status !== "preview" || !r.payload) continue;
        const meta = META[r.method];
        if (!meta) continue;
        out.push({ ...meta, payload: cleanPayload(r.method, r.payload) });
      }
      return out;
    } catch {
      return [];
    }
  },
);

/**
 * Resolve each deal's Rolldog opportunity and fetch its composed write content.
 * Deals with no Rolldog link are omitted. Used by views that have deal ids but
 * not the opportunity id (e.g. the raw activity log).
 */
export async function getRolldogWritePreviewByDeals(
  tenantSlug: string,
  dealIds: string[],
): Promise<Map<string, RolldogFieldWrite[]>> {
  const out = new Map<string, RolldogFieldWrite[]>();
  const unique = Array.from(new Set(dealIds.filter(Boolean)));
  if (unique.length === 0) return out;

  const tenantId = await resolveTenantId(tenantSlug);
  const rows = await supabaseAdmin()
    .from("deals")
    .select("id, external_id, rolldog_opportunity_id")
    .eq("tenant_id", tenantId)
    .in("id", unique);

  const deals = (rows.data ?? []) as Array<{ id: string; external_id: string | null; rolldog_opportunity_id: string | null }>;
  await Promise.all(
    deals.map(async (d) => {
      const opp = (d.external_id ? rolldogOppIdForDeal(d.external_id) : null) ?? d.rolldog_opportunity_id;
      if (!opp) return;
      const writes = await getRolldogWritePreview(tenantSlug, d.id, String(opp));
      if (writes.length > 0) out.set(d.id, writes);
    }),
  );
  return out;
}
