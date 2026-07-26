/**
 * Seed the "keelson" demo tenant: a fictional mid-market logistics software
 * company selling freight and customs software to freight forwarders, customs
 * brokers, and 3PLs. All names, deals, and numbers are invented for the demo,
 * never a real customer's data.
 *
 * This seed is ADDITIVE, IDEMPOTENT, and INERT:
 *   - Additive: every row it writes is scoped to the keelson tenant_id. It
 *     never UPDATEs or DELETEs a magaya (pilot) row.
 *   - Idempotent: upserts on natural keys (tenant_id+external_id for deals,
 *     deal_id+external_id for calls, deal_id+name for contacts, call_id for transcripts,
 *     deal_id+framework_field_key for extractions, deal_id+snapshot_date for
 *     snapshots) and check-then-insert where no unique key exists (tasks are
 *     deleted-by-call then re-inserted). Re-running does not duplicate.
 *   - Inert: keelson has no Rolldog opportunities and no microsoft_connections
 *     row, and every cron is pinned to slug "magaya", so no scheduled job ever
 *     touches keelson. It is demo-only data the UI renders on demand.
 *
 * Safe by default: prints the plan and writes NOTHING without --apply.
 *
 * Prerequisites (run in order, on a machine with .env.local + DB access):
 *   1. npx tsx scripts/seed-magaya-tenant.ts        # ensures magaya exists (unrelated but the app expects it)
 *   2. npx tsx scripts/seed-magaya-framework.ts --tenant keelson   # 27-field Magaya Rolldog framework for keelson
 *   3. npx tsx scripts/seed-keelson.ts --apply      # this script (dry-run without --apply)
 *
 * View at /pipeline?tenant=keelson (and the sidebar carries ?tenant=keelson).
 * Roll back with:  npx tsx scripts/delete-tenant-data.ts keelson --dry-run
 *                  npx tsx scripts/delete-tenant-data.ts keelson
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import type { Json } from "../lib/database.types";
import { KEELSON } from "../lib/demos/keelson";
import { getFrameworkForDeal } from "../lib/framework";
import { recordDealSnapshot } from "../lib/snapshot";
import { supabaseAdmin } from "../lib/supabase";
import { getDealForTenant } from "../lib/supabase-queries";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { seedKeelsonComms } from "./seed-keelson-comms";
import { seedKeelsonCrm } from "./seed-keelson-crm";

const TENANT_SLUG = "keelson";
const TENANT_NAME = "Keelson";
const FRAMEWORK_NAME = "Magaya Rolldog";

// ---------------------------------------------------------------------
// Stage field groups (the 27 Magaya Rolldog gates by stage_key). Used to
// compose each deal's confirmed-vs-open gate state deterministically, so the
// demo shows exactly the intended health without depending on the LLM.
// ---------------------------------------------------------------------
const SQL1 = ["why_looking", "why_looking_now", "existing_systems", "next_step_confirmed", "sql1_close_plan_presented", "sql1_storyboard_positioned"];
const SQL2 = ["budget_range_stated", "budget_fit", "close_date_validated", "timeline_notes", "sql2_proposal_delivered", "sql2_demo_completed", "sql2_site_visit"];
const SQL3 = ["budget_approver_named", "competition_notes", "key_decision_maker_identified", "champion_internal_action", "decision_process_mapped", "sql3_selected_vendor", "sql3_legal_internal", "sql3_final_proposal"];
const SQL4 = ["sql4_agreement_signature", "sql4_exec_involvement", "sql4_agreement_business_terms", "sql4_agreement_legal_terms"];

// Believable customer-voice answer + evidence per gate, freight/customs themed.
// Reused across deals; static so the deal page shows grounded fills.
const FIELD_COPY: Record<string, { answer: string; evidence: string }> = {
  why_looking: { answer: "Manual customs entry is slowing shipments", evidence: "We're re-keying entries by hand and it's costing us hours a day." },
  why_looking_now: { answer: "Peak season is exposing the bottleneck", evidence: "With peak coming we can't keep doing this manually." },
  existing_systems: { answer: "Legacy TMS plus spreadsheets", evidence: "Right now it's our old TMS and a lot of spreadsheets." },
  next_step_confirmed: { answer: "Agreed to a follow-up next week", evidence: "Let's get the team together again next Thursday." },
  sql1_close_plan_presented: { answer: "Walked through a dated rollout plan", evidence: "That milestone plan to go live by Q4 makes sense." },
  sql1_storyboard_positioned: { answer: "Value story landed on time savings", evidence: "If it saves us that much re-keying, that's the story for my boss." },
  budget_range_stated: { answer: "300 to 500K set aside for this", evidence: "We've got somewhere between 300 and 500 thousand set aside." },
  budget_fit: { answer: "Pricing fits their range", evidence: "That number is within what we planned." },
  close_date_validated: { answer: "Confirmed go-live target", evidence: "We need it live before the Q4 peak, that date works." },
  timeline_notes: { answer: "Data migration is the main dependency", evidence: "The one thing on our side is migrating the entry data." },
  sql2_proposal_delivered: { answer: "Proposal reviewed on the call", evidence: "We went through the proposal you sent." },
  sql2_demo_completed: { answer: "Demo completed on their lanes", evidence: "The demo on our lanes was helpful." },
  sql2_site_visit: { answer: "Site visit scheduled", evidence: "Come see the warehouse operation next month." },
  budget_approver_named: { answer: "Named the budget approver", evidence: "Our VP signs off on anything over 250K." },
  competition_notes: { answer: "Evaluating a competing WMS", evidence: "We're also looking at our incumbent WMS vendor." },
  key_decision_maker_identified: { answer: "Final sign-off sits with the exec", evidence: "The final call sits with our operations exec." },
  champion_internal_action: { answer: "Champion presented internally", evidence: "I took your deck to our leadership review." },
  decision_process_mapped: { answer: "Mapped approvals to signature", evidence: "It goes ops, then procurement, then legal." },
  sql3_selected_vendor: { answer: "Signaled Keelson as front-runner", evidence: "You're our preferred option right now." },
  sql3_legal_internal: { answer: "Legal handled internally", evidence: "Our in-house counsel will review the contract." },
  sql3_final_proposal: { answer: "Final proposal submitted", evidence: "This is the final version of the pricing." },
  sql4_agreement_signature: { answer: "Agreed a signing date", evidence: "We can sign by the end of the month." },
  sql4_exec_involvement: { answer: "Executive engaged on the deal", evidence: "Our COO is in the room for this one." },
  sql4_agreement_business_terms: { answer: "Commercial terms agreed", evidence: "The commercial terms work for us." },
  sql4_agreement_legal_terms: { answer: "Redlines resolved", evidence: "Legal cleared the last redlines." },
  sql5_transition_meeting: { answer: "Kickoff scheduled", evidence: "Let's book the kickoff for next week." },
  sql5_handoff_meeting: { answer: "Implementation handoff planned", evidence: "Loop in your implementation team." },
};

// Per-deal quote overrides so every deal's Opportunity Control reads in its own
// voice, not the same reused lines. Keyed by externalId → gate key. Cascade keeps
// the base FIELD_COPY (its transcript already matches those quotes). Gates not
// listed fall back to FIELD_COPY.
const QUOTES_BY_DEAL: Record<string, Record<string, { answer: string; evidence: string }>> = {
  "keelson-delmar-customs": {
    why_looking: { answer: "Entry classification is backing up their brokers", evidence: "Our brokers are stuck classifying entries by hand and the queue keeps growing." },
    why_looking_now: { answer: "A new client win doubled entry volume", evidence: "We just took on a big importer and the volume doubled overnight." },
    existing_systems: { answer: "Aging brokerage suite plus spreadsheets", evidence: "We're on an old brokerage package and a stack of spreadsheets." },
  },
  "keelson-pacific-cargo": {
    why_looking: { answer: "No real-time customs visibility across their DCs", evidence: "We can't see customs status across our distribution centers in real time." },
    why_looking_now: { answer: "A missed clearance cost a retail SLA", evidence: "We missed a clearance last month and blew a retail SLA, that got leadership's attention." },
    existing_systems: { answer: "Incumbent WMS with a customs bolt-on", evidence: "We run our current WMS with a customs bolt-on that barely talks to it." },
    budget_range_stated: { answer: "Roughly 300K approved", evidence: "We've got roughly 300K approved for this." },
    budget_fit: { answer: "Inside the approved number", evidence: "Your number is inside the 300 we approved." },
    close_date_validated: { answer: "Live before retail peak", evidence: "It has to be in before our retail peak in Q4." },
    timeline_notes: { answer: "DC-by-DC rollout, not big bang", evidence: "We'd roll it out DC by DC, not all at once." },
    key_decision_maker_identified: { answer: "Operations exec holds the final call", evidence: "Our operations exec makes the final call on this." },
    sql1_close_plan_presented: { answer: "Phased DC rollout plan shared", evidence: "The DC-by-DC rollout plan makes sense for us." },
    sql1_storyboard_positioned: { answer: "Value framed on SLA reliability", evidence: "If it keeps us from blowing SLAs, that's the pitch to leadership." },
    sql3_final_proposal: { answer: "Final pricing submitted", evidence: "This is the final version of the pricing." },
  },
  "keelson-summit-logistics": {
    why_looking: { answer: "Manual rate entry is error-prone", evidence: "Our team keys rates by hand and the errors are costing us." },
    why_looking_now: { answer: "New ops leader wants it fixed this quarter", evidence: "I just took over ops and I want this sorted this quarter." },
    existing_systems: { answer: "Legacy forwarding system, no integration", evidence: "We're on a legacy forwarding system that doesn't integrate with anything." },
    budget_range_stated: { answer: "About 250K earmarked", evidence: "We've earmarked about 250K for a fix." },
    close_date_validated: { answer: "Targeting end of year", evidence: "We'd want it live by year end." },
    sql1_close_plan_presented: { answer: "Rollout plan re-grounded for the new owner", evidence: "Walk me through the plan again now that I own this." },
    sql1_storyboard_positioned: { answer: "Value tied to error reduction", evidence: "If it cuts the keying errors, that's what I'll take up." },
    sql2_demo_completed: { answer: "Demo re-run for the new team", evidence: "The demo helped the team get up to speed." },
  },
  "keelson-anchor-freight": {
    why_looking: { answer: "Consolidating three tools into one", evidence: "We're trying to get off three separate tools and onto one platform." },
    why_looking_now: { answer: "Current vendor contract is ending", evidence: "Our current vendor contract ends this year, so the timing is now." },
    existing_systems: { answer: "Three disconnected point tools", evidence: "Right now it's three point tools that don't talk to each other." },
    budget_range_stated: { answer: "Approved at the exec level", evidence: "The budget's approved, our COO signed off." },
    budget_fit: { answer: "Priced within approval", evidence: "The number fits what the COO approved." },
    close_date_validated: { answer: "Sign before Q4 peak", evidence: "We need it live before the Q4 peak, that date works." },
    timeline_notes: { answer: "Migration off legacy tools is the dependency", evidence: "Main thing is migrating off the three tools." },
    key_decision_maker_identified: { answer: "COO is the signer and is engaged", evidence: "I'm the COO and I'm the sign-off on this." },
    sql1_close_plan_presented: { answer: "Cutover plan off three tools", evidence: "The plan to consolidate onto one platform works." },
    sql1_storyboard_positioned: { answer: "Value framed on one system of record", evidence: "One system instead of three is the pitch internally." },
    sql2_proposal_delivered: { answer: "Proposal reviewed", evidence: "We went through the proposal." },
    sql2_demo_completed: { answer: "Demo completed", evidence: "The demo covered what we needed." },
    sql2_site_visit: { answer: "Site walkthrough done", evidence: "You saw our operation on the last visit." },
    sql3_final_proposal: { answer: "Final proposal in hand", evidence: "This is the final pricing." },
  },
  "keelson-vantage-supply": {
    why_looking: { answer: "Customs delays hitting their SLAs", evidence: "Customs delays are starting to hit the SLAs we promise shippers." },
    why_looking_now: { answer: "A large shipper threatened to leave", evidence: "One of our larger shippers said they'd leave if we didn't fix turnaround." },
    existing_systems: { answer: "Homegrown tool plus manual customs", evidence: "We built our own tool but customs is still manual." },
    competition_notes: { answer: "Evaluated one competitor, ruled out", evidence: "We looked at one other vendor but they couldn't handle our volume." },
    key_decision_maker_identified: { answer: "VP Supply Chain signs off", evidence: "The final call sits with me as VP of Supply Chain." },
    budget_fit: { answer: "Within the set-aside range", evidence: "Your number is within what we set aside." },
    close_date_validated: { answer: "Go-live before peak", evidence: "We need it live before the Q4 peak." },
    timeline_notes: { answer: "Data migration is the dependency", evidence: "Migrating our data is the one thing on our side." },
    sql1_close_plan_presented: { answer: "Rollout plan agreed with Maya", evidence: "The rollout plan works on our end." },
    sql1_storyboard_positioned: { answer: "Value framed on shipper retention", evidence: "Keeping our big shipper is the story internally." },
    sql2_proposal_delivered: { answer: "Proposal reviewed", evidence: "We reviewed the proposal." },
    sql2_demo_completed: { answer: "Demo completed", evidence: "The demo was useful." },
    sql3_final_proposal: { answer: "Final proposal submitted", evidence: "This is the final version." },
  },
  "keelson-harborview-freight": {
    why_looking: { answer: "Scaling into a new lane, need automation", evidence: "We're opening a new lane and can't staff the manual work for it." },
    why_looking_now: { answer: "New lane launches next quarter", evidence: "The new lane goes live next quarter, so we need this before then." },
    existing_systems: { answer: "Spreadsheets and email for customs", evidence: "Honestly it's spreadsheets and email holding customs together today." },
    competition_notes: { answer: "Compared two vendors, prefer us", evidence: "We compared a couple of options and you're our preference." },
    key_decision_maker_identified: { answer: "CFO signs, ops recommends", evidence: "Ops recommends but the CFO signs off." },
    budget_fit: { answer: "Within the CFO's approved budget", evidence: "It fits the budget the CFO approved." },
    close_date_validated: { answer: "Live before the new lane opens", evidence: "It needs to be in before the new lane launches." },
    timeline_notes: { answer: "Standing up the new lane is the dependency", evidence: "The dependency is getting the new lane stood up." },
    sql1_close_plan_presented: { answer: "Rollout tied to the lane launch", evidence: "The plan lines up with our lane launch date." },
    sql1_storyboard_positioned: { answer: "Value framed on staffing the new lane", evidence: "If it lets us open the lane without hiring, that's the case." },
    sql2_proposal_delivered: { answer: "Proposal reviewed", evidence: "We went through the proposal." },
    sql2_demo_completed: { answer: "Demo completed", evidence: "The demo landed well." },
    sql3_final_proposal: { answer: "Final proposal submitted", evidence: "This is the final pricing." },
  },
  "keelson-tidewater-distribution": {
    why_looking: { answer: "Peak volume overwhelming manual entry", evidence: "Peak volume is more than our team can key by hand." },
    why_looking_now: { answer: "Second peak in a row they struggled", evidence: "That's two peaks in a row we barely got through, we can't do a third." },
    existing_systems: { answer: "TMS with no customs module", evidence: "Our TMS has no customs module, so that's all manual." },
    close_date_validated: { answer: "Live before next peak", evidence: "We need it live before the Q4 peak, that date works." },
    timeline_notes: { answer: "TMS integration is the dependency", evidence: "The main thing on our side is the TMS integration." },
    key_decision_maker_identified: { answer: "VP Finance owns the budget call", evidence: "She owns the budget so it's her call." },
    budget_fit: { answer: "Within the range they set", evidence: "Your number is within what we planned." },
    sql1_close_plan_presented: { answer: "Rollout timed to before peak", evidence: "The plan gets us live before peak, which is what matters." },
    sql1_storyboard_positioned: { answer: "Value framed on surviving peak", evidence: "If it gets us through peak clean, that's the story." },
    sql2_demo_completed: { answer: "Demo completed for both teams", evidence: "The demo was helpful for the ops and finance folks." },
  },
};

function copyFor(externalId: string, key: string): { answer: string; evidence: string } {
  return QUOTES_BY_DEAL[externalId]?.[key] ?? FIELD_COPY[key] ?? { answer: "Confirmed on the call", evidence: "" };
}

type Relationship = "champion" | "influencer" | "economic_buyer" | "user" | "unknown";

type ContactSeed = {
  name: string;
  role: string;
  relationship: Relationship;
  /** Days ago last contacted, or null for "never contacted". */
  lastContactedDaysAgo: number | null;
};

type TaskSeed = {
  title: string;
  actionType: "email" | "book_meeting" | "send_materials" | "internal" | "other";
  priority: "high" | "medium" | "low";
  dueInDays: number;
  /** True when DealRipe prescribed this step because the call agreed none. Shows
   *  a "DealRipe prescribed" badge in the Actions decision layer. */
  prescribed?: boolean;
};

type DealSeed = {
  externalId: string;
  account: string;
  industry: string;
  arr: number;
  stageKey: string;
  daysInStage: number;
  repProbability: number; // 0..1 -> Commit >=0.7, Expect >=0.4, else Pipeline
  closeDate: string; // ISO date
  repEmail: string;
  repNotes: string;
  contacts: ContactSeed[];
  call: {
    externalId: string;
    subtype: string; // discovery | demo | proposal | follow_up
    daysAgo: number;
    durationMinutes: number;
    transcript: string;
  };
  /** Optional earlier calls (deal history), each owning the gate keys it established,
   *  so only the most recent (extracted) call's fields show as NEW on extract. Gates
   *  not owned by a prior call are attributed to the recent call. */
  priorCalls?: Array<{
    externalId: string;
    subtype: string;
    daysAgo: number;
    durationMinutes: number;
    transcript: string;
    gates: string[];
  }>;
  confirmed: string[]; // gate field_keys marked "Yes"
  open: string[]; // gate field_keys explicitly marked "No" (storyline gaps)
  task: TaskSeed;
};

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// Insert one call + its transcript, return the call id. meetingType null marks a
// context call (an early discovery) that the coverage view does not track.
async function insertCall(
  db: ReturnType<typeof supabaseAdmin>,
  tenantId: string,
  dealId: string,
  account: string,
  participants: string[],
  meetingType: string | null,
  spec: { externalId: string; subtype: string; daysAgo: number; durationMinutes: number; transcript: string },
): Promise<string> {
  const when = isoDaysAgo(spec.daysAgo);
  const callUp = await db
    .from("calls")
    .insert({
      tenant_id: tenantId,
      deal_id: dealId,
      external_id: spec.externalId,
      call_date: when,
      scheduled_start: when,
      duration_minutes: spec.durationMinutes,
      participants: participants as unknown as Json,
      source: "manual_paste",
      has_been_extracted: true,
      outcome: "captured",
      meeting_type: meetingType,
      call_subtype: spec.subtype,
      title: `${account} / Keelson`,
    })
    .select("id")
    .single();
  if (callUp.error || !callUp.data) {
    console.error(`  call insert failed (${account}): ${callUp.error?.message}`);
    process.exit(1);
  }
  const callId = callUp.data.id;
  const trUp = await db
    .from("transcripts")
    .insert({ tenant_id: tenantId, call_id: callId, body: spec.transcript })
    .select("id")
    .single();
  if (trUp.error || !trUp.data) {
    console.error(`  transcript insert failed (${account}): ${trUp.error?.message}`);
    process.exit(1);
  }
  await db.from("calls").update({ transcript_id: trUp.data.id }).eq("id", callId);
  return callId;
}

// ---------------------------------------------------------------------
// The 6 fictional Keelson deals. Roll-up: ~$1.9M, 2 Commit / 2 Expect /
// 2 Pipeline, 3 at risk, 1 stalled, 2 healthy. The confirmed/open gate sets
// and the contact relationships are tuned to produce those exact health
// states through the live pipeline's own classifier (components/MagayaPipeline).
// ---------------------------------------------------------------------
const DEALS: DealSeed[] = [
  {
    externalId: "keelson-cascade-freight",
    account: "Cascade Freight Systems",
    industry: "Freight forwarding, US West Coast",
    arr: 420_000,
    stageKey: "SQL3",
    daysInStage: 18,
    repProbability: 0.85, // Commit
    closeDate: "2026-10-15",
    repEmail: "dana@keelson.example",
    repNotes: "Dana. Pricing sent. VP of Operations (economic buyer) has not been on a call yet.",
    contacts: [
      { name: "Ray Delgado", role: "Operations Manager", relationship: "champion", lastContactedDaysAgo: 5 },
      { name: "Elena Voss", role: "VP Operations", relationship: "economic_buyer", lastContactedDaysAgo: null },
    ],
    priorCalls: [
      {
        externalId: "keelson-cascade-freight-c1",
        subtype: "discovery",
        daysAgo: 27,
        durationMinutes: 31,
        gates: ["why_looking", "why_looking_now", "existing_systems", "next_step_confirmed"],
        transcript: [
          "Dana Reyes (Keelson): Ray, appreciate the intro. What's pushing Cascade to look now?",
          "Ray Delgado (Cascade): The re-keying. We're doing customs entries by hand and it's costing us hours a day.",
          "Dana Reyes: Why now versus six months ago?",
          "Ray Delgado: With peak coming we can't keep doing this manually through Q4.",
          "Dana Reyes: What are you running today?",
          "Ray Delgado: Our old TMS and a lot of spreadsheets.",
          "Dana Reyes: I'll pull together a plan and we'll reconvene.",
          "Ray Delgado: Let's talk again next week.",
        ].join("\n"),
      },
      {
        externalId: "keelson-cascade-freight-c2",
        subtype: "demo",
        daysAgo: 20,
        durationMinutes: 44,
        gates: ["sql1_close_plan_presented", "sql1_storyboard_positioned", "sql2_demo_completed", "sql2_site_visit"],
        transcript: [
          "Dana Reyes (Keelson): I ran the demo on your lanes today.",
          "Ray Delgado (Cascade): The demo on our lanes was helpful.",
          "Dana Reyes: I also walked the dated rollout plan to go live before Q4.",
          "Ray Delgado: That milestone plan to go live by Q4 makes sense.",
          "Dana Reyes: The value story is really the time saved re-keying.",
          "Ray Delgado: If it saves us that much re-keying, that's the story for my boss.",
          "Dana Reyes: Worth a site visit to see the warehouse flow?",
          "Ray Delgado: Come see the warehouse operation next month.",
        ].join("\n"),
      },
      {
        externalId: "keelson-cascade-freight-c3",
        subtype: "proposal",
        daysAgo: 13,
        durationMinutes: 37,
        gates: ["budget_range_stated", "budget_fit", "close_date_validated", "timeline_notes", "sql2_proposal_delivered"],
        transcript: [
          "Dana Reyes (Keelson): I sent the proposal over, wanted to check the numbers land.",
          "Ray Delgado (Cascade): We went through the proposal you sent.",
          "Dana Reyes: On budget?",
          "Ray Delgado: We've got somewhere between 300 and 500 thousand set aside, so your number is within what we planned.",
          "Dana Reyes: And the go-live target?",
          "Ray Delgado: We need it live before the Q4 peak, that date works.",
          "Dana Reyes: Anything on your side that gates the timeline?",
          "Ray Delgado: The one thing is migrating the entry data.",
        ].join("\n"),
      },
    ],
    call: {
      externalId: "keelson-cascade-freight-1",
      subtype: "proposal",
      daysAgo: 6,
      durationMinutes: 38,
      transcript: [
        "Dana Reyes (Keelson): Thanks for making time, Ray. I sent the pricing over on Monday, wanted to walk it with you.",
        "Ray Delgado (Cascade): Got it, thanks. The re-keying problem is real. We're doing customs entries by hand and it's costing us hours a day.",
        "Dana Reyes: And with peak coming that only gets worse, right?",
        "Ray Delgado: Exactly. We can't keep doing this manually through Q4.",
        "Dana Reyes: The rollout plan I shared has you live before the Q4 peak. Does that milestone plan make sense?",
        "Ray Delgado: It does. That date works for us.",
        "Dana Reyes: On budget, where are we?",
        "Ray Delgado: We've got somewhere between 300 and 500 thousand set aside, so your number is within what we planned. Our VP signs off on anything over 250K though.",
        "Dana Reyes: That's Elena, the VP of Operations?",
        "Ray Delgado: Right. The final call sits with her. I took your deck to our leadership review already.",
        "Dana Reyes: Good. This is the final version of the pricing. Can we get Elena on the next one?",
        "Ray Delgado: Let me see what I can do. Let's get the team together again next Thursday.",
      ].join("\n"),
    },
    // Strong on scope/timeline; economic buyer never on a call. Executive gate open.
    confirmed: [...SQL1, ...SQL2, "budget_approver_named", "key_decision_maker_identified", "champion_internal_action", "sql3_final_proposal"],
    open: ["sql4_exec_involvement", "competition_notes"],
    task: {
      title: "Book the economic-buyer session with Elena Voss (VP Operations)",
      actionType: "book_meeting",
      priority: "high",
      dueInDays: 2,
      prescribed: true,
    },
  },
  {
    externalId: "keelson-delmar-customs",
    account: "Delmar Customs Brokerage",
    industry: "Customs brokerage, Gulf Coast",
    arr: 180_000,
    stageKey: "SQL2",
    daysInStage: 24,
    repProbability: 0.5, // Expect
    closeDate: "2026-09-30",
    repEmail: "tom@keelson.example",
    repNotes: "Tom. Last scheduled call was a no-show. No response in 9 days. Forecast has not caught up.",
    contacts: [
      { name: "Marcus Hale", role: "President", relationship: "economic_buyer", lastContactedDaysAgo: 12 },
    ],
    call: {
      externalId: "keelson-delmar-customs-1",
      subtype: "discovery",
      daysAgo: 16,
      durationMinutes: 29,
      transcript: [
        "Tom Fielding (Keelson): Appreciate you jumping on, Marcus. Tell me what's pushing you to look at this now.",
        "Marcus Hale (Delmar): Honestly the manual entry work. We're re-keying entries by hand and it's costing us hours a day.",
        "Tom Fielding: And why now versus six months ago?",
        "Marcus Hale: Volume is up and it's exposing the bottleneck. With peak coming we can't keep doing this manually.",
        "Tom Fielding: What are you running today?",
        "Marcus Hale: An old TMS and a lot of spreadsheets.",
        "Tom Fielding: Got it. I'd like to set up a working session with your ops folks to scope this.",
        "Marcus Hale: Sure, send some times and I'll pull them in.",
        "Tom Fielding: Will do. I'll get that over today.",
        "Marcus Hale: Sounds good, talk soon.",
      ].join("\n"),
    },
    // Thin evidence for an Expect forecast: only the SQL1 drivers captured.
    confirmed: ["why_looking", "why_looking_now", "existing_systems"],
    open: ["next_step_confirmed"],
    task: {
      title: "Re-book the missed call directly with Marcus Hale",
      actionType: "book_meeting",
      priority: "high",
      dueInDays: 1,
    },
  },
  {
    externalId: "keelson-pacific-cargo",
    account: "Pacific Cargo Group",
    industry: "3PL, national",
    arr: 320_000,
    stageKey: "SQL3",
    daysInStage: 20,
    repProbability: 0.5, // Expect
    closeDate: "2026-09-20",
    repEmail: "priya@keelson.example",
    repNotes: "Priya. A competing WMS was named on the last call and never addressed. Competition gate open.",
    contacts: [
      { name: "Sandra Ng", role: "Director of Operations", relationship: "influencer", lastContactedDaysAgo: 7 },
    ],
    call: {
      externalId: "keelson-pacific-cargo-1",
      subtype: "demo",
      daysAgo: 8,
      durationMinutes: 41,
      transcript: [
        "Priya Nair (Keelson): Sandra, thanks for the time. I ran the demo on lanes like yours today.",
        "Sandra Ng (Pacific): The demo on our lanes was helpful, thank you.",
        "Priya Nair: What's driving the evaluation on your side?",
        "Sandra Ng: The manual customs work. We're re-keying entries by hand and it's costing us hours a day.",
        "Priya Nair: And the timing?",
        "Sandra Ng: Peak season is exposing the bottleneck. We need help before it hits.",
        "Priya Nair: On budget, do you have a range in mind?",
        "Sandra Ng: We've got somewhere between 300 and 500 thousand set aside, and that number is within what we planned. Our VP signs off on anything over 250K.",
        "Sandra Ng: I should be upfront, we're also looking at our incumbent WMS vendor for this.",
        "Priya Nair: Understood. Let's keep going through the requirements.",
        "Sandra Ng: The final call sits with our operations exec.",
        "Priya Nair: Great. We can pick this up next week.",
      ].join("\n"),
    },
    // Competitor named and left open; SQL1 + partial SQL2/SQL3 captured.
    confirmed: [...SQL1, "budget_range_stated", "budget_fit", "close_date_validated", "timeline_notes", "key_decision_maker_identified", "sql3_final_proposal"],
    open: ["competition_notes"],
    task: {
      title: "Send a tailored Keelson vs WMS walkthrough to Sandra",
      actionType: "send_materials",
      priority: "high",
      dueInDays: 2,
    },
  },
  {
    externalId: "keelson-summit-logistics",
    account: "Summit Logistics",
    industry: "Freight forwarding, Midwest",
    arr: 250_000,
    stageKey: "SQL2",
    daysInStage: 62,
    repProbability: 0.35, // Pipeline
    closeDate: "2026-11-30",
    repEmail: "alex@keelson.example",
    repNotes: "Alex. Champion changed roles. Procurement not engaged at day 62. No new call in 8 days.",
    contacts: [
      { name: "Dana Whitfield", role: "Director of Operations", relationship: "champion", lastContactedDaysAgo: 8 },
    ],
    call: {
      externalId: "keelson-summit-logistics-1",
      subtype: "discovery",
      daysAgo: 8,
      durationMinutes: 33,
      transcript: [
        "Alex Moreno (Keelson): Dana, thanks for picking this back up. I know you've stepped into the ops role recently.",
        "Dana Whitfield (Summit): Yes, I'm the new Director of Operations. Catching up on this evaluation.",
        "Alex Moreno: Happy to re-ground it. What's the core problem you're solving?",
        "Dana Whitfield: The manual customs entry. We're re-keying by hand and it's costing us hours a day.",
        "Alex Moreno: And urgency?",
        "Dana Whitfield: Peak season is exposing the bottleneck.",
        "Alex Moreno: What's in place today?",
        "Dana Whitfield: An old TMS and spreadsheets.",
        "Alex Moreno: I showed the demo last time. Where does procurement come in for a deal this size?",
        "Dana Whitfield: Good question, I'll need to check. I only just took this over.",
        "Alex Moreno: Let's get that mapped. I'll follow up with next steps.",
      ].join("\n"),
    },
    // Stalled: Pipeline forecast (no mismatch), 62 days in stage, procurement not mapped.
    confirmed: [...SQL1, "budget_range_stated", "close_date_validated", "sql2_demo_completed"],
    open: ["decision_process_mapped"],
    task: {
      title: "Re-engage Dana Whitfield and open procurement",
      actionType: "internal",
      priority: "high",
      dueInDays: 3,
    },
  },
  {
    externalId: "keelson-anchor-freight",
    account: "Anchor Freight Forwarding",
    industry: "Freight forwarding, Northeast",
    arr: 510_000,
    stageKey: "SQL4",
    daysInStage: 12,
    repProbability: 0.92, // Commit
    closeDate: "2026-08-08",
    repEmail: "dana@keelson.example",
    repNotes: "Dana. Every gate met with a customer quote behind it. Procurement aligned, signer in the room twice.",
    contacts: [
      { name: "Tom Bianchi", role: "COO", relationship: "economic_buyer", lastContactedDaysAgo: 3 },
    ],
    call: {
      externalId: "keelson-anchor-freight-1",
      subtype: "proposal",
      daysAgo: 4,
      durationMinutes: 45,
      transcript: [
        "Dana Reyes (Keelson): Tom, thanks. I think we're close. Wanted to confirm the commercials and the path to signature.",
        "Tom Bianchi (Anchor): Agreed. The commercial terms work for us.",
        "Dana Reyes: And legal?",
        "Tom Bianchi: Legal cleared the last redlines. Our in-house counsel handled it.",
        "Dana Reyes: On timing, the rollout has you live before the Q4 peak. Still good?",
        "Tom Bianchi: We need it live before the Q4 peak, that date works.",
        "Dana Reyes: Budget and approver?",
        "Tom Bianchi: We've got the budget approved, and I'm the sign-off as COO. I'm in the room for this one.",
        "Dana Reyes: Then let's set the signing date.",
        "Tom Bianchi: We can sign by the end of the month.",
        "Dana Reyes: Perfect. I'll send the agreement and we'll book the signing call.",
      ].join("\n"),
    },
    // Clean commit: every SQL1-SQL4 gate met.
    confirmed: [...SQL1, ...SQL2, ...SQL3, ...SQL4],
    open: [],
    task: {
      title: "Book the signing call with Tom Bianchi",
      actionType: "book_meeting",
      priority: "medium",
      dueInDays: 2,
    },
  },
  {
    externalId: "keelson-vantage-supply",
    account: "Vantage Supply Chain",
    industry: "3PL, Southeast",
    arr: 210_000,
    stageKey: "SQL3",
    daysInStage: 9,
    repProbability: 0.35, // Pipeline
    closeDate: "2026-08-12",
    repEmail: "priya@keelson.example",
    repNotes: "Priya. Decision maker confirmed on the last call. Last open gate now closeable.",
    contacts: [
      { name: "Maya Okonkwo", role: "VP Supply Chain", relationship: "economic_buyer", lastContactedDaysAgo: 4 },
    ],
    call: {
      externalId: "keelson-vantage-supply-1",
      subtype: "proposal",
      daysAgo: 5,
      durationMinutes: 36,
      transcript: [
        "Priya Nair (Keelson): Maya, thanks for confirming you're the decision maker on this.",
        "Maya Okonkwo (Vantage): Yes, the final call sits with me as VP of Supply Chain.",
        "Priya Nair: What's driving this for you?",
        "Maya Okonkwo: The manual customs entry, we're re-keying by hand and it's costing us hours a day.",
        "Priya Nair: Timing?",
        "Maya Okonkwo: We need it live before the Q4 peak, that date works.",
        "Priya Nair: Budget?",
        "Maya Okonkwo: We've got the range set aside and your number is within what we planned. I sign off on this.",
        "Priya Nair: You're our front-runner comment earlier, still true?",
        "Maya Okonkwo: You're our preferred option right now. The one open item is the legal review.",
        "Priya Nair: Understood, that's the last gate. Let's line it up.",
      ].join("\n"),
    },
    // Healthy, closeable: all SQL1-SQL2 and most SQL3, one gate (legal) still open.
    confirmed: [...SQL1, ...SQL2, "budget_approver_named", "key_decision_maker_identified", "champion_internal_action", "decision_process_mapped", "sql3_selected_vendor", "sql3_final_proposal", "competition_notes"],
    open: ["sql3_legal_internal"],
    task: {
      title: "Confirm the last open gate and set the close step",
      actionType: "email",
      priority: "medium",
      dueInDays: 3,
    },
  },
  {
    externalId: "keelson-harborview-freight",
    account: "Harborview Freight",
    industry: "Freight forwarding, Pacific Northwest",
    arr: 380_000,
    stageKey: "SQL3",
    daysInStage: 10,
    repProbability: 0.55, // Expect (rep is under-calling a clean deal)
    closeDate: "2026-09-25",
    repEmail: "priya@keelson.example",
    repNotes: "Priya. CFO joined last week. Every gate but legal confirmed. Rep still has this at Expect.",
    contacts: [
      { name: "Grace Lin", role: "Operations Manager", relationship: "champion", lastContactedDaysAgo: 4 },
      { name: "Nadia Brandt", role: "CFO", relationship: "economic_buyer", lastContactedDaysAgo: 6 },
    ],
    call: {
      externalId: "keelson-harborview-freight-1",
      subtype: "proposal",
      daysAgo: 6,
      durationMinutes: 42,
      transcript: [
        "Priya Nair (Keelson): Thanks for joining, Nadia. Grace and I have been scoping this and I wanted the numbers in front of you directly.",
        "Nadia Brandt (Harborview): Appreciate it. The manual customs re-keying is a real cost for us, so I'm supportive.",
        "Priya Nair: On budget, does the pricing sit inside your range?",
        "Nadia Brandt: It does, that number is within what we planned, and I sign off on this size.",
        "Priya Nair: Timeline?",
        "Nadia Brandt: We need it live before the Q4 peak, that date works.",
        "Priya Nair: The last open item is your legal review of the agreement.",
        "Nadia Brandt: Right, our counsel just needs to run the redlines. Everything else is settled on our side.",
        "Priya Nair: Then let's line up the signing once legal clears.",
        "Nadia Brandt: Works for me.",
      ].join("\n"),
    },
    confirmed: [...SQL1, ...SQL2, "budget_approver_named", "competition_notes", "key_decision_maker_identified", "champion_internal_action", "decision_process_mapped", "sql3_selected_vendor", "sql3_final_proposal"],
    open: ["sql3_legal_internal"],
    task: {
      title: "Book the signing call with Nadia Brandt (CFO)",
      actionType: "book_meeting",
      priority: "medium",
      dueInDays: 3,
    },
  },
  {
    externalId: "keelson-tidewater-distribution",
    account: "Tidewater Distribution",
    industry: "3PL, Gulf Coast",
    arr: 290_000,
    stageKey: "SQL2",
    daysInStage: 14,
    repProbability: 0.35, // Pipeline (rep is under-calling; deal is advancing)
    closeDate: "2026-10-05",
    repEmail: "priya@keelson.example",
    repNotes: "Priya. Second stakeholder joined Tuesday. Budget confirmed on the record. Moving faster than the rep's Pipeline call.",
    contacts: [
      { name: "Owen Marsh", role: "Director of Logistics", relationship: "champion", lastContactedDaysAgo: 3 },
      { name: "Renata Cole", role: "VP Finance", relationship: "economic_buyer", lastContactedDaysAgo: 3 },
    ],
    call: {
      externalId: "keelson-tidewater-distribution-1",
      subtype: "demo",
      daysAgo: 4,
      durationMinutes: 37,
      transcript: [
        "Priya Nair (Keelson): Owen, glad you could bring Renata in today.",
        "Owen Marsh (Tidewater): Of course. She owns the budget so it made sense.",
        "Renata Cole (Tidewater): The manual customs entry is costing us hours a day, so I wanted to see it firsthand.",
        "Priya Nair: On budget, is there a range set aside?",
        "Renata Cole: We've got the range set aside and your number is within what we planned.",
        "Priya Nair: And the timeline?",
        "Owen Marsh: We need it live before the Q4 peak, that date works.",
        "Priya Nair: Great. I'll send the proposal and let's set a review.",
        "Owen Marsh: Sounds good, let's get that on the calendar.",
      ].join("\n"),
    },
    confirmed: [...SQL1, "budget_range_stated", "budget_fit", "close_date_validated", "timeline_notes", "sql2_demo_completed", "key_decision_maker_identified"],
    open: ["competition_notes"],
    task: {
      title: "Confirm budget in writing and set the proposal review",
      actionType: "email",
      priority: "medium",
      dueInDays: 2,
    },
  },
];

function categoryOf(p: number): string {
  return p >= 0.7 ? "Commit" : p >= 0.4 ? "Expect" : "Pipeline";
}

function leverageDetailFor(account: string): string | null {
  const lev = KEELSON.leverage.find((l) => l.account === account);
  return lev?.action ?? null;
}

// Insert the one deterministic prescribed action for a deal's call, clearing any
// prior tasks on that call first (idempotent + wins over any recap-generated
// tasks the content-layer seed may have added). "prescribed" tasks carry a
// sentinel prefix the Actions decision layer reads to show a DealRipe badge.
async function upsertDeterministicTask(
  db: ReturnType<typeof supabaseAdmin>,
  tenantId: string,
  dealId: string,
  callId: string,
  d: DealSeed,
): Promise<void> {
  await db.from("tasks").delete().eq("tenant_id", tenantId).eq("call_id", callId);
  const deadline = new Date(Date.now() + d.task.dueInDays * 86_400_000).toISOString().slice(0, 10);
  const prefix = d.task.prescribed
    ? "DealRipe prescribed this next step because no next step was agreed on the call. "
    : "";
  const leverage = leverageDetailFor(d.account);
  const detail = (prefix + (leverage ?? "")).trim() || null;
  const taskIns = await db.from("tasks").insert({
    tenant_id: tenantId,
    deal_id: dealId,
    call_id: callId,
    title: d.task.title,
    detail,
    action_type: d.task.actionType,
    priority: d.task.priority,
    deadline,
    rep_email: d.repEmail,
    status: "todo",
    source: "call",
  });
  if (taskIns.error) {
    console.error(`  task insert failed (${d.account}): ${taskIns.error.message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = supabaseAdmin();

  console.log("");
  console.log(`DealRipe keelson demo seed  (${apply ? "APPLY" : "DRY RUN, nothing written"})`);
  console.log("");

  // ---- 1. Tenant ----
  let tenantId: string;
  const existing = await db.from("tenants").select("id").eq("slug", TENANT_SLUG).maybeSingle();
  if (existing.error) {
    console.error(`tenants lookup failed: ${existing.error.message}`);
    process.exit(1);
  }
  if (existing.data) {
    tenantId = existing.data.id;
    console.log(`tenant:            ${TENANT_SLUG} exists (id=${tenantId})`);
  } else if (!apply) {
    tenantId = "<created-on-apply>";
    console.log(`tenant:            ${TENANT_SLUG} would be created ({ slug, name: "${TENANT_NAME}" })`);
  } else {
    const ins = await db.from("tenants").insert({ slug: TENANT_SLUG, name: TENANT_NAME }).select("id").single();
    if (ins.error || !ins.data) {
      console.error(`tenant insert failed: ${ins.error?.message}`);
      process.exit(1);
    }
    tenantId = ins.data.id;
    console.log(`tenant:            ${TENANT_SLUG} created (id=${tenantId})`);
  }

  // ---- 2. Framework prerequisite ----
  let frameworkId: string | null = null;
  if (tenantId !== "<created-on-apply>") {
    const fw = await db
      .from("qualification_frameworks")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("name", FRAMEWORK_NAME)
      .maybeSingle();
    frameworkId = fw.data?.id ?? null;
  }
  if (!frameworkId) {
    if (apply) {
      console.error(
        `\nFramework "${FRAMEWORK_NAME}" not found for tenant '${TENANT_SLUG}'.\n` +
          `Run this first:  npx tsx scripts/seed-magaya-framework.ts --tenant ${TENANT_SLUG}\n`,
      );
      process.exit(1);
    }
    console.log(`framework:         NOT YET SEEDED. Run: npx tsx scripts/seed-magaya-framework.ts --tenant ${TENANT_SLUG}`);
  } else {
    console.log(`framework:         ${FRAMEWORK_NAME} (id=${frameworkId})`);
  }

  console.log("");
  console.log(`deals to seed:     ${DEALS.length}`);
  const total = DEALS.reduce((s, d) => s + d.arr, 0);
  console.log(`pipeline total:    $${total.toLocaleString("en-US")}`);
  console.log("");

  // Idempotent + constraint-independent: clear keelson's child rows before
  // re-inserting, in FK-safe order (mirrors the proven rollback order). Strictly
  // scoped to the keelson tenant, so magaya is never touched. Deals stay (upserted).
  if (apply && tenantId !== "<created-on-apply>") {
    for (const t of [
      "tasks",
      "prescribed_actions",
      "sent_messages",
      "deal_signal_snapshots",
      "extraction_runs",
      "briefing_runs",
      "field_extractions",
      "transcripts",
      "calls",
      "contacts",
    ] as const) {
      const del = await db.from(t).delete().eq("tenant_id", tenantId);
      if (del.error) {
        console.error(`  clear ${t} failed: ${del.error.message}`);
        process.exit(1);
      }
    }
  }

  // Deals seeded this run, for the post-comms deterministic-task re-assert.
  const seeded: Array<{ d: DealSeed; dealId: string; callId: string }> = [];

  for (const d of DEALS) {
    const confirmedCount = d.confirmed.length;
    console.log(
      `  ${d.account.padEnd(28)} ${d.stageKey}  $${(d.arr / 1000).toFixed(0)}K  ` +
        `${categoryOf(d.repProbability).padEnd(8)} ${confirmedCount}/27 gates  ` +
        `${d.contacts.length} contact(s)  task: ${d.task.title}`,
    );

    if (!apply) continue;

    // ---- Deal ----
    const dealUp = await db
      .from("deals")
      .upsert(
        {
          tenant_id: tenantId,
          external_id: d.externalId,
          account: d.account,
          industry: d.industry,
          arr: d.arr,
          stage_key: d.stageKey,
          days_in_stage: d.daysInStage,
          rep_forecast_probability: d.repProbability,
          rep_forecast_close_date: d.closeDate,
          rep_notes: d.repNotes,
          rep_email: d.repEmail,
          framework_id: frameworkId,
        },
        { onConflict: "tenant_id,external_id" },
      )
      .select("id")
      .single();
    if (dealUp.error || !dealUp.data) {
      console.error(`  deal upsert failed (${d.account}): ${dealUp.error?.message}`);
      process.exit(1);
    }
    const dealId = dealUp.data.id;

    // ---- Contacts ----
    for (const c of d.contacts) {
      const cUp = await db.from("contacts").insert({
        tenant_id: tenantId,
        deal_id: dealId,
        name: c.name,
        role: c.role,
        relationship: c.relationship,
        last_contacted_at: c.lastContactedDaysAgo == null ? null : isoDaysAgo(c.lastContactedDaysAgo),
      });
      if (cUp.error) {
        console.error(`  contact upsert failed (${c.name}): ${cUp.error.message}`);
        process.exit(1);
      }
    }

    // ---- Calls: deal history (prior calls) then the recent, extracted call ----
    // Only contacts who were actually engaged attend the calls; a "never contacted"
    // stakeholder (e.g. the economic buyer who has not been in a call) is excluded,
    // so the participant list matches the contact card and the deal's story.
    const attendees = d.contacts.filter((c) => c.lastContactedDaysAgo != null).map((c) => c.name);
    const participants = attendees.length > 0 ? attendees : d.contacts.map((c) => c.name);
    const gateCallId = new Map<string, string>();
    for (const pc of d.priorCalls ?? []) {
      const pcId = await insertCall(db, tenantId, dealId, d.account, participants, null, pc);
      for (const g of pc.gates) gateCallId.set(g, pcId);
    }
    const callId = await insertCall(db, tenantId, dealId, d.account, participants, "new_opportunity", d.call);

    // ---- Field extractions (deterministic gate state) ----
    const fxRows = [
      ...d.confirmed.map((key) => ({
        tenant_id: tenantId,
        deal_id: dealId,
        framework_field_key: key,
        framework_id: frameworkId,
        status: "Yes" as const,
        answer: copyFor(d.externalId, key).answer,
        evidence: copyFor(d.externalId, key).evidence,
        confidence: 0.9,
        last_updated_from_call_id: gateCallId.get(key) ?? callId,
      })),
      ...d.open.map((key) => ({
        tenant_id: tenantId,
        deal_id: dealId,
        framework_field_key: key,
        framework_id: frameworkId,
        status: "No" as const,
        answer: null,
        evidence: null,
        confidence: null,
        last_updated_from_call_id: callId,
      })),
    ];
    const fxUp = await db
      .from("field_extractions")
      .insert(fxRows)
      .select("framework_field_key");
    if (fxUp.error) {
      console.error(`  field_extractions upsert failed (${d.account}): ${fxUp.error.message}`);
      process.exit(1);
    }

    // ---- Task (Actions view). Idempotent: clears this call's prior tasks, re-inserts. ----
    await upsertDeterministicTask(db, tenantId, dealId, callId, d);
    seeded.push({ d, dealId, callId });

    // ---- Snapshot (rep category vs DealRipe read). Reuses lib/snapshot. ----
    try {
      const fullDeal = await getDealForTenant(tenantId, dealId);
      const framework = await getFrameworkForDeal(dealId);
      if (fullDeal && framework) {
        await recordDealSnapshot(tenantId, fullDeal, framework, null);
      }
    } catch (err) {
      console.error(`  snapshot failed (${d.account}): ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log(`    -> seeded deal ${dealId} (call ${callId}, ${fxRows.length} gate rows, 1 task, snapshot)`);
  }

  // ---- Content layer: briefings, recaps, digest (real renderers, archived only) ----
  if (apply && tenantId !== "<created-on-apply>") {
    console.log("");
    console.log("content layer (briefings, recaps, digest):");
    try {
      const res = await seedKeelsonComms({ tenantId, apply: true, log: (s) => console.log(s) });
      console.log(`  archived ${res.briefings} briefings, ${res.recaps} recaps, ${res.digests} digest.`);
    } catch (err) {
      console.error(`  comms seed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Re-assert the deterministic prescribed actions: a recap can regenerate a
    // call's tasks, so the seeded action is written last and wins.
    for (const s of seeded) {
      await upsertDeterministicTask(db, tenantId, s.dealId, s.callId, s.d);
    }

    // ---- CRM write-back trail (links deals to a CRM opp + logs the writes) ----
    console.log("");
    console.log("crm write-back (opportunity link + write log):");
    try {
      const crm = await seedKeelsonCrm({ tenantId, apply: true, log: (s) => console.log(s) });
      console.log(`  linked ${crm.deals} deals, logged ${crm.writes} write-backs.`);
    } catch (err) {
      console.error(`  crm seed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("");
  if (apply) {
    console.log(`seed-keelson complete. View at /pipeline?tenant=${TENANT_SLUG}`);
  } else {
    console.log(`Dry run only. Re-run with --apply to write. Ensure the framework is seeded first:`);
    console.log(`  npx tsx scripts/seed-magaya-framework.ts --tenant ${TENANT_SLUG}`);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
