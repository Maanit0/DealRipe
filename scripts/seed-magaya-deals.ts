/**
 * Seed the 3 Magaya pilot deals (+ their contacts) into Supabase so the
 * live UI has data to render. Idempotent: upserts on (tenant_id, external_id).
 *
 *   npx tsx scripts/seed-magaya-deals.ts
 *
 * The three pilot deals (reps chose them Jul 2 2026; Mark delegated the pick):
 *   aquagulf (Eduardo), martinbrower (Juan), omniva (Juan).
 *
 * external_id = a stable slug that MATCHES pilot-config.ts dealExternalId, so
 * calendar-sync can resolve the meeting to this deal. It is NOT the Rolldog
 * opportunity id: aquagulf isn't in Rolldog yet, and write-back is a later,
 * per-deal step. The Rolldog opp id (for PILOT_OPPORTUNITY_IDS / write-back)
 * gets wired once each deal exists in Rolldog.
 *
 * ARR, close date, and forecast are day-0 placeholders (reps use Rolldog
 * forecast categories, not %); they refresh from Rolldog once read is live.
 * stage_key = the SQL stage the reps stated on the onboarding call (all SQL2).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";
const FRAMEWORK_NAME = "Magaya Rolldog";

type ContactSeed = {
  external_id?: string;
  name: string;
  role: string;
  relationship: "champion" | "influencer" | "economic_buyer" | "user" | "unknown";
  last_contacted_at?: string | null;
};

type DealSeed = {
  external_id: string; // Rolldog opportunity id
  account: string;
  industry: string;
  arr: number; // annual value (USD)
  stage_key: string; // SQL1..SQL5
  days_in_stage: number;
  rep_forecast_probability: number; // 0..1
  rep_forecast_close_date: string; // ISO date
  rep_notes: string;
  contacts: ContactSeed[];
};

// ---------------------------------------------------------------------
// Pilot deals (2026-07): Eduardo -> Groupe Morneau (81714), Alba Wheels Up
// (78273). Juan -> Martin Brower, Omniva (opp ids pending from Juan). Aqua
// Gulf deferred (not in Rolldog yet). external_id = the slug used across
// pilot-config; Rolldog opp ids are mapped separately in PILOT_DEAL_ROLLDOG_IDS.
// ---------------------------------------------------------------------
const DEALS: DealSeed[] = [
  {
    external_id: "morneau", // Eduardo; Rolldog opp 81714 (mapped in pilot-config)
    account: "Groupe Morneau",
    industry: "Transport / logistics",
    arr: 0, // refreshes from Rolldog once read sync is live
    stage_key: "SQL2", // placeholder; refresh from Rolldog
    days_in_stage: 0,
    rep_forecast_probability: 0.3,
    rep_forecast_close_date: "2026-12-31", // placeholder
    rep_notes: "Eduardo. Rolldog opp 81714. Domain morneauglobal.com. Refresh stage/close from Rolldog.",
    contacts: [],
  },
  {
    external_id: "alba", // Eduardo; Rolldog opp 78273 (mapped in pilot-config)
    account: "Alba Wheels Up",
    industry: "Customs brokerage / logistics",
    arr: 0,
    stage_key: "SQL2", // placeholder; refresh from Rolldog
    days_in_stage: 0,
    rep_forecast_probability: 0.3,
    rep_forecast_close_date: "2026-12-31", // placeholder
    rep_notes: "Eduardo. Rolldog opp 78273. Domain albawheelsup.com. Refresh stage/close from Rolldog.",
    contacts: [],
  },
  {
    external_id: "martinbrower", // Juan
    account: "Martin Brower",
    industry: "Supply chain / logistics distribution",
    arr: 0,
    stage_key: "SQL2",
    days_in_stage: 0,
    rep_forecast_probability: 0.3,
    rep_forecast_close_date: "2026-12-31", // placeholder; confirm with Juan
    rep_notes: "Juan. Early/mid stage (SQL2). Confirm Rolldog opp id + close date.",
    contacts: [],
  },
  {
    external_id: "omniva", // Juan
    account: "Omniva",
    industry: "Postal / logistics",
    arr: 0,
    stage_key: "SQL2",
    days_in_stage: 0,
    rep_forecast_probability: 0.3,
    rep_forecast_close_date: "2026-12-31", // placeholder; confirm with Juan
    rep_notes: "Juan. Early/mid stage (SQL2). Confirm Rolldog opp id + close date.",
    contacts: [],
  },
];

async function main(): Promise<void> {
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId(TENANT_SLUG);

  const fwRow = await db
    .from("qualification_frameworks")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("name", FRAMEWORK_NAME)
    .maybeSingle();
  if (fwRow.error || !fwRow.data) {
    console.error(`Framework "${FRAMEWORK_NAME}" not found. Run seed-magaya-framework.ts first.`);
    process.exit(1);
  }
  const frameworkId = fwRow.data.id;

  console.log(`tenant: ${TENANT_SLUG} (${tenantId})  framework: ${frameworkId}`);

  for (const d of DEALS) {
    const dealUpsert = await db
      .from("deals")
      .upsert(
        {
          tenant_id: tenantId,
          external_id: d.external_id,
          account: d.account,
          industry: d.industry,
          arr: d.arr,
          stage_key: d.stage_key,
          days_in_stage: d.days_in_stage,
          rep_forecast_probability: d.rep_forecast_probability,
          rep_forecast_close_date: d.rep_forecast_close_date,
          rep_notes: d.rep_notes,
          framework_id: frameworkId,
        },
        { onConflict: "tenant_id,external_id" },
      )
      .select("id")
      .single();
    if (dealUpsert.error || !dealUpsert.data) {
      console.error(`deal upsert failed (${d.account}): ${dealUpsert.error?.message}`);
      process.exit(1);
    }
    const dealId = dealUpsert.data.id;

    for (const c of d.contacts) {
      const cUpsert = await db.from("contacts").upsert(
        {
          tenant_id: tenantId,
          deal_id: dealId,
          external_id: c.external_id ?? null,
          name: c.name,
          role: c.role,
          relationship: c.relationship,
          last_contacted_at: c.last_contacted_at ?? null,
        },
        { onConflict: "deal_id,name" },
      );
      if (cUpsert.error) {
        console.error(`contact upsert failed (${c.name}): ${cUpsert.error.message}`);
        process.exit(1);
      }
    }
    console.log(`  deal: ${d.account} (id=${dealId}, ${d.contacts.length} contact(s))`);
  }

  console.log(`seed-magaya-deals complete: ${DEALS.length} deal(s).`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
