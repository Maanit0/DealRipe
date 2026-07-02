import { config } from "dotenv";
config({ path: ".env.local" });

import { loadFramework } from "../lib/framework";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";
const EXPECTED_FRAMEWORK_NAME = "Magaya Rolldog";

// The complete SQL stage-gate checklist from Magaya's Rolldog, captured
// from Mark Buman's screenshots (Jun 29, 2026). Source of truth for the
// completeness cross-check below. Each gate is handled one of three ways:
//   - gate-field: a dedicated call-detectable framework_field (Bucket C)
//   - covered-by: an existing sub-object / briefing field already assesses it
//   - internal:   an internal-action gate read from Rolldog, NOT extracted
//                 from the call transcript (the agent can't infer it)
type GateCoverage =
  | { gate: string; via: "gate-field"; fieldKey: string }
  | { gate: string; via: "covered-by"; fieldKey: string }
  | { gate: string; via: "internal" };

const ROLLDOG_GATES: Record<string, GateCoverage[]> = {
  SQL1: [
    { gate: "Create Initial Close Plan and Presented", via: "gate-field", fieldKey: "sql1_close_plan_presented" },
    { gate: "Project Success Factors", via: "covered-by", fieldKey: "why_looking" },
    { gate: "Initial Prospect Meeting", via: "internal" },
    { gate: "Positioned Storyboard", via: "gate-field", fieldKey: "sql1_storyboard_positioned" },
    { gate: "Agreement on Next Steps", via: "covered-by", fieldKey: "next_step_confirmed" },
  ],
  SQL2: [
    { gate: "Create/Deliver Proposal", via: "gate-field", fieldKey: "sql2_proposal_delivered" },
    { gate: "Post Demo Call Date (Activity Created)", via: "internal" },
    { gate: "Product Demonstration", via: "gate-field", fieldKey: "sql2_demo_completed" },
    { gate: "Preliminary Estimate", via: "covered-by", fieldKey: "budget_range_stated" },
    { gate: "Post Demo Call", via: "internal" },
    { gate: "Site Visit", via: "gate-field", fieldKey: "sql2_site_visit" },
    { gate: "Revalidate Sequence of Events to Close", via: "covered-by", fieldKey: "close_date_validated" },
  ],
  SQL3: [
    { gate: "Is Magaya Selected Vendor?", via: "gate-field", fieldKey: "sql3_selected_vendor" },
    { gate: "Is Legal Internal?", via: "gate-field", fieldKey: "sql3_legal_internal" },
    { gate: "Competition Remaining", via: "covered-by", fieldKey: "competition_notes" },
    { gate: "Revalidate Close Process", via: "covered-by", fieldKey: "decision_process_mapped" },
    { gate: "Validate Who Negotiate and Signs", via: "covered-by", fieldKey: "key_decision_maker_identified" },
    { gate: "Prepare/Submit Final Proposal", via: "gate-field", fieldKey: "sql3_final_proposal" },
  ],
  SQL4: [
    { gate: "Agreement on Signature", via: "gate-field", fieldKey: "sql4_agreement_signature" },
    { gate: "Executive Involvement Needed?", via: "gate-field", fieldKey: "sql4_exec_involvement" },
    { gate: "Agreement on Business Terms", via: "gate-field", fieldKey: "sql4_agreement_business_terms" },
    { gate: "Confirm Negotiation Timeline", via: "covered-by", fieldKey: "close_date_validated" },
    { gate: "Agreement on Legal Terms", via: "gate-field", fieldKey: "sql4_agreement_legal_terms" },
    { gate: "Revalidate Close Plan", via: "covered-by", fieldKey: "decision_process_mapped" },
  ],
  SQL5: [
    { gate: "Transition Doc Completed", via: "internal" },
    { gate: "Transition Meeting Scheduled", via: "gate-field", fieldKey: "sql5_transition_meeting" },
    { gate: "Counter-Signed Delivered to Customer", via: "internal" },
    { gate: "Handoff Meeting", via: "gate-field", fieldKey: "sql5_handoff_meeting" },
    { gate: "Agreement Signed by Company", via: "internal" },
    { gate: "License Confirmed", via: "internal" },
  ],
};

async function main(): Promise<void> {
  const db = supabaseAdmin();

  // 1. Resolve tenant.
  const tenantId = await resolveTenantId(TENANT_SLUG);
  console.log(`tenant: ${TENANT_SLUG} (id=${tenantId})`);
  console.log("");

  // 2. List all qualification_frameworks for the tenant. Building an
  //    id -> name map up front so the deal loop below is a single pass.
  const fwRows = await db
    .from("qualification_frameworks")
    .select("id, name, source, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (fwRows.error) {
    console.error(`framework list failed: ${fwRows.error.message}`);
    process.exit(1);
  }
  const fwById = new Map<string, { name: string; source: string }>();
  for (const fw of fwRows.data ?? []) {
    fwById.set(fw.id, { name: fw.name, source: fw.source });
  }
  console.log(
    `frameworks registered for this tenant (${fwRows.data?.length ?? 0}):`,
  );
  for (const fw of fwRows.data ?? []) {
    console.log(
      `  ${fw.name.padEnd(20)} source=${fw.source.padEnd(8)} id=${fw.id}`,
    );
  }
  console.log("");

  // 3. List all deals for the tenant, joining the framework name in JS.
  const deals = await db
    .from("deals")
    .select("id, external_id, account, framework_id, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  if (deals.error) {
    console.error(`deals list failed: ${deals.error.message}`);
    process.exit(1);
  }

  console.log(`deals (${deals.data?.length ?? 0}):`);
  let onExpected = 0;
  let onOther = 0;
  let unlinked = 0;
  for (const d of deals.data ?? []) {
    const fwName = d.framework_id
      ? fwById.get(d.framework_id)?.name ?? "(unknown framework id)"
      : "(null)";
    const ext = d.external_id ?? "(no external_id)";
    const account = d.account ?? "(no account)";
    if (fwName === EXPECTED_FRAMEWORK_NAME) {
      console.log(
        `  OK      deal=${d.id} ext=${ext} account=${account.padEnd(30)} -> ${fwName}`,
      );
      onExpected += 1;
    } else if (!d.framework_id) {
      console.log(
        `  WARNING deal=${d.id} ext=${ext} account=${account.padEnd(30)} -> (null framework_id)`,
      );
      unlinked += 1;
    } else {
      console.log(
        `  WARNING deal=${d.id} ext=${ext} account=${account.padEnd(30)} -> ${fwName} (NOT ${EXPECTED_FRAMEWORK_NAME})`,
      );
      onOther += 1;
    }
  }
  console.log("");

  // 4. Summary line. Flag loudly if anything is off.
  console.log(
    `summary: ${onExpected} on "${EXPECTED_FRAMEWORK_NAME}", ${onOther} on other framework, ${unlinked} unlinked (null framework_id)`,
  );
  if (onOther > 0 || unlinked > 0) {
    console.log("");
    console.log(
      `WARNING: ${onOther + unlinked} deal(s) NOT on "${EXPECTED_FRAMEWORK_NAME}". Re-run:`,
    );
    console.log(`  npx tsx scripts/seed-magaya-framework.ts --tenant magaya`);
  }
  console.log("");

  // 5. Load the "Magaya Rolldog" framework directly and dump its fields.
  const magayaFw = (fwRows.data ?? []).find(
    (fw) => fw.name === EXPECTED_FRAMEWORK_NAME,
  );
  if (!magayaFw) {
    console.error(
      `FAIL: no framework named "${EXPECTED_FRAMEWORK_NAME}" registered for tenant ${TENANT_SLUG}. Run the seed script first.`,
    );
    process.exit(1);
  }
  const framework = await loadFramework(tenantId, magayaFw.id);
  if (!framework) {
    console.error(
      `FAIL: loadFramework returned null for "${EXPECTED_FRAMEWORK_NAME}" (id=${magayaFw.id}).`,
    );
    process.exit(1);
  }
  console.log(
    `framework "${framework.name}" (id=${framework.id}) — ${framework.fields.length} field(s):`,
  );
  for (const f of framework.fields) {
    console.log(
      `  [${String(f.sortOrder).padStart(2)}] ${f.fieldKey.padEnd(32)} stage=${(f.stageKey ?? "(null)").padEnd(7)} label=${f.label.padEnd(18)} write_target=${f.writeTarget ? "yes" : "null"}`,
    );
  }

  // 6. stage_key tally.
  const byStage = new Map<string, number>();
  for (const f of framework.fields) {
    const k = f.stageKey ?? "(null)";
    byStage.set(k, (byStage.get(k) ?? 0) + 1);
  }
  console.log("");
  console.log("fields by stage_key:");
  for (const k of ["SQL1", "SQL2", "SQL3", "SQL4", "SQL5", "(null)"]) {
    if (byStage.has(k)) console.log(`  ${k.padEnd(8)} ${byStage.get(k)} field(s)`);
  }

  // 7. Completeness cross-check vs Magaya's Rolldog SQL gates (screenshots).
  const present = new Set(framework.fields.map((f) => f.fieldKey));
  let problems = 0;
  let totalGates = 0;
  let gateFieldCount = 0;
  let coveredCount = 0;
  let internalCount = 0;
  console.log("");
  console.log("Rolldog SQL gate coverage (vs Mark's screenshots):");
  for (const stage of ["SQL1", "SQL2", "SQL3", "SQL4", "SQL5"]) {
    const gates = ROLLDOG_GATES[stage] ?? [];
    console.log(`  ${stage} (${gates.length} gates):`);
    for (const g of gates) {
      totalGates += 1;
      if (g.via === "internal") {
        internalCount += 1;
        console.log(`    INTERNAL    ${g.gate}  (read from Rolldog, not extracted)`);
        continue;
      }
      const exists = present.has(g.fieldKey);
      if (g.via === "gate-field") gateFieldCount += 1;
      else coveredCount += 1;
      const tag = g.via === "gate-field" ? "GATE FIELD" : "COVERED BY";
      if (exists) {
        console.log(`    ${tag}  ${g.gate}  ->  ${g.fieldKey}`);
      } else {
        problems += 1;
        console.log(`    MISSING!!   ${g.gate}  ->  ${g.fieldKey} (NOT FOUND in framework)`);
      }
    }
  }
  console.log("");
  console.log(
    `gate coverage: ${totalGates} total = ${gateFieldCount} dedicated gate fields + ${coveredCount} covered by existing fields + ${internalCount} internal (read-only).`,
  );

  // 8. Assertions.
  const writable = framework.fields.filter((f) => f.writeTarget).length;
  const briefingOnly = framework.fields.length - writable;
  const checks: Array<[string, boolean]> = [
    ["27 fields total", framework.fields.length === 27],
    ["10 Rolldog-writable sub-object fields", writable === 10],
    ["17 briefing-only fields", briefingOnly === 17],
    ["14 dedicated SQL gate fields", gateFieldCount === 14],
    ["30 Rolldog gates accounted for", totalGates === 30],
    ["no missing gate fields", problems === 0],
  ];
  console.log("");
  console.log("assertions:");
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failed += 1;
  }
  console.log("");
  if (failed === 0) {
    console.log(
      'All checks passed. Magaya framework matches the Rolldog SQL screenshots.',
    );
  } else {
    console.log(`${failed} check(s) FAILED.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
