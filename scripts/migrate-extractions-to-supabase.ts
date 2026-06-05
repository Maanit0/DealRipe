/**
 * Migrate Lumora's seed extraction state into Supabase.
 *
 * What this script does (idempotent):
 *   1. Ensures a 'topsort' tenant exists.
 *   2. Inserts the Lumora deal as a deals row, keyed by external_id.
 *   3. Inserts one field_extractions row per Scotsman field from
 *      LUMORA_DEAL.extraction.
 *
 * What this script does NOT do:
 *   - No contacts, calls, or transcripts. Those stay on seed files
 *     for the Friday Paul demo.
 *   - last_updated_from_call_id is left null because calls are not
 *     migrated yet. Step 5 wires the live extraction route, which
 *     will set that column going forward.
 *
 * Flags:
 *   --reset    Delete the topsort tenant first (cascade clears all
 *              child rows), then re-run the full insert. For clean
 *              demo runs.
 *
 * Run:  npm run migrate:extractions
 *       npm run migrate:extractions -- --reset
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { SCOTSMAN_FIELDS, type FieldExtraction } from "../lib/scotsman";
import { LUMORA_DEAL } from "../lib/seed-data";
import { supabaseAdmin } from "../lib/supabase";
import type { Database } from "../lib/database.types";

const TOPSORT_SLUG = "topsort";
const TOPSORT_NAME = "TopSort";

type FieldExtractionInsert =
  Database["public"]["Tables"]["field_extractions"]["Insert"];

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const db = supabaseAdmin();

  if (reset) {
    console.log(`--reset: deleting tenant '${TOPSORT_SLUG}' (cascade)`);
    const { error } = await db.from("tenants").delete().eq("slug", TOPSORT_SLUG);
    if (error) throw new Error(`reset failed: ${error.message}`);
    console.log("  ok, tenant deleted (or did not exist)");
  }

  // ---- 1. Tenant ----
  const tenantSel = await db
    .from("tenants")
    .select("id")
    .eq("slug", TOPSORT_SLUG)
    .maybeSingle();
  if (tenantSel.error) {
    throw new Error(`tenant select failed: ${tenantSel.error.message}`);
  }

  let tenantId: string;
  let tenantStatus: "created" | "skipped";
  if (tenantSel.data) {
    tenantId = tenantSel.data.id;
    tenantStatus = "skipped";
  } else {
    const ins = await db
      .from("tenants")
      .insert({ slug: TOPSORT_SLUG, name: TOPSORT_NAME })
      .select("id")
      .single();
    if (ins.error) throw new Error(`tenant insert failed: ${ins.error.message}`);
    tenantId = ins.data.id;
    tenantStatus = "created";
  }
  console.log(`tenant:            ${tenantStatus} (id=${tenantId})`);

  // ---- 2. Deal ----
  const dealSel = await db
    .from("deals")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("external_id", LUMORA_DEAL.id)
    .maybeSingle();
  if (dealSel.error) {
    throw new Error(`deal select failed: ${dealSel.error.message}`);
  }

  let dealId: string;
  let dealStatus: "created" | "skipped";
  if (dealSel.data) {
    dealId = dealSel.data.id;
    dealStatus = "skipped";
  } else {
    const ins = await db
      .from("deals")
      .insert({
        tenant_id: tenantId,
        external_id: LUMORA_DEAL.id,
        account: LUMORA_DEAL.account,
        industry: LUMORA_DEAL.industry,
        arr: LUMORA_DEAL.arr,
        stage_key: LUMORA_DEAL.stageKey,
        days_in_stage: LUMORA_DEAL.daysInStage,
        rep_forecast_probability: LUMORA_DEAL.repForecastProbability,
        rep_forecast_close_date: LUMORA_DEAL.repForecastCloseDate,
        rep_notes: LUMORA_DEAL.repNotes,
      })
      .select("id")
      .single();
    if (ins.error) throw new Error(`deal insert failed: ${ins.error.message}`);
    dealId = ins.data.id;
    dealStatus = "created";
  }
  console.log(`deal:              ${dealStatus} (id=${dealId})`);

  // ---- 3. Field extractions ----
  const rows: FieldExtractionInsert[] = [];
  for (const field of SCOTSMAN_FIELDS) {
    const entry: FieldExtraction | undefined = LUMORA_DEAL.extraction[field.id];
    if (!entry) continue;
    const base: FieldExtractionInsert = {
      tenant_id: tenantId,
      deal_id: dealId,
      framework_field_key: field.id,
      status: entry.status,
    };
    if (entry.status === "Yes") {
      base.answer = entry.answer;
      base.evidence = entry.evidence;
      base.confidence = entry.confidence;
      base.last_updated_from_call_id = null;
    }
    rows.push(base);
  }

  const upsert = await db
    .from("field_extractions")
    .upsert(rows, {
      onConflict: "deal_id,framework_field_key",
      ignoreDuplicates: true,
    })
    .select("framework_field_key");

  if (upsert.error) {
    throw new Error(`field_extractions upsert failed: ${upsert.error.message}`);
  }

  const inserted = upsert.data?.length ?? 0;
  const skipped = rows.length - inserted;
  console.log(`field_extractions: ${inserted} inserted, ${skipped} skipped`);

  console.log("\nMigration complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err.message ?? err);
  process.exit(1);
});
