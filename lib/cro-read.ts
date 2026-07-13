/**
 * Mark's day-0 read (CRO baseline) per deal. Reference only: captured so the
 * pilot can compare his gut call against what DealRipe surfaces at day 30. It
 * never drives any logic or write-back.
 */

import { supabaseAdmin } from "./supabase";

export type CroRead = {
  forecastCategory: string | null; // "Commit" | "Expect" | "Pipeline"
  winProbability: number | null; // 0-100
  expectedClose: string | null; // free text, e.g. "September 2026"
  economicBuyerEngaged: string | null; // "Yes" | "No" | "Not sure"
  biggestUnknown: string | null;
  notes: string | null;
  updatedAt: string | null;
};

/** Read a deal's CRO baseline, or null if none saved yet. */
export async function getCroRead(dealId: string): Promise<CroRead | null> {
  const db = supabaseAdmin();
  const res = await db
    .from("deal_cro_read")
    .select(
      "forecast_category, win_probability, expected_close, economic_buyer_engaged, biggest_unknown, notes, updated_at",
    )
    .eq("deal_id", dealId)
    .maybeSingle();
  if (res.error || !res.data) return null;
  const d = res.data;
  return {
    forecastCategory: d.forecast_category,
    winProbability: d.win_probability,
    expectedClose: d.expected_close,
    economicBuyerEngaged: d.economic_buyer_engaged,
    biggestUnknown: d.biggest_unknown,
    notes: d.notes,
    updatedAt: d.updated_at,
  };
}

/** Upsert a deal's CRO baseline (one row per deal). */
export async function upsertCroRead(args: {
  tenantId: string;
  dealId: string;
  read: CroRead;
}): Promise<void> {
  const db = supabaseAdmin();
  const res = await db.from("deal_cro_read").upsert(
    {
      tenant_id: args.tenantId,
      deal_id: args.dealId,
      forecast_category: args.read.forecastCategory,
      win_probability: args.read.winProbability,
      expected_close: args.read.expectedClose,
      economic_buyer_engaged: args.read.economicBuyerEngaged,
      biggest_unknown: args.read.biggestUnknown,
      notes: args.read.notes,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "deal_id" },
  );
  if (res.error) {
    throw new Error(`deal_cro_read upsert failed for deal ${args.dealId}: ${res.error.message}`);
  }
}
