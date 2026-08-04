/**
 * Idempotent seed: register the "NEAT" qualification framework for a tenant
 * (default: second-nature). Sibling of scripts/seed-magaya-framework.ts;
 * kept separate so Magaya's Rolldog seed and TopSort's SCOTSMAN seed are
 * untouched.
 *
 *   npx tsx scripts/seed-neat-framework.ts --tenant second-nature
 *
 * After this runs for tenant T:
 *   - qualification_frameworks has one row (T, 'NEAT', 'manual')
 *   - framework_fields has 10 rows: the NEAT sub-questions (N/E/A/T), each
 *     tagged with a stage_key and a Salesforce write_target so the CRM
 *     write-back demo maps each gate to a real opportunity field.
 *   - deals / field_extractions for tenant T with a null or different
 *     framework_id are pointed at NEAT.
 *
 * Stage keys reuse the SQL1..SQL5 numeric scheme so all existing stage logic
 * (frameworkStages ordering, briefing "next gate", pipeline percentages) works
 * unchanged. The DISPLAY labels for a NEAT tenant (Discovery / Evaluation /
 * Vendor of Choice / Contract Out / Signed) are handled tenant-side in the
 * pipeline + deal views; the underlying keys stay SQL1..SQL5.
 *
 * NEAT = Need, Economic impact, Access to authority, Timeline. Mapping to the
 * Second Nature funnel:
 *   SQL1 Discovery          Need
 *   SQL2 Evaluation         Economic impact + Timeline (compelling event, go-live)
 *   SQL3 Vendor of Choice   Access to authority + procurement path
 *   SQL4 Contract Out       (contract gates, read from CRM later)
 *   SQL5 Signed             (signature)
 *
 * Idempotent: upserts on (tenant_id, name) and (framework_id, field_key).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { __invalidateFrameworkCache } from "../lib/framework";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const FRAMEWORK_NAME = "NEAT";
const FRAMEWORK_SOURCE = "manual" as const;
const DEFAULT_TENANT_SLUG = "second-nature";

type WriteTarget = {
  system: "salesforce";
  object: "Opportunity";
  field: string; // Salesforce API field name
  parser: string; // hint for the CRM writer: how to shape the value
};

type NeatFieldSeed = {
  field_key: string;
  label: string;
  question: string;
  stage_key: string | null;
  write_target: WriteTarget | null;
};

// The 10 NEAT sub-questions, in N-E-A-T order, mapped to Second Nature's
// funnel stages and to the Salesforce opportunity fields DealRipe writes back.
const NEAT_FIELDS: NeatFieldSeed[] = [
  // ----- Need (Discovery) -----
  {
    field_key: "N1",
    label: "Need",
    question: "Has the resident-experience problem been clearly articulated?",
    stage_key: "SQL1",
    write_target: { system: "salesforce", object: "Opportunity", field: "Primary_Pain__c", parser: "text" },
  },
  {
    field_key: "N2",
    label: "Need",
    question: "Is there a specific operational pain tied to the current approach (make-ready, vacancy, ticket load)?",
    stage_key: "SQL1",
    write_target: { system: "salesforce", object: "Opportunity", field: "Metrics__c", parser: "text" },
  },
  // ----- Economic Impact (Evaluation) -----
  {
    field_key: "E1",
    label: "Economic Impact",
    question: "Is the revenue or cost impact quantified per door?",
    stage_key: "SQL2",
    write_target: { system: "salesforce", object: "Opportunity", field: "Economic_Impact__c", parser: "currency" },
  },
  {
    field_key: "E2",
    label: "Economic Impact",
    question: "Is the ROI tied to a metric ownership already tracks (NOI, retention, ancillary income)?",
    stage_key: "SQL2",
    write_target: { system: "salesforce", object: "Opportunity", field: "Metrics__c", parser: "text" },
  },
  // ----- Access to Authority (Vendor of Choice) -----
  {
    field_key: "A1",
    label: "Access to Authority",
    question: "Is the economic buyer (owner / principal) identified?",
    stage_key: "SQL3",
    write_target: { system: "salesforce", object: "Opportunity", field: "Economic_Buyer__c", parser: "text" },
  },
  {
    field_key: "A2",
    label: "Access to Authority",
    question: "Do we have access to the decision process, not just the champion?",
    stage_key: "SQL3",
    write_target: { system: "salesforce", object: "Opportunity", field: "Decision_Process__c", parser: "text" },
  },
  {
    field_key: "A3",
    label: "Access to Authority",
    question: "Are finance and ops both engaged, not just the operations lead?",
    stage_key: "SQL3",
    write_target: { system: "salesforce", object: "Opportunity", field: "Key_Stakeholders__c", parser: "text" },
  },
  // ----- Timeline (Evaluation → Contract) -----
  {
    field_key: "T1",
    label: "Timeline",
    question: "Is there a compelling event driving the timing?",
    stage_key: "SQL2",
    write_target: { system: "salesforce", object: "Opportunity", field: "Why_Now__c", parser: "text" },
  },
  {
    field_key: "T2",
    label: "Timeline",
    question: "Is the rollout / go-live timeline defined?",
    stage_key: "SQL2",
    write_target: { system: "salesforce", object: "Opportunity", field: "CloseDate", parser: "date" },
  },
  {
    field_key: "T3",
    label: "Timeline",
    question: "Is the procurement / contracting path known (mutual action plan)?",
    stage_key: "SQL4",
    write_target: { system: "salesforce", object: "Opportunity", field: "Mutual_Action_Plan__c", parser: "text" },
  },
];

function parseArgs(argv: string[]): { tenantSlug: string } {
  let tenantSlug = DEFAULT_TENANT_SLUG;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tenant") {
      const v = argv[i + 1];
      if (!v) {
        console.error("--tenant requires a slug argument (e.g. --tenant second-nature)");
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
  } catch {
    console.error(
      `tenant '${tenantSlug}' not found. Insert the tenant row first (seed-second-nature.ts creates it, or run the tenant insert).`,
    );
    process.exit(1);
  }

  console.log(`tenant:            ${tenantSlug} (id=${tenantId})`);

  const fwUpsert = await db
    .from("qualification_frameworks")
    .upsert({ tenant_id: tenantId, name: FRAMEWORK_NAME, source: FRAMEWORK_SOURCE }, { onConflict: "tenant_id,name" })
    .select("id")
    .single();
  if (fwUpsert.error || !fwUpsert.data) {
    console.error(`qualification_frameworks upsert failed: ${fwUpsert.error?.message}`);
    process.exit(1);
  }
  const frameworkId = fwUpsert.data.id;
  console.log(`framework:         ${FRAMEWORK_NAME} (id=${frameworkId})`);

  const fieldRows = NEAT_FIELDS.map((f, i) => ({
    tenant_id: tenantId,
    framework_id: frameworkId,
    field_key: f.field_key,
    label: f.label,
    question: f.question,
    stage_key: f.stage_key,
    write_target: f.write_target,
    sort_order: i + 1,
  }));
  const fieldsUpsert = await db
    .from("framework_fields")
    .upsert(fieldRows, { onConflict: "framework_id,field_key" })
    .select("field_key");
  if (fieldsUpsert.error) {
    console.error(`framework_fields upsert failed: ${fieldsUpsert.error.message}`);
    process.exit(1);
  }
  console.log(`framework_fields:  ${fieldsUpsert.data?.length ?? 0} field(s) upserted`);

  // Point this tenant's deals + extractions at NEAT (backfill nulls, then re-point others). Tenant-scoped.
  for (const [table] of [["deals"], ["field_extractions"]] as const) {
    const backfill = await db.from(table).update({ framework_id: frameworkId }).eq("tenant_id", tenantId).is("framework_id", null).select("id");
    if (backfill.error) {
      console.error(`${table} framework_id backfill failed: ${backfill.error.message}`);
      process.exit(1);
    }
    const repoint = await db.from(table).update({ framework_id: frameworkId }).eq("tenant_id", tenantId).neq("framework_id", frameworkId).select("id");
    if (repoint.error) {
      console.error(`${table} framework_id re-point failed: ${repoint.error.message}`);
      process.exit(1);
    }
    console.log(`${table}: ${backfill.data?.length ?? 0} backfilled, ${repoint.data?.length ?? 0} re-pointed`);
  }

  __invalidateFrameworkCache(tenantId);
  console.log("");
  console.log(`seed:neat-framework complete for tenant '${tenantSlug}'.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
