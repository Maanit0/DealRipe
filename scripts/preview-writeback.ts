/**
 * Dry-run preview of the Rolldog write-back. Seeds a few FAKE "Yes" extractions
 * on a pilot deal, runs the writer in dry-run mode (composes payloads but sends
 * nothing to Rolldog), prints exactly what WOULD be written to each Rolldog
 * sub-resource, then removes the fake extractions.
 *
 *   npx tsx scripts/preview-writeback.ts            # defaults to morneau
 *   npx tsx scripts/preview-writeback.ts --deal alba
 *
 * No Rolldog calls, no scope needed, safe to run against live. Requires
 * Supabase only. Use this to validate the mapping before enabling live writes.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { syncDealToRolldog } from "../lib/crm-writer";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SLUG = "magaya";

// Fake Yes extractions covering three sub-resources (budget / situation /
// timeline). Field keys match the Magaya framework.
const FAKE = [
  {
    framework_field_key: "budget_range_stated",
    answer: "Budget is earmarked at forty to sixty thousand for this project.",
    evidence: "We've set aside forty to sixty thousand for this.",
    confidence: 0.94,
  },
  {
    framework_field_key: "why_looking_now",
    answer: "October go-live is board-mandated, so timing is fixed.",
    evidence: "The board wants us live before peak season in October.",
    confidence: 0.9,
  },
  {
    framework_field_key: "close_date_validated",
    answer: "Customer confirmed they need to sign in time for the October go-live.",
    evidence: "We need this signed with enough runway to be live by October.",
    confidence: 0.9,
  },
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dealIdx = argv.indexOf("--deal");
  const slug = dealIdx !== -1 ? argv[dealIdx + 1] : "morneau";

  const tenantId = await resolveTenantId(SLUG);
  const db = supabaseAdmin();

  const dealRow = await db
    .from("deals")
    .select("id, account, framework_id")
    .eq("tenant_id", tenantId)
    .eq("external_id", slug)
    .maybeSingle();
  if (dealRow.error || !dealRow.data) {
    console.error(`Deal '${slug}' not found. Seed it first.`);
    process.exit(1);
  }
  if (!dealRow.data.framework_id) {
    console.error(`Deal '${slug}' has no framework_id.`);
    process.exit(1);
  }
  const dealId = dealRow.data.id;
  const opp = rolldogOppIdForDeal(slug) ?? "(no opp id mapped)";

  console.log("");
  console.log(`Deal:            ${dealRow.data.account} (${slug})`);
  console.log(`Rolldog opp:     ${opp}`);
  console.log(`Mode:            DRY RUN (nothing is written to Rolldog)`);
  console.log("");
  console.log("Seeding fake Yes extractions for the preview...");

  for (const f of FAKE) {
    const r = await db.from("field_extractions").upsert(
      {
        tenant_id: tenantId,
        deal_id: dealId,
        framework_id: dealRow.data.framework_id,
        framework_field_key: f.framework_field_key,
        status: "Yes",
        answer: f.answer,
        evidence: f.evidence,
        confidence: f.confidence,
      },
      { onConflict: "deal_id,framework_field_key" },
    );
    if (r.error) {
      console.error(`  seed failed (${f.framework_field_key}): ${r.error.message}`);
      process.exit(1);
    }
  }

  try {
    const results = await syncDealToRolldog({
      tenantSlug: SLUG,
      dealId,
      rolldogOpportunityId: rolldogOppIdForDeal(slug) ?? "PREVIEW",
      dryRun: true,
    });

    console.log("");
    console.log(`===== WOULD WRITE TO ROLLDOG OPP ${opp} =====`);
    for (const r of results) {
      if (r.status === "skipped") continue;
      console.log("");
      console.log(`  ${r.method}  [${r.status}]  fields: ${r.fieldsWritten.join(", ")}`);
      if (r.payload) {
        console.log(r.payload.split("\n").map((l) => "      " + l).join("\n"));
      }
    }
    console.log("");
    console.log("=============================================");
    console.log("Eyeball check: does each sub-resource get the right, non-garbled note?");
    console.log("If it looks right, enable live writes by adding the opp id to");
    console.log("PILOT_OPPORTUNITY_IDS (crm-scope) and deploying.");
  } finally {
    // Remove the fake extractions so they don't pollute the real deal.
    const del = await db
      .from("field_extractions")
      .delete()
      .eq("deal_id", dealId)
      .in(
        "framework_field_key",
        FAKE.map((f) => f.framework_field_key),
      );
    if (del.error) {
      console.error(`\nWARNING: failed to clean up fake extractions: ${del.error.message}`);
      console.error("Delete them manually so they don't affect the real deal.");
    } else {
      console.log("\n(Cleaned up the fake preview extractions.)");
    }
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
