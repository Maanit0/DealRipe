/**
 * Idempotent seed: register the "Magaya Rolldog" qualification framework
 * for the magaya tenant (or any other tenant via --tenant).
 *
 *   npx tsx scripts/seed-magaya-framework.ts             # default --tenant magaya
 *   npx tsx scripts/seed-magaya-framework.ts --tenant <slug>
 *
 * After this script runs for tenant T:
 *   - public.qualification_frameworks has one row (T, 'Magaya Rolldog', 'rolldog')
 *   - public.framework_fields has 27 rows: 10 Rolldog-writable sub-object
 *     fields + 17 briefing-only (3 cross-stage + 14 SQL stage-gate items),
 *     each tagged with a stage_key (SQL1..SQL5)
 *   - public.deals where tenant=T and framework_id is null are pointed at
 *     the new framework
 *   - public.field_extractions for tenant T with null framework_id are
 *     backfilled to point at the new framework
 *
 * Idempotent: re-running upserts on (tenant_id, name) and
 * (framework_id, field_key). Safe to run twice. Re-running also re-applies
 * any write_target changes in this file (the upsert overwrites the column).
 *
 * Sibling of scripts/seed-frameworks.ts; kept separate so TopSort's
 * SCOTSMAN seed continues to work unchanged.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { __invalidateFrameworkCache } from "../lib/framework";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const FRAMEWORK_NAME = "Magaya Rolldog";
const FRAMEWORK_SOURCE = "rolldog" as const;
const DEFAULT_TENANT_SLUG = "magaya";

// ---------------------------------------------------------------------
// Field set.
//
// Bucket A (1..10): write_target set, targets a real Rolldog sub-resource
//   attribute via the corresponding method in lib/rolldog.ts. parser is a
//   hint for the future crm-writer module — it tells the writer how to
//   convert the extracted free-text answer into the API value shape.
//
// Bucket B (11..13): write_target = null, cross-stage briefing/forecast
//   fields. NOT written to Rolldog.
//
// Bucket C (14..27): write_target = null, Magaya's SQL stage-gate items.
//   Call-detectable gates only; the agent assesses them from the customer
//   transcript and the briefing flags open gates for the current/next
//   stage. Internal-action gates are NOT here (read from Rolldog instead).
//
// sort_order = position in this array, 1..27.
// stage_key = SQL1..SQL5 per field (see lib mapping). Drives the
//   stage-aware blindspot briefing.
// ---------------------------------------------------------------------

type WriteTarget = {
  system: "rolldog";
  method: string;
  attr: string;
  parser: string;
};

type MagayaFieldSeed = {
  field_key: string;
  label: string;
  question: string;
  stage_key: string | null;
  write_target: WriteTarget | null;
};

const MAGAYA_FIELDS: MagayaFieldSeed[] = [
  // ----- Bucket A: Rolldog-writable sub-objects -----
  {
    field_key: "budget_range_stated",
    label: "Budget",
    question:
      "Has the customer stated a budget amount or range for this purchase?",
    stage_key: "SQL2",
    write_target: {
      system: "rolldog",
      method: "writeBudget",
      attr: "low-range,high-range",
      parser: "currency-range",
    },
  },
  {
    field_key: "budget_fit",
    label: "Budget",
    question:
      "Has the customer indicated whether our pricing fits within their budget?",
    stage_key: "SQL2",
    write_target: {
      system: "rolldog",
      method: "writeBudget",
      attr: "budget-fit",
      parser: "enum-fit",
    },
  },
  {
    field_key: "budget_approver_named",
    label: "Budget",
    question: "Has the customer named the person who approves this budget?",
    stage_key: "SQL3",
    write_target: {
      system: "rolldog",
      method: "writeBudget",
      attr: "approver",
      parser: "text",
    },
  },
  {
    field_key: "close_date_validated",
    label: "Timeline",
    question:
      "Has the customer explicitly confirmed or validated the target close date?",
    stage_key: "SQL2",
    write_target: {
      system: "rolldog",
      method: "writeTimeline",
      attr: "is-close-date-validated",
      parser: "bool",
    },
  },
  {
    field_key: "timeline_notes",
    label: "Timeline",
    question:
      "Has the customer described operational steps or dependencies on their side that must be completed before the target close or go-live date (for example data migration, internal readiness, technical setup)? This is about delivery and timeline dependencies, not the approval or decision process.",
    stage_key: "SQL2",
    write_target: {
      system: "rolldog",
      method: "writeTimeline",
      attr: "notes",
      parser: "text",
    },
  },
  {
    field_key: "why_looking",
    label: "Situation",
    question:
      "Has the customer explained the underlying business reason they are evaluating a change?",
    stage_key: "SQL1",
    write_target: {
      system: "rolldog",
      method: "writeSituation",
      attr: "why-looking",
      parser: "text",
    },
  },
  {
    field_key: "why_looking_now",
    label: "Situation",
    question:
      "Has the customer explained what is driving urgency to act now rather than later?",
    stage_key: "SQL1",
    write_target: {
      system: "rolldog",
      method: "writeSituation",
      attr: "why-looking-now",
      parser: "text",
    },
  },
  {
    field_key: "existing_systems",
    label: "Situation",
    question:
      "Has the customer described the systems or tools they currently use for this?",
    stage_key: "SQL1",
    write_target: {
      system: "rolldog",
      method: "writeSituation",
      attr: "existing-systems",
      parser: "text",
    },
  },
  {
    // Structured multi-competitor rows are deferred; for now competitor
    // discussion is captured as free-text competition notes.
    field_key: "competition_notes",
    label: "Competition",
    question:
      "Has the customer mentioned any competing vendor or alternative they are considering?",
    stage_key: "SQL3",
    write_target: {
      system: "rolldog",
      method: "writeCompetitionNotes",
      attr: "notes",
      parser: "text",
    },
  },
  {
    // Structured participant-contact rows are deferred; captured as
    // participant notes for now.
    field_key: "key_decision_maker_identified",
    label: "People",
    question:
      "Has the customer identified who will make the final decision or sign?",
    stage_key: "SQL3",
    write_target: {
      system: "rolldog",
      method: "writeParticipantNotes",
      attr: "notes",
      parser: "text",
    },
  },

  // ----- Bucket B: cross-stage briefing-only, no Rolldog write target -----
  {
    field_key: "next_step_confirmed",
    label: "Next Step",
    question:
      "Did the call end with a specific next step that the customer explicitly agreed to (with a what and a when)?",
    stage_key: "SQL1",
    write_target: null,
  },
  {
    field_key: "champion_internal_action",
    label: "Champion",
    question:
      "Has the customer described an action they took internally on our behalf (e.g. presenting to leadership, talking to procurement)?",
    stage_key: "SQL3",
    write_target: null,
  },
  {
    field_key: "decision_process_mapped",
    label: "Decision Process",
    question:
      "Has the customer described the internal steps required to go from decision to signed contract (approvals, procurement, legal, sequence)?",
    stage_key: "SQL3",
    write_target: null,
  },

  // ----- Bucket C: Magaya SQL stage-gate items (call-detectable) -----
  // Briefing/blindspot only (write_target null): the agent assesses these
  // from the customer-call transcript and flags open gates for the deal's
  // current and next stage. Internal-action gates (e.g. Initial Prospect
  // Meeting, Activity Created, Transition Doc Completed, Counter-Signed
  // Delivered, Agreement Signed by Company, License Confirmed) are
  // intentionally NOT here; they are read from Rolldog opportunity-
  // attributes once live access lands, not inferred from a call.
  {
    field_key: "sql1_close_plan_presented",
    label: "Close Plan",
    question:
      "Did the rep present a structured close plan or mutual action plan (a set of dated milestones and owners leading to signature), and did the customer explicitly engage with that plan as a plan? Agreeing to a single immediate next step does not count; that is captured separately.",
    stage_key: "SQL1",
    write_target: null,
  },
  {
    field_key: "sql1_storyboard_positioned",
    label: "Storyboard",
    question:
      "Did the rep position the value story or storyboard, and did the customer react to it?",
    stage_key: "SQL1",
    write_target: null,
  },
  {
    field_key: "sql2_proposal_delivered",
    label: "Proposal",
    question:
      "Was a proposal delivered to or discussed with the customer on this call?",
    stage_key: "SQL2",
    write_target: null,
  },
  {
    field_key: "sql2_demo_completed",
    label: "Demo",
    question:
      "Was a product demonstration given or referenced as completed?",
    stage_key: "SQL2",
    write_target: null,
  },
  {
    field_key: "sql2_site_visit",
    label: "Site Visit",
    question:
      "Was a site visit completed, scheduled, or discussed?",
    stage_key: "SQL2",
    write_target: null,
  },
  {
    field_key: "sql3_selected_vendor",
    label: "Selected Vendor",
    question:
      "Did the customer signal whether Magaya is the selected vendor (or that another vendor is preferred)?",
    stage_key: "SQL3",
    write_target: null,
  },
  {
    field_key: "sql3_legal_internal",
    label: "Legal",
    question:
      "Did the customer indicate whether their legal review is handled internally or by outside counsel?",
    stage_key: "SQL3",
    write_target: null,
  },
  {
    field_key: "sql3_final_proposal",
    label: "Final Proposal",
    question:
      "Was a final proposal prepared, submitted, or discussed as the final version?",
    stage_key: "SQL3",
    write_target: null,
  },
  {
    field_key: "sql4_agreement_signature",
    label: "Signature",
    question:
      "Did the customer agree on the signature path or a signing date?",
    stage_key: "SQL4",
    write_target: null,
  },
  {
    field_key: "sql4_exec_involvement",
    label: "Executive",
    question:
      "Is the customer's economic buyer or executive engaged, or was executive involvement explicitly raised as needed to close?",
    stage_key: "SQL4",
    write_target: null,
  },
  {
    field_key: "sql4_agreement_business_terms",
    label: "Business Terms",
    question:
      "Did the customer agree on the commercial or business terms?",
    stage_key: "SQL4",
    write_target: null,
  },
  {
    field_key: "sql4_agreement_legal_terms",
    label: "Legal Terms",
    question:
      "Did the customer agree on the legal or contract terms (redlines resolved)?",
    stage_key: "SQL4",
    write_target: null,
  },
  {
    field_key: "sql5_transition_meeting",
    label: "Transition",
    question:
      "Was a transition or kickoff meeting scheduled with the customer?",
    stage_key: "SQL5",
    write_target: null,
  },
  {
    field_key: "sql5_handoff_meeting",
    label: "Handoff",
    question:
      "Was a handoff to implementation discussed or scheduled?",
    stage_key: "SQL5",
    write_target: null,
  },
];

// ---------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------

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
        source: FRAMEWORK_SOURCE,
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

  // 2. Upsert framework fields. sort_order = 1..13 per the field set above.
  const fieldRows = MAGAYA_FIELDS.map((f, i) => ({
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
    console.error(
      `framework_fields upsert failed: ${fieldsUpsert.error.message}`,
    );
    process.exit(1);
  }
  console.log(
    `framework_fields:  ${fieldsUpsert.data?.length ?? 0} field(s) upserted`,
  );

  // 3a. Backfill deals.framework_id for this tenant's deals that don't have one.
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
    `deals.framework_id: ${dealsUpdate.data?.length ?? 0} deal(s) backfilled (was null)`,
  );

  // 3b. Re-point deals.framework_id for this tenant that point at a
  //     DIFFERENT framework (e.g. a legacy SCOTSMAN seed). `.neq`
  //     excludes nulls and rows already pointing here, so a re-run
  //     after everything matches reports 0 — idempotent.
  //
  //     STRICTLY tenant-scoped via .eq("tenant_id", tenantId). Other
  //     tenants' deals are never touched (TopSort keeps SCOTSMAN).
  const dealsRepoint = await db
    .from("deals")
    .update({ framework_id: frameworkId })
    .eq("tenant_id", tenantId)
    .neq("framework_id", frameworkId)
    .select("id");
  if (dealsRepoint.error) {
    console.error(
      `deals framework_id re-point failed: ${dealsRepoint.error.message}`,
    );
    process.exit(1);
  }
  console.log(
    `deals.framework_id: ${dealsRepoint.data?.length ?? 0} deal(s) re-pointed from a prior framework`,
  );

  // 4a. Backfill field_extractions.framework_id for legacy rows in this tenant.
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
    `field_extractions: ${fxUpdate.data?.length ?? 0} row(s) backfilled (was null)`,
  );

  // 4b. Re-point field_extractions.framework_id for this tenant that
  //     point at a DIFFERENT framework. Same idempotent + tenant-scoped
  //     pattern as 3b.
  const fxRepoint = await db
    .from("field_extractions")
    .update({ framework_id: frameworkId })
    .eq("tenant_id", tenantId)
    .neq("framework_id", frameworkId)
    .select("id");
  if (fxRepoint.error) {
    console.error(
      `field_extractions framework_id re-point failed: ${fxRepoint.error.message}`,
    );
    process.exit(1);
  }
  console.log(
    `field_extractions: ${fxRepoint.data?.length ?? 0} row(s) re-pointed from a prior framework`,
  );

  // Bust the in-process cache for this tenant so a subsequent
  // loadFramework() call sees the fresh rows.
  __invalidateFrameworkCache(tenantId);

  console.log("");
  console.log(`seed:magaya-framework complete for tenant '${tenantSlug}'.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
