/**
 * Seed ONE fully-populated Magaya demo deal so the live UI renders end to
 * end: pipeline digest, framework-driven deal inspection (with evidence),
 * Teams calls, and a real "what changed" diff in the digest.
 *
 *   npx tsx scripts/seed-magaya-demo.ts
 *
 * This is for visualizing the UI before real pilot data exists. It is
 * idempotent (upserts) and safe to re-run. The real pilot deals come from
 * seed-magaya-deals.ts + live extraction.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import type { Json } from "../lib/database.types";
import { getFrameworkForDeal } from "../lib/framework";
import { buildSignals, recordDealSnapshot } from "../lib/snapshot";
import { getDealForTenant } from "../lib/supabase-queries";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { supabaseAdmin } from "../lib/supabase";

type Relationship = "champion" | "influencer" | "economic_buyer" | "user" | "unknown";

const TENANT_SLUG = "magaya";
const FRAMEWORK_NAME = "Magaya Rolldog";
const EXTERNAL_ID = "demo-harbor-freight";

// The "Yes" extractions (everything else renders as an open gate).
const YES_FIELDS: Array<{ key: string; answer: string; evidence: string; conf: number }> = [
  { key: "why_looking", answer: "Drowning in manual work, everything around CargoWise is spreadsheets.", evidence: "We're drowning in manual work... everything around it is spreadsheets.", conf: 0.97 },
  { key: "why_looking_now", answer: "Peak season volume doubles and the board mandated a fix before peak.", evidence: "The board basically told us we cannot go into this peak on the current setup.", conf: 0.97 },
  { key: "existing_systems", answer: "CargoWise for core forwarding plus spreadsheets for everything else.", evidence: "We're running on CargoWise... but everything around it is spreadsheets.", conf: 0.96 },
  { key: "next_step_confirmed", answer: "Customer committed to the proposal and a migration session next week.", evidence: "Send the proposal and let's get the migration session on the calendar for next week.", conf: 0.95 },
  { key: "budget_range_stated", answer: "Earmarked forty to sixty thousand a year from the operations budget.", evidence: "We've earmarked somewhere in the range of forty to sixty thousand a year.", conf: 0.95 },
  { key: "close_date_validated", answer: "Needs to be live by the first week of October.", evidence: "We need to be live before peak... by the first week of October at the latest.", conf: 0.95 },
  { key: "timeline_notes", answer: "Data migration from CargoWise is the main risk to the October timeline.", evidence: "The main thing on my end is the data migration... that's the part that worries me for an October timeline.", conf: 0.9 },
  { key: "budget_approver_named", answer: "Anything over fifty thousand goes to Sandra, the CFO.", evidence: "Anything over fifty grand has to go to Sandra, our CFO.", conf: 0.95 },
  { key: "key_decision_maker_identified", answer: "Sandra the CFO makes the final call on the money.", evidence: "She makes the final call on the money.", conf: 0.92 },
  { key: "competition_notes", answer: "Also evaluating Descartes, ahead on customs, clunky quoting.", evidence: "We're also evaluating Descartes... their quoting workflow felt clunky.", conf: 0.96 },
  { key: "sql3_legal_internal", answer: "Legal is in-house; GC Marcus handles vendor contracts.", evidence: "In house. Our general counsel Marcus handles all the vendor contracts directly.", conf: 0.95 },
  { key: "sql2_demo_completed", answer: "Demo happened last week; team liked the shipment tracking.", evidence: "Thanks for the demo last week... the team really liked the visibility on the shipment tracking side.", conf: 0.95 },
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

  // 1. Deal
  const dealUp = await db
    .from("deals")
    .upsert(
      {
        tenant_id: tenantId,
        external_id: EXTERNAL_ID,
        account: "Harbor Freight Logistics",
        industry: "Freight forwarding / logistics",
        arr: 130000,
        stage_key: "SQL3",
        days_in_stage: 24,
        rep_forecast_probability: 0.6,
        rep_forecast_close_date: "2026-10-01",
        rep_notes: "Mid-stage, strong champion, CFO not engaged, Descartes in play.",
        framework_id: frameworkId,
      },
      { onConflict: "tenant_id,external_id" },
    )
    .select("id")
    .single();
  if (dealUp.error || !dealUp.data) {
    console.error(`deal upsert failed: ${dealUp.error?.message}`);
    process.exit(1);
  }
  const dealId = dealUp.data.id;

  // 2. Contacts
  const contacts: Array<{ name: string; role: string; relationship: Relationship; last_contacted_at: string | null }> = [
    { name: "David Okafor", role: "Director of Operations", relationship: "champion", last_contacted_at: "2026-05-25" },
    { name: "Priya Nair", role: "IT Manager", relationship: "influencer", last_contacted_at: "2026-05-25" },
    { name: "Sandra (CFO)", role: "CFO", relationship: "economic_buyer", last_contacted_at: null },
  ];
  await db.from("contacts").delete().eq("deal_id", dealId);
  const contactRows = contacts.map((c) => ({
    tenant_id: tenantId,
    deal_id: dealId,
    name: c.name,
    role: c.role,
    relationship: c.relationship,
    last_contacted_at: c.last_contacted_at,
  }));
  const cIns = await db.from("contacts").insert(contactRows);
  if (cIns.error) {
    console.error(`contacts insert failed: ${cIns.error.message}`);
    process.exit(1);
  }

  // 3. Calls (Teams). external_id for idempotent upsert.
  const calls = [
    { external_id: `${EXTERNAL_ID}-call-1`, call_date: "2026-05-18", duration_minutes: 30, participants: ["Juan Lopez (Magaya)", "David Okafor (Harbor Freight)"], has_been_extracted: true },
    { external_id: `${EXTERNAL_ID}-call-2`, call_date: "2026-05-25", duration_minutes: 35, participants: ["Juan Lopez (Magaya)", "David Okafor", "Priya Nair (Harbor Freight)"], has_been_extracted: false },
  ];
  await db.from("calls").delete().eq("deal_id", dealId);
  const callRows = calls.map((call) => ({
    tenant_id: tenantId,
    deal_id: dealId,
    external_id: call.external_id,
    call_date: call.call_date,
    duration_minutes: call.duration_minutes,
    participants: call.participants,
    source: "recall_ai" as const,
    has_been_extracted: call.has_been_extracted,
  }));
  const callIns = await db.from("calls").insert(callRows);
  if (callIns.error) {
    console.error(`calls insert failed: ${callIns.error.message}`);
    process.exit(1);
  }

  // 4. Field extractions (replace for idempotency)
  await db.from("field_extractions").delete().eq("deal_id", dealId);
  const fxRows = YES_FIELDS.map((f) => ({
    tenant_id: tenantId,
    deal_id: dealId,
    framework_id: frameworkId,
    framework_field_key: f.key,
    status: "Yes" as const,
    answer: f.answer,
    evidence: f.evidence,
    confidence: f.conf,
  }));
  const fxIns = await db.from("field_extractions").insert(fxRows);
  if (fxIns.error) {
    console.error(`field_extractions insert failed: ${fxIns.error.message}`);
    process.exit(1);
  }

  // 5. Snapshots: today (full) + a backdated "last week" with two fewer
  //    confirmed fields, so the digest shows a real diff.
  const deal = await getDealForTenant(tenantId, dealId);
  const framework = await getFrameworkForDeal(dealId);
  if (!deal || !framework) {
    console.error("Could not reload seeded deal/framework for snapshot.");
    process.exit(1);
  }
  await recordDealSnapshot(tenantId, deal, framework);

  const lastWeekDeal = { ...deal, extraction: { ...deal.extraction } };
  delete lastWeekDeal.extraction["competition_notes"];
  delete lastWeekDeal.extraction["sql3_legal_internal"];
  const lastWeekSignals = buildSignals(lastWeekDeal, framework);
  const lastWeekDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  await db.from("deal_signal_snapshots").upsert(
    {
      tenant_id: tenantId,
      deal_id: dealId,
      snapshot_date: lastWeekDate,
      signals: lastWeekSignals as unknown as Json,
      rep_commit: "60%",
    },
    { onConflict: "deal_id,snapshot_date" },
  );

  console.log(`Seeded demo deal: Harbor Freight Logistics (id=${dealId})`);
  console.log(`View: /pipeline?tenant=magaya  and  /deals/${dealId}`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
