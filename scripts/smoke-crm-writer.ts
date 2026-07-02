/**
 * Smoke test for lib/crm-writer.ts.
 *
 * Seeds a few fake "Yes" field_extractions for a Magaya test deal
 * (covering budget / situation / timeline), runs syncDealToRolldog
 * against the sandbox opportunity 80949, and prints the deal room
 * before + after so you can diff.
 *
 * Prereqs:
 *   1. The "Magaya Rolldog" framework is seeded for tenant magaya:
 *        npx tsx scripts/seed-magaya-framework.ts --tenant magaya
 *   2. A magaya deal with external_id = TEST_DEAL_1 exists. Easiest way:
 *        npm run test:pilot-sync -- --ensure-deal --domains test.com:TEST_DEAL_1
 *      (the deal's framework_id will be auto-backfilled by the seed re-run
 *       since seed-magaya-framework includes a re-point step).
 *   3. Rolldog credentials in .env.local.
 *
 * Run:
 *   npx tsx scripts/smoke-crm-writer.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  __setPilotOpportunityIdsForTesting,
  flushAuditWrites,
} from "../lib/crm-scope";
import { syncDealToRolldog } from "../lib/crm-writer";
import { getDealRoom } from "../lib/rolldog";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";
const OPP = "80949";
const DEAL_EXTERNAL_ID = "TEST_DEAL_1";

// Three Yes extractions covering three sub-resources so every active
// dispatch branch fires (writeBudget, writeSituation, writeTimeline).
const FAKE_YES_EXTRACTIONS = [
  {
    framework_field_key: "budget_range_stated",
    answer: "Customer has fifty to two hundred thousand dollars allocated.",
    evidence:
      "We've got about fifty to two hundred thousand allocated for this.",
    confidence: 0.95,
  },
  {
    framework_field_key: "why_looking_now",
    answer: "Fiscal year ends in Q3, budget expires if not used.",
    evidence:
      "Our fiscal year ends in Q3 and we lose the budget if we don't use it.",
    confidence: 0.92,
  },
  {
    framework_field_key: "close_date_validated",
    answer:
      "Customer confirmed they want to close by Friday June 27, two weeks out.",
    evidence: "We need to be signed by Friday June 27 at the latest.",
    confidence: 0.9,
  },
];

async function main(): Promise<void> {
  __setPilotOpportunityIdsForTesting([OPP]);

  const db = supabaseAdmin();
  const tenantId = await resolveTenantId(TENANT_SLUG);

  // Locate the deal uuid by external_id.
  const dealRow = await db
    .from("deals")
    .select("id, framework_id")
    .eq("tenant_id", tenantId)
    .eq("external_id", DEAL_EXTERNAL_ID)
    .maybeSingle();
  if (dealRow.error || !dealRow.data) {
    console.error(
      `Could not find deal external_id='${DEAL_EXTERNAL_ID}' in tenant '${TENANT_SLUG}'.`,
    );
    console.error(
      "Create it via:  npm run test:pilot-sync -- --ensure-deal --domains test.com:TEST_DEAL_1",
    );
    process.exit(1);
  }
  const dealId = dealRow.data.id;
  console.log(`tenant: ${TENANT_SLUG} (id=${tenantId})`);
  console.log(`deal:   ${DEAL_EXTERNAL_ID} (id=${dealId})`);

  // Need framework_id for the field_extractions upsert (the schema
  // enforces tenant_alignment via framework_id when non-null).
  const fwRow = await db
    .from("qualification_frameworks")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("name", "Magaya Rolldog")
    .maybeSingle();
  if (fwRow.error || !fwRow.data) {
    console.error(
      'No "Magaya Rolldog" framework registered. Run: npx tsx scripts/seed-magaya-framework.ts --tenant magaya',
    );
    process.exit(1);
  }
  const frameworkId = fwRow.data.id;

  console.log("");
  console.log("seeding fake Yes extractions:");
  for (const f of FAKE_YES_EXTRACTIONS) {
    const r = await db
      .from("field_extractions")
      .upsert(
        {
          tenant_id: tenantId,
          deal_id: dealId,
          framework_id: frameworkId,
          framework_field_key: f.framework_field_key,
          status: "Yes",
          answer: f.answer,
          evidence: f.evidence,
          confidence: f.confidence,
        },
        { onConflict: "deal_id,framework_field_key" },
      );
    if (r.error) {
      console.error(
        `field_extractions upsert failed for '${f.framework_field_key}': ${r.error.message}`,
      );
      process.exit(1);
    }
    console.log(`  ${f.framework_field_key}: Yes (${f.confidence})`);
  }

  console.log("");
  console.log("BEFORE — getDealRoom:");
  console.log(JSON.stringify(await getDealRoom(OPP), null, 2));

  console.log("");
  console.log("syncDealToRolldog:");
  const results = await syncDealToRolldog({
    tenantSlug: TENANT_SLUG,
    dealId,
    rolldogOpportunityId: OPP,
  });
  for (const r of results) {
    const fields = r.fieldsWritten.length
      ? `fields=[${r.fieldsWritten.join(",")}]`
      : "";
    const err = r.error ? `  error=${r.error}` : "";
    console.log(`  ${r.status.padEnd(8)} ${r.method.padEnd(24)} ${fields}${err}`);
  }

  console.log("");
  console.log("AFTER — getDealRoom:");
  console.log(JSON.stringify(await getDealRoom(OPP), null, 2));

  await flushAuditWrites();
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
