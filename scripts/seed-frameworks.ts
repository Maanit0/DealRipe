/**
 * Idempotent seed: register the builtin SCOTSMAN framework for a tenant
 * and backfill that tenant's deals.framework_id / field_extractions.framework_id.
 *
 * Default tenant slug is 'topsort' (preserves the pre-rehearsal behavior).
 * Pass --tenant <slug> to seed for any tenant — e.g. magaya during a
 * production rehearsal:
 *
 *   npm run seed:frameworks                    # topsort (default)
 *   npm run seed:frameworks -- --tenant magaya # magaya
 *
 * After this script runs for tenant T:
 *   - public.qualification_frameworks has one row (T, 'SCOTSMAN', 'builtin')
 *   - public.framework_fields has 18 rows (one per SCOTSMAN sub-question)
 *   - public.deals where tenant=T and framework_id is null are updated
 *     to point at the new framework
 *
 * Safe to re-run; every step is upsert or where-null. Re-running for the
 * same tenant does not duplicate any rows.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { __invalidateFrameworkCache } from "../lib/framework";
import { SCOTSMAN_FIELDS } from "../lib/scotsman";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const FRAMEWORK_NAME = "SCOTSMAN";
const DEFAULT_TENANT_SLUG = "topsort";

function parseArgs(argv: string[]): { tenantSlug: string } {
  let tenantSlug = DEFAULT_TENANT_SLUG;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tenant") {
      const v = argv[i + 1];
      if (!v) {
        console.error("--tenant requires a slug argument (e.g. --tenant magaya)");
        process.exit(1);
      }
      tenantSlug = v;
      i++;
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return { tenantSlug };
}

async function main(): Promise<void> {
  const { tenantSlug } = parseArgs(process.argv.slice(2));
  const db = supabaseAdmin();

  let tenantId: string;
  try {
    tenantId = await resolveTenantId(tenantSlug);
  } catch (err) {
    console.error(
      `tenant '${tenantSlug}' not found. Run \`npm run seed:${tenantSlug}\` (or the equivalent tenant insert) first.`,
    );
    process.exit(1);
  }

  console.log(`tenant:            ${tenantSlug} (id=${tenantId})`);

  // 1. Upsert the framework row.
  const fwUpsert = await db
    .from("qualification_frameworks")
    .upsert(
      {
        tenant_id: tenantId,
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
    tenant_id: tenantId,
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

  // 3. Backfill deals.framework_id for this tenant's deals that don't have one.
  const dealsUpdate = await db
    .from("deals")
    .update({ framework_id: frameworkId })
    .eq("tenant_id", tenantId)
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

  // 4. Backfill field_extractions.framework_id for legacy rows in this tenant.
  const fxUpdate = await db
    .from("field_extractions")
    .update({ framework_id: frameworkId })
    .eq("tenant_id", tenantId)
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

  // Bust the in-process cache for this tenant so a subsequent
  // loadFramework() call sees the fresh rows.
  __invalidateFrameworkCache(tenantId);

  console.log("");
  console.log(`seed:frameworks complete for tenant '${tenantSlug}'.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
