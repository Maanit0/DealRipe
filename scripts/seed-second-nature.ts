/**
 * Seed the "second-nature" demo tenant: a fictional residential
 * property-management SaaS company (Second Nature) selling a Resident Benefits
 * Package (RBP) to property managers. NEAT qualification framework, Salesforce
 * CRM, Zoom call recordings. All account, rep, and contact names are FICTIONAL,
 * modeled on Second Nature's world (doors, CARR, Beagle/Buildium switching),
 * never a real customer's pipeline.
 *
 * ADDITIVE, IDEMPOTENT, INERT (same guarantees as seed-keelson.ts): every row
 * is scoped to the second-nature tenant_id; upserts on natural keys; the tenant
 * has no live CRM/calendar connection and every cron is pinned to magaya, so
 * nothing scheduled ever touches it.
 *
 * Prerequisites (run in order, on a machine with .env.local + DB access):
 *   1. npx tsx scripts/seed-second-nature.ts --apply        # creates tenant + deals
 *      (on first run it creates the tenant, then errors asking for the framework)
 *   2. npx tsx scripts/seed-neat-framework.ts --tenant second-nature
 *   3. npx tsx scripts/seed-second-nature.ts --apply        # re-run: deals + comms + crm
 *
 * View at /pipeline?tenant=second-nature (sidebar carries ?tenant=second-nature).
 * Roll back:  npx tsx scripts/delete-tenant-data.ts second-nature
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import type { Json } from "../lib/database.types";
import { getFrameworkForDeal } from "../lib/framework";
import { recordDealSnapshot } from "../lib/snapshot";
import { supabaseAdmin } from "../lib/supabase";
import { getDealForTenant } from "../lib/supabase-queries";
import { seedSecondNatureComms } from "./seed-second-nature-comms";
import { seedSecondNatureCrm } from "./seed-second-nature-crm";

const TENANT_SLUG = "second-nature";
const TENANT_NAME = "Second Nature";
const FRAMEWORK_NAME = "NEAT";

// NEAT gate groups by stage_key (must match seed-neat-framework.ts).
const SQL1 = ["N1", "N2"]; // Discovery — Need
const SQL2 = ["E1", "E2", "T1", "T2"]; // Evaluation — Economic impact + Timeline
const SQL3 = ["A1", "A2", "A3"]; // Vendor of Choice — Access to authority
const SQL4 = ["T3"]; // Contract Out — procurement path

// Believable customer-voice answer + evidence per NEAT gate. Property-management
// RBP themed. Reused across deals; per-deal overrides below.
// The `answer` is the exact content written into the Salesforce field, so it
// reads as a full, self-contained sentence (Magaya style), not a terse label.
// The verbatim `evidence` still backs it on the extraction sheet.
const FIELD_COPY: Record<string, { answer: string; evidence: string }> = {
  N1: { answer: "The team named resident retention and filter-driven maintenance tickets as the core pain, with turnover high enough that it comes up in every ops meeting.", evidence: "The retention angle is the big one for us. Turnover is brutal right now." },
  N2: { answer: "Make-ready and vacancy costs from turnover are eating into the portfolio between residents.", evidence: "Residents leave and the make-ready plus vacancy eats us alive." },
  E1: { answer: "The per-door value is quantified: a retention lift plus fewer filter tickets pencils out to a few hundred dollars per door per year.", evidence: "We modeled it at roughly a few hundred per door per year." },
  E2: { answer: "ROI is tied to the retention and NOI numbers ownership already judges the portfolio on.", evidence: "This moves the retention number ownership actually judges us on." },
  A1: { answer: "The economic buyer is the principal/owner, the person who signs a portfolio-wide deal.", evidence: "That'd be our principal. The owner signs a call this size." },
  A2: { answer: "The champion can get us in front of the owner on the next call, so there is a path to the decision-maker.", evidence: "I can get you in front of the owner on the next one." },
  A3: { answer: "Finance and ops are both engaged now, not just the operations lead.", evidence: "Our finance lead is looped in now, not just my ops team." },
  T1: { answer: "The compelling event is leasing-season renewals: they want the program live before September.", evidence: "We'd want this live before September renewals really kick off." },
  T2: { answer: "Go-live is defined: working back from the renewal window, a signature is needed within a few weeks.", evidence: "Working back from go-live we'd need a signature in a few weeks." },
  T3: { answer: "The contracting path is known, sign-off runs through the owner, then a quick countersign on their side.", evidence: "Contracts go through the owner, then it's a quick sign on our side." },
};

const QUOTES_BY_DEAL: Record<string, Record<string, { answer: string; evidence: string }>> = {
  "sn-rowan-hill": {
    N1: { answer: "Renee, the ops lead and champion, named resident retention and filter-driven HVAC tickets as the core pain, with turnover brutal enough that it comes up in every ops meeting.", evidence: "The retention angle is the big one for us. Turnover is brutal right now." },
    N2: { answer: "Renee said make-ready and vacancy costs from turnover are eating the portfolio alive between residents.", evidence: "Residents leave and the make-ready plus vacancy eats us alive." },
    A1: { answer: "The economic buyer is Greg Hollis, the principal and owner who signs a deal this size, and he has not been on any call yet.", evidence: "That'd be Greg, our principal. He hasn't been in any of these conversations yet." },
    T1: { answer: "The compelling event is confirmed: they want the program live before September leasing-season renewals, which Renee called the real window.", evidence: "We'd want this live before September renewals really kick off. That's the window." },
    T2: { answer: "Go-live is targeted before September renewals; Renee is redoing the resident policy for the new leasing season and needs a signature within a few weeks.", evidence: "We're redoing our resident policy for the new leasing season." },
  },
};

function copyFor(externalId: string, key: string): { answer: string; evidence: string } {
  return QUOTES_BY_DEAL[externalId]?.[key] ?? FIELD_COPY[key] ?? { answer: "Confirmed on the call", evidence: "" };
}

type Relationship = "champion" | "influencer" | "economic_buyer" | "user" | "unknown";
type ContactSeed = { name: string; role: string; relationship: Relationship; lastContactedDaysAgo: number | null };
type TaskSeed = {
  title: string;
  actionType: "email" | "book_meeting" | "send_materials" | "internal" | "other";
  priority: "high" | "medium" | "low";
  dueInDays: number;
  detail: string;
  prescribed?: boolean;
};
type CallSpec = { externalId: string; subtype: string; daysAgo: number; durationMinutes: number; transcript: string };
type UpcomingSpec = { externalId: string; subtype: string; inDays: number; durationMinutes: number };
type DealSeed = {
  externalId: string;
  account: string;
  industry: string;
  arr: number; // CARR
  doors: number;
  stageKey: string;
  daysInStage: number;
  repProbability: number;
  closeDate: string;
  repEmail: string;
  repName: string;
  repNotes: string;
  contacts: ContactSeed[];
  call: CallSpec;
  /** Meeting type for the main call; defaults to new_opportunity. Set
   *  "existing_customer" for post-close lifecycle calls (e.g. onboarding). */
  meetingType?: string;
  priorCalls?: Array<CallSpec & { gates: string[] }>;
  upcoming?: UpcomingSpec;
  confirmed: string[];
  open: string[];
  task: TaskSeed;
};

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

async function insertCall(
  db: ReturnType<typeof supabaseAdmin>,
  tenantId: string,
  dealId: string,
  account: string,
  participants: string[],
  meetingType: string | null,
  spec: { externalId: string; subtype: string; whenIso: string; durationMinutes: number; transcript: string; extracted: boolean; outcome: string },
): Promise<string> {
  const callUp = await db
    .from("calls")
    .insert({
      tenant_id: tenantId,
      deal_id: dealId,
      external_id: spec.externalId,
      call_date: spec.whenIso,
      scheduled_start: spec.whenIso,
      duration_minutes: spec.durationMinutes,
      participants: participants as unknown as Json,
      source: spec.extracted ? "manual_paste" : "recall_ai",
      has_been_extracted: spec.extracted,
      outcome: spec.outcome,
      meeting_type: meetingType,
      call_subtype: spec.subtype,
      title: `${account} / Second Nature`,
    })
    .select("id")
    .single();
  if (callUp.error || !callUp.data) {
    console.error(`  call insert failed (${account}): ${callUp.error?.message}`);
    process.exit(1);
  }
  const callId = callUp.data.id;
  if (spec.transcript.trim()) {
    const trUp = await db.from("transcripts").insert({ tenant_id: tenantId, call_id: callId, body: spec.transcript }).select("id").single();
    if (trUp.error || !trUp.data) {
      console.error(`  transcript insert failed (${account}): ${trUp.error?.message}`);
      process.exit(1);
    }
    await db.from("calls").update({ transcript_id: trUp.data.id }).eq("id", callId);
  }
  return callId;
}

// ---------------------------------------------------------------------
// The Second Nature deals (fictional property-management accounts).
// ---------------------------------------------------------------------
const DEALS: DealSeed[] = [
  {
    externalId: "sn-rowan-hill",
    account: "Rowan Hill Residential",
    industry: "Residential property management, Midwest",
    arr: 137_242,
    doors: 400,
    stageKey: "SQL2",
    daysInStage: 21,
    repProbability: 0.7, // Commit — rep is optimistic
    closeDate: "2026-08-28",
    repEmail: "casey@secondnature.example",
    repName: "Casey Boyd",
    repNotes: "Casey. Champion loves it, but the owner who signs has never been on a call and per-door impact isn't quantified. Switching off Beagle.",
    contacts: [
      { name: "Renee Alvarez", role: "Director of Operations", relationship: "champion", lastContactedDaysAgo: 9 },
      { name: "Greg Hollis", role: "Principal / Owner", relationship: "economic_buyer", lastContactedDaysAgo: null },
    ],
    priorCalls: [
      {
        externalId: "sn-rowan-hill-c1",
        subtype: "discovery",
        daysAgo: 34,
        durationMinutes: 27,
        gates: ["N1"],
        transcript: [
          "Casey Boyd (Second Nature): Renee, thanks for the intro. What's got you looking at a resident benefits package?",
          "Renee Alvarez (Rowan Hill): The retention angle is the big one for us. Turnover is brutal right now.",
          "Casey Boyd: That's the pattern we see. Let's dig into the numbers next time.",
          "Renee Alvarez: Sounds good.",
        ].join("\n"),
      },
    ],
    call: {
      externalId: "sn-rowan-hill-1",
      subtype: "demo",
      daysAgo: 9,
      durationMinutes: 31,
      transcript: [
        "Casey Boyd (Second Nature): Thanks for making time, Renee. Last we talked you were digging into the resident benefits package for the 400 doors. Where'd that land?",
        "Renee Alvarez (Rowan Hill): Honestly the team's excited. The air filter delivery alone would take a real bite out of our maintenance tickets, we're drowning in HVAC calls that are just clogged filters. And the retention angle is the big one for us. Turnover is brutal right now.",
        "Casey Boyd: I know you tried Beagle before, what happened there?",
        "Renee Alvarez: It was a bad experience, honestly. Residents complained, the rollout was messy, and we pulled it. So there's some scar tissue internally.",
        "Casey Boyd: That's fair. On retention, what's turnover running for you?",
        "Renee Alvarez: It's high. Residents leave and the make-ready plus vacancy eats us alive.",
        "Casey Boyd: Have you and I put an actual dollar figure on that yet for the portfolio?",
        "Renee Alvarez: Not really. I know it's real, I just haven't modeled it out.",
        "Casey Boyd: When it comes time to sign across the 400 doors, who owns that call?",
        "Renee Alvarez: That'd be Greg, our principal. He hasn't been in any of these conversations yet, it's been me and my ops folks. He wants the numbers before he moves.",
        "Renee Alvarez: Timing-wise, we're redoing our resident policy for the new leasing season, so we'd want this live before September renewals really kick off. That's the window.",
        "Casey Boyd: That gives us a date to work back from. Let me pull together next steps.",
        "Renee Alvarez: I'm bought in, I just need to get Greg there.",
      ].join("\n"),
    },
    upcoming: { externalId: "sn-rowan-hill-next", subtype: "working_session", inDays: 5, durationMinutes: 30 },
    // Strong Need + Timeline; Economic Impact and deeper Authority open.
    confirmed: ["N1", "N2", "A1", "T1", "T2"],
    open: ["E1", "E2", "A2"],
    task: {
      title: "Get the principal, Greg Hollis, into the next working session",
      actionType: "book_meeting",
      priority: "high",
      dueInDays: 3,
      prescribed: true,
      detail:
        "Ask Renee to broker 30 minutes with the owner before pricing goes out, framed on the per-door retention and make-ready numbers, and turn the failed Beagle rollout into the reason to choose Second Nature. This portfolio-wide switch does not close without the signer in the room.",
    },
  },
  {
    externalId: "sn-kestrel",
    account: "Kestrel Property Group",
    industry: "Residential property management, Midwest",
    arr: 122_990,
    doors: 352,
    stageKey: "SQL2",
    daysInStage: 58,
    repProbability: 0.35, // Pipeline
    closeDate: "2026-08-15",
    repEmail: "casey@secondnature.example",
    repName: "Casey Boyd",
    repNotes: "Casey. Evaluation was seven weeks ago and it's gone quiet. Close date already passed, no next meeting booked.",
    contacts: [{ name: "Priya Raman", role: "Operations Director", relationship: "champion", lastContactedDaysAgo: 49 }],
    call: {
      externalId: "sn-kestrel-1",
      subtype: "discovery",
      daysAgo: 49,
      durationMinutes: 28,
      transcript: [
        "Casey Boyd (Second Nature): Priya, what's pushing Kestrel to look at a benefits package now?",
        "Priya Raman (Kestrel): The retention angle is the big one for us. Turnover is brutal right now.",
        "Casey Boyd: And operationally?",
        "Priya Raman: Residents leave and the make-ready plus vacancy eats us alive.",
        "Casey Boyd: What's forcing the timing?",
        "Priya Raman: We'd want this live before September renewals really kick off.",
        "Casey Boyd: I'll pull together next steps and we'll reconvene.",
        "Priya Raman: Sounds good.",
      ].join("\n"),
    },
    confirmed: ["N1", "N2", "T1"],
    open: ["E1"],
    task: {
      title: "Re-open Kestrel with a per-door number, not a check-in",
      actionType: "book_meeting",
      priority: "high",
      dueInDays: 2,
      detail:
        "Evaluation was seven weeks ago and the close date already passed. Send two concrete windows and the one number that would move it. Deals left quiet after a stalled eval die on the vine.",
    },
  },
  {
    externalId: "sn-meridian",
    account: "Meridian Property Management",
    industry: "Residential property management, Mid-Atlantic",
    arr: 162_262,
    doors: 210,
    stageKey: "SQL3",
    daysInStage: 20,
    repProbability: 0.5, // Expect
    closeDate: "2026-08-05",
    repEmail: "marcus@secondnature.example",
    repName: "Marcus Vale",
    repNotes: "Marcus. Upsell at Vendor of Choice, but the close date is stale and there's no mutual close plan on the record.",
    contacts: [
      { name: "Dana Whitfield", role: "VP Operations", relationship: "champion", lastContactedDaysAgo: 6 },
      { name: "Owen Marsh", role: "Managing Partner", relationship: "economic_buyer", lastContactedDaysAgo: 9 },
    ],
    call: {
      externalId: "sn-meridian-1",
      subtype: "proposal",
      daysAgo: 6,
      durationMinutes: 34,
      transcript: [
        "Marcus Vale (Second Nature): Dana, glad you brought Owen in. On the expansion, where are we?",
        "Owen Marsh (Meridian): We modeled it and the per-door value holds up. This moves the retention number ownership judges us on.",
        "Dana Whitfield (Meridian): The filter program has already cut our HVAC tickets on the doors we piloted.",
        "Marcus Vale: On timing?",
        "Owen Marsh: We'd want this live before September renewals really kick off.",
        "Marcus Vale: Who signs the expansion?",
        "Owen Marsh: I do, and I'm engaged. I just want the rollout steps mapped before we commit.",
        "Marcus Vale: Let's set that mutual plan and get it done.",
      ].join("\n"),
    },
    confirmed: ["N1", "N2", "E1", "E2", "T1", "T2", "A1"],
    open: ["A2"],
    task: {
      title: "Set the mutual close plan and correct the stale date",
      actionType: "internal",
      priority: "high",
      dueInDays: 2,
      detail:
        "The vendor-of-choice call already happened; there is no reason this sits at a passed close date with no agreed path to signature. Send the buyer the steps and dates back from go-live, in writing.",
    },
  },
  {
    externalId: "sn-fairway",
    account: "Fairway Rental Management",
    industry: "Residential property management, mixed portfolio",
    arr: 57_395,
    doors: 400,
    stageKey: "SQL2",
    daysInStage: 64,
    repProbability: 0.35, // Pipeline
    closeDate: "2026-09-01",
    repEmail: "marcus@secondnature.example",
    repName: "Marcus Vale",
    repNotes: "Marcus. Buildium-managed portfolio; the switching question from the broker conference was never resolved. Stalled.",
    contacts: [{ name: "Grant Sutter", role: "Broker / Principal", relationship: "champion", lastContactedDaysAgo: 40 }],
    call: {
      externalId: "sn-fairway-1",
      subtype: "discovery",
      daysAgo: 40,
      durationMinutes: 30,
      transcript: [
        "Marcus Vale (Second Nature): Hollis, what's the interest in the benefits package?",
        "Grant Sutter (Fairway): The retention angle is the big one for us. Turnover is brutal right now.",
        "Marcus Vale: You run Buildium across the portfolio, right? How are you thinking about the fit?",
        "Grant Sutter (Fairway): That's the open question. We run Buildium and I need to know this sits on top of it, not a rip-and-replace.",
        "Marcus Vale: Fair. Timing?",
        "Grant Sutter (Fairway): We'd want this live before September renewals really kick off.",
        "Marcus Vale: Let me put together how it runs alongside Buildium.",
        "Grant Sutter (Fairway): That'd help.",
      ].join("\n"),
    },
    confirmed: ["N1", "N2", "T1"],
    open: ["E1"],
    task: {
      title: "Surface the Buildium displacement with a tailored walkthrough",
      actionType: "send_materials",
      priority: "medium",
      dueInDays: 3,
      detail:
        "Send a short walkthrough of how the RBP runs alongside a Buildium-managed portfolio and where it wins, and confirm the integration concern from the broker conference. The competition gate cannot close while that question is open.",
    },
  },
  {
    externalId: "sn-coastline",
    account: "Coastline Property Group",
    industry: "Residential property management, inbound",
    arr: 94_515,
    doors: 262,
    stageKey: "SQL4",
    daysInStage: 11,
    repProbability: 0.9, // Commit
    closeDate: "2026-08-05",
    repEmail: "erin@secondnature.example",
    repName: "Erin Walsh",
    repNotes: "Erin. Contract out since mid-June, decision-maker confirmed. Only the per-door value one-pager is open.",
    contacts: [
      { name: "Tara Nguyen", role: "Director of Operations", relationship: "champion", lastContactedDaysAgo: 4 },
      { name: "Sam Ortiz", role: "Principal", relationship: "economic_buyer", lastContactedDaysAgo: 5 },
    ],
    call: {
      externalId: "sn-coastline-1",
      subtype: "proposal",
      daysAgo: 5,
      durationMinutes: 33,
      transcript: [
        "Erin Walsh (Second Nature): Sam, thanks for joining. We're close, I wanted to confirm the path to signature.",
        "Sam Ortiz (Coastline): The retention case is clear and I sign this. This moves the retention number ownership judges us on.",
        "Tara Nguyen (Coastline): The filter program alone justifies it on our ticket volume.",
        "Erin Walsh: Timing?",
        "Sam Ortiz: We'd want this live before September renewals really kick off.",
        "Erin Walsh: I'll get the per-door one-pager over and we set the signing.",
        "Sam Ortiz: Works for me.",
      ].join("\n"),
    },
    confirmed: ["N1", "N2", "E2", "A1", "A2", "A3", "T1", "T2", "T3"],
    open: ["E1"],
    task: {
      title: "Deliver the per-door value one-pager and book the signing call",
      actionType: "book_meeting",
      priority: "medium",
      dueInDays: 3,
      detail: "Contract out since mid-June. Deliver the value case and lock the signing date before month-end.",
    },
  },
  {
    externalId: "sn-anchorline",
    account: "Anchorline Property Management",
    industry: "Residential property management, Southeast",
    arr: 77_394,
    doors: 181,
    stageKey: "SQL4",
    daysInStage: 9,
    repProbability: 0.92, // Commit
    closeDate: "2026-08-08",
    repEmail: "erin@secondnature.example",
    repName: "Erin Walsh",
    repNotes: "Erin. Every NEAT gate met with a quote behind it. Ready to move, insurance line resolved.",
    contacts: [{ name: "Jordan Diaz", role: "Owner / Principal", relationship: "economic_buyer", lastContactedDaysAgo: 3 }],
    call: {
      externalId: "sn-anchorline-1",
      subtype: "proposal",
      daysAgo: 4,
      durationMinutes: 29,
      transcript: [
        "Erin Walsh (Second Nature): Jordan, I think we're ready. Commercials and the go-live plan good on your side?",
        "Jordan Diaz (Anchorline): Yes. We modeled it at roughly a few hundred per door per year and it holds. I'm the owner and I sign this.",
        "Erin Walsh: Timeline?",
        "Jordan Diaz: We'd want this live before September renewals really kick off, and working back we'd need a signature in a few weeks.",
        "Erin Walsh: Procurement on your side?",
        "Jordan Diaz: Contracts go through me, then it's a quick sign.",
        "Erin Walsh: Perfect, let's set the date.",
      ].join("\n"),
    },
    confirmed: ["N1", "N2", "E1", "E2", "A1", "A2", "A3", "T1", "T2", "T3"],
    open: [],
    task: {
      title: "Book the signing call with Jordan Diaz",
      actionType: "book_meeting",
      priority: "medium",
      dueInDays: 2,
      detail: "Every gate met with a customer quote behind it. Push for signature before the quarter rolls.",
    },
  },
  {
    externalId: "sn-harbor-point",
    account: "Harbor Point Property Management",
    industry: "Residential property management, mandatory portfolio",
    arr: 27_709,
    doors: 116,
    stageKey: "SQL4",
    daysInStage: 6,
    repProbability: 0.95, // Commit
    closeDate: "2026-08-01",
    repEmail: "hollis@secondnature.example",
    repName: "Hollis Carter",
    repNotes: "Hollis. Signed intent, mandatory across the portfolio. Awaiting counter-signature.",
    contacts: [{ name: "Alex Mercer", role: "VP Operations", relationship: "economic_buyer", lastContactedDaysAgo: 2 }],
    call: {
      externalId: "sn-harbor-point-1",
      subtype: "proposal",
      daysAgo: 3,
      durationMinutes: 26,
      transcript: [
        "Hollis Carter (Second Nature): Alex, sounds like we're set. Anything left on your side?",
        "Alex Mercer (Harbor Point): We're making it mandatory across the portfolio. This moves the retention number ownership judges us on.",
        "Hollis Carter: And the contracting path?",
        "Alex Mercer: Contracts go through me, then it's a quick sign. We'd want this live before September renewals really kick off.",
        "Hollis Carter: Great, sending the agreement now.",
        "Alex Mercer: Perfect.",
      ].join("\n"),
    },
    confirmed: ["N1", "N2", "E1", "E2", "A1", "A2", "A3", "T1", "T2", "T3"],
    open: [],
    task: {
      title: "Send the agreement and confirm counter-signature",
      actionType: "email",
      priority: "medium",
      dueInDays: 2,
      detail: "Mandatory across the portfolio. Send the agreement and confirm the counter-signature date.",
    },
  },
  {
    // Post-close lifecycle example: closed won, now in onboarding. DealRipe keeps
    // reading the customer calls after the win and flags when implementation
    // stalls and sales should re-engage — the account-level trajectory ask.
    externalId: "sn-brightline",
    account: "Brightline Property Management",
    industry: "Residential property management · closed won, in onboarding",
    arr: 86_192,
    doors: 228,
    stageKey: "SQL5",
    daysInStage: 25,
    repProbability: 1.0,
    closeDate: "2026-07-06",
    repEmail: "erin@secondnature.example",
    repName: "Erin Walsh",
    repNotes: "Erin. Closed won Jul 6. Onboarding kickoff held Jul 20; no data-migration owner named on the customer side.",
    meetingType: "existing_customer",
    contacts: [
      { name: "Monica Reyes", role: "Director of Property Operations", relationship: "champion", lastContactedDaysAgo: 11 },
    ],
    call: {
      externalId: "sn-brightline-onboarding-1",
      subtype: "follow_up",
      daysAgo: 11,
      durationMinutes: 24,
      transcript: [
        "Erin Walsh (Second Nature): Monica, congrats again. Kickoff today: resident notices, the filter schedule, and the data migration.",
        "Monica Reyes (Brightline): Excited to get going. Notices we can send next week, and the filter schedule looks straightforward.",
        "Erin Walsh: Great. On the data migration, who on your side owns the resident and unit export?",
        "Monica Reyes (Brightline): Honestly, that's the open question. Our ops coordinator left two weeks ago and nobody has picked that up yet.",
        "Erin Walsh: Understood, that's the one thing that gates the go-live date. Without an owner, the September start slips.",
        "Monica Reyes (Brightline): Let me raise it internally and come back to you.",
        "Erin Walsh: I'll put it in writing so it's easy to forward. Everything else is on track.",
      ].join("\n"),
    },
    confirmed: ["N1", "N2", "E1", "E2", "A1", "A2", "A3", "T1", "T2", "T3"],
    open: [],
    task: {
      title: "Onboarding stalled: no data-migration owner. Sales re-engage.",
      actionType: "internal",
      priority: "high",
      dueInDays: 2,
      prescribed: true,
      detail:
        "The onboarding kickoff surfaced that nobody on the customer side owns the resident and unit data export after their ops coordinator left. That gates go-live, and go-live gates when this revenue actualizes. Erin should re-engage Monica this week with a one-line ask: name the owner, or we lend a hand with the export directly.",
    },
  },
];

function categoryOf(p: number): string {
  return p >= 0.7 ? "Commit" : p >= 0.4 ? "Expect" : "Pipeline";
}

async function upsertDeterministicTask(
  db: ReturnType<typeof supabaseAdmin>,
  tenantId: string,
  dealId: string,
  callId: string,
  d: DealSeed,
): Promise<void> {
  await db.from("tasks").delete().eq("tenant_id", tenantId).eq("call_id", callId);
  const deadline = new Date(Date.now() + d.task.dueInDays * 86_400_000).toISOString().slice(0, 10);
  const prefix = d.task.prescribed ? "DealRipe prescribed this next step because no next step was agreed on the call. " : "";
  const detail = (prefix + d.task.detail).trim() || null;
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
  console.log(`DealRipe second-nature demo seed  (${apply ? "APPLY" : "DRY RUN, nothing written"})`);
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
    console.log(`tenant:            ${TENANT_SLUG} would be created`);
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
    const fw = await db.from("qualification_frameworks").select("id").eq("tenant_id", tenantId).eq("name", FRAMEWORK_NAME).maybeSingle();
    frameworkId = fw.data?.id ?? null;
  }
  if (!frameworkId) {
    if (apply) {
      console.error(`\nFramework "${FRAMEWORK_NAME}" not found for '${TENANT_SLUG}'.\nRun:  npx tsx scripts/seed-neat-framework.ts --tenant ${TENANT_SLUG}\nthen re-run this script.\n`);
      process.exit(1);
    }
    console.log(`framework:         NOT YET SEEDED. Run: npx tsx scripts/seed-neat-framework.ts --tenant ${TENANT_SLUG}`);
  } else {
    console.log(`framework:         ${FRAMEWORK_NAME} (id=${frameworkId})`);
  }

  console.log("");
  console.log(`deals to seed:     ${DEALS.length}`);
  console.log(`pipeline total:    $${DEALS.reduce((s, d) => s + d.arr, 0).toLocaleString("en-US")} CARR`);
  console.log("");

  if (apply && tenantId !== "<created-on-apply>") {
    for (const t of ["tasks", "prescribed_actions", "sent_messages", "deal_signal_snapshots", "extraction_runs", "briefing_runs", "field_extractions", "transcripts", "calls", "contacts"] as const) {
      const del = await db.from(t).delete().eq("tenant_id", tenantId);
      if (del.error) {
        console.error(`  clear ${t} failed: ${del.error.message}`);
        process.exit(1);
      }
    }
  }

  const seeded: Array<{ d: DealSeed; dealId: string; callId: string }> = [];

  for (const d of DEALS) {
    console.log(`  ${d.account.padEnd(30)} ${d.stageKey}  $${(d.arr / 1000).toFixed(0)}K  ${d.doors} doors  ${categoryOf(d.repProbability).padEnd(8)} ${d.confirmed.length}/10 gates  ${d.repName}`);
    if (!apply) continue;

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
        console.error(`  contact insert failed (${c.name}): ${cUp.error.message}`);
        process.exit(1);
      }
    }

    const attendees = d.contacts.filter((c) => c.lastContactedDaysAgo != null).map((c) => c.name);
    const participants = attendees.length > 0 ? attendees : d.contacts.map((c) => c.name);
    const gateCallId = new Map<string, string>();
    for (const pc of d.priorCalls ?? []) {
      const pcId = await insertCall(db, tenantId, dealId, d.account, participants, null, {
        externalId: pc.externalId,
        subtype: pc.subtype,
        whenIso: isoDaysAgo(pc.daysAgo),
        durationMinutes: pc.durationMinutes,
        transcript: pc.transcript,
        extracted: true,
        outcome: "captured",
      });
      for (const g of pc.gates) gateCallId.set(g, pcId);
    }
    const callId = await insertCall(db, tenantId, dealId, d.account, participants, d.meetingType ?? "new_opportunity", {
      externalId: d.call.externalId,
      subtype: d.call.subtype,
      whenIso: isoDaysAgo(d.call.daysAgo),
      durationMinutes: d.call.durationMinutes,
      transcript: d.call.transcript,
      extracted: true,
      outcome: "captured",
    });

    // Upcoming (future) meeting: not yet extracted, shows in Meetings -> Upcoming.
    if (d.upcoming) {
      await insertCall(db, tenantId, dealId, d.account, participants, null, {
        externalId: d.upcoming.externalId,
        subtype: d.upcoming.subtype,
        whenIso: isoInDays(d.upcoming.inDays),
        durationMinutes: d.upcoming.durationMinutes,
        transcript: "",
        extracted: false,
        outcome: "scheduled",
      });
    }

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
    const fxUp = await db.from("field_extractions").insert(fxRows).select("framework_field_key");
    if (fxUp.error) {
      console.error(`  field_extractions insert failed (${d.account}): ${fxUp.error.message}`);
      process.exit(1);
    }

    await upsertDeterministicTask(db, tenantId, dealId, callId, d);
    seeded.push({ d, dealId, callId });

    try {
      const fullDeal = await getDealForTenant(tenantId, dealId);
      const framework = await getFrameworkForDeal(dealId);
      if (fullDeal && framework) await recordDealSnapshot(tenantId, fullDeal, framework, null);
    } catch (err) {
      console.error(`  snapshot failed (${d.account}): ${err instanceof Error ? err.message : String(err)}`);
    }

    console.log(`    -> seeded deal ${dealId} (call ${callId}, ${fxRows.length} gate rows, 1 task${d.upcoming ? ", 1 upcoming" : ""}, snapshot)`);
  }

  if (apply && tenantId !== "<created-on-apply>") {
    console.log("\ncontent layer (briefings, recaps, digest):");
    try {
      const res = await seedSecondNatureComms({ tenantId, apply: true, log: (s) => console.log(s) });
      console.log(`  archived ${res.briefings} briefings, ${res.recaps} recaps, ${res.digests} digest.`);
    } catch (err) {
      console.error(`  comms seed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const s of seeded) await upsertDeterministicTask(db, tenantId, s.dealId, s.callId, s.d);

    console.log("\ncrm write-back (opportunity link + write log):");
    try {
      const crm = await seedSecondNatureCrm({ tenantId, apply: true, log: (s) => console.log(s) });
      console.log(`  linked ${crm.deals} deals, logged ${crm.writes} write-backs.`);
    } catch (err) {
      console.error(`  crm seed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("");
  if (apply) console.log(`seed-second-nature complete. View at /pipeline?tenant=${TENANT_SLUG}`);
  else console.log(`Dry run. Re-run with --apply. Ensure framework is seeded: npx tsx scripts/seed-neat-framework.ts --tenant ${TENANT_SLUG}`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
