/**
 * Idempotent seed: register the builtin SCOTSMAN framework for the
 * topsort tenant and backfill deals.framework_id.
 *
 * After this script runs:
 *   - public.qualification_frameworks has one row (topsort, 'SCOTSMAN', 'builtin')
 *   - public.framework_fields has 18 rows (one per SCOTSMAN sub-question)
 *   - public.deals where tenant=topsort and framework_id is null are updated
 *     to point at the new framework
 *
 * Safe to re-run; every step is upsert/where-null.
 *
 * Run: npm run seed:frameworks
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { __invalidateFrameworkCache } from "../lib/framework";
import { SCOTSMAN_FIELDS } from "../lib/scotsman";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const FRAMEWORK_NAME = "SCOTSMAN";

async function main(): Promise<void> {
  const db = supabaseAdmin();

  let topsortTenantId: string;
  try {
    topsortTenantId = await resolveTenantId("topsort");
  } catch (err) {
    console.error(
      "tenant 'topsort' not found. Run `npm run migrate:extractions` first.",
    );
    process.exit(1);
  }

  // 1. Upsert the framework row.
  const fwUpsert = await db
    .from("qualification_frameworks")
    .upsert(
      {
        tenant_id: topsortTenantId,
        name: FRAMEWORK_NAME,
        source: "builtin",
      },
      { onConflict: "tenant_id,name" },
    )
    .select("id")
    .single();
  if (fwUpsert.error || !fwUpsert.data) {
    console.error(
      `qualification_frameworks upsert failed: ${fwUpsert.error?.message}`,
    );
    process.exit(1);
  }
  const frameworkId = fwUpsert.data.id;
  console.log(`framework:         ${FRAMEWORK_NAME} (id=${frameworkId})`);

  // 2. Upsert framework fields. sort_order = index in SCOTSMAN_FIELDS array.
  const fieldRows = SCOTSMAN_FIELDS.map((f, i) => ({
    tenant_id: topsortTenantId,
    framework_id: frameworkId,
    field_key: f.id,
    label: f.label,
    question: f.question,
    stage_key: null,
    write_target: null,
    sort_order: i,
  }));
  const fieldsUpsert = await db
    .from("framework_fields")
    .upsert(fieldRows, { onConflict: "framework_id,field_key" })
    .select("field_key");
  if (fieldsUpsert.error) {
    console.error(
      `framework_fields upsert failed: ${fieldsUpsert.error.message}`,
    );
    process.exit(1);
  }
  console.log(
    `framework_fields:  ${fieldsUpsert.data?.length ?? 0} field(s) upserted`,
  );

  // 3. Backfill deals.framework_id for topsort deals that don't have one.
  const dealsUpdate = await db
    .from("deals")
    .update({ framework_id: frameworkId })
    .eq("tenant_id", topsortTenantId)
    .is("framework_id", null)
    .select("id");
  if (dealsUpdate.error) {
    console.error(
      `deals framework_id backfill failed: ${dealsUpdate.error.message}`,
    );
    process.exit(1);
  }
  console.log(
    `deals.framework_id: ${dealsUpdate.data?.length ?? 0} deal(s) backfilled`,
  );

  // 4. Backfill field_extractions.framework_id for legacy rows.
  const fxUpdate = await db
    .from("field_extractions")
    .update({ framework_id: frameworkId })
    .eq("tenant_id", topsortTenantId)
    .is("framework_id", null)
    .select("id");
  if (fxUpdate.error) {
    console.error(
      `field_extractions framework_id backfill failed: ${fxUpdate.error.message}`,
    );
    process.exit(1);
  }
  console.log(
    `field_extractions: ${fxUpdate.data?.length ?? 0} row(s) backfilled`,
  );

  // Bust the in-process cache so a subsequent loadFramework() call sees
  // the fresh rows. Irrelevant for a fresh process, useful if a long-
  // running script imports this module before running the seed.
  __invalidateFrameworkCache(topsortTenantId);

  console.log("");
  console.log("seed:frameworks complete.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
