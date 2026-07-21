/**
 * Dry-run preview of the Rolldog write-back. Seeds a few FAKE "Yes" extractions
 * on a pilot deal, runs the writer in dry-run mode (composes payloads but sends
 * nothing to Rolldog), prints exactly what WOULD be written to each Rolldog
 * sub-resource, then removes the fake extractions.
 *
 *   npx tsx scripts/preview-writeback.ts            # defaults to morneau (fake seed)
 *   npx tsx scripts/preview-writeback.ts --deal alba
 *   npx tsx scripts/preview-writeback.ts --deal auto:corelogistics.net --real
 *       --real: skip the fake seed and dry-run against the deal's REAL captured
 *       extractions, so you see the actual values that would land in Rolldog.
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
  const real = argv.includes("--real");

  const tenantId = await resolveTenantId(SLUG);
  const db = supabaseAdmin();

  const dealRow = await db
    .from("deals")
    .select("id, account, framework_id, rolldog_opportunity_id")
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
  // Prefer the pilot-config map; fall back to the linked column, since auto
  // deals are linked via deals.rolldog_opportunity_id, not the map.
  const oppId =
    rolldogOppIdForDeal(slug) ??
    (dealRow.data as { rolldog_opportunity_id?: string | null }).rolldog_opportunity_id ??
    null;
  const opp = oppId ?? "(no opp id mapped)";

  console.log("");
  console.log(`Deal:            ${dealRow.data.account} (${slug})`);
  console.log(`Rolldog opp:     ${opp}`);
  console.log(
    `Mode:            DRY RUN, ${real ? "REAL extractions" : "fake seed"} (nothing is written to Rolldog)`,
  );
  console.log("");

  if (!real) {
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
  }

  try {
    const results = await syncDealToRolldog({
      tenantSlug: SLUG,
      dealId,
      rolldogOpportunityId: oppId ?? "PREVIEW",
      dryRun: true,
    });

    console.log("");
    console.log(`===== WOULD WRITE TO ROLLDOG OPP ${opp} =====`);
    let wrote = 0;
    for (const r of results) {
      if (r.status === "skipped") continue;
      wrote += 1;
      console.log("");
      console.log(`  ${r.method}  [${r.status}]  fields: ${r.fieldsWritten.join(", ")}`);
      if (r.payload) {
        console.log(r.payload.split("\n").map((l) => "      " + l).join("\n"));
      }
    }
    if (wrote === 0) {
      console.log("\n  (nothing would write: no confirmed gates with a Rolldog write target)");
    }
    console.log("");
    console.log("=============================================");
    if (real) {
      console.log("These are the REAL captured values that would go to Rolldog.");
      console.log("If they're correct and on the right opp, we enable the live write.");
    } else {
      console.log("Eyeball check: does each sub-resource get the right, non-garbled note?");
      console.log("If it looks right, enable live writes by adding the opp id to");
      console.log("PILOT_OPPORTUNITY_IDS (crm-scope) and deploying.");
    }
  } finally {
    if (!real) {
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
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
