/**
 * Building the recap, separated from delivering it.
 *
 * This is a lift of the logic that used to live inside sendPostCallSummary,
 * moved so that something other than the email path can produce a recap. The
 * reason is scripts/preview-recap.ts: iterating on recap quality against a real
 * transcript is impossible if the only way to see one is to email a rep, and a
 * preview that reimplements the assembly would drift from production and then
 * lie about it.
 *
 * The split is on the WRITE boundary, not on convenience:
 *
 *   buildRecap        reads, generates, returns. Writes nothing, sends nothing.
 *   sendPostCallSummary  takes that result, persists tasks, renders, emails.
 *
 * So the preview can call buildRecap and be certain it is looking at exactly
 * what the rep would get, while being structurally incapable of touching the
 * rep's mailbox, the tasks table, or a customer's CRM.
 */

import type { ExtractionMap } from "./briefing-magaya";
import { readCustomerTimezone } from "./customer-timezone";
import { getDealContext, type DealContext } from "./deal-context";
import { inferStageKey } from "./deal-state";
import {
  classifyMeetingType,
  generateGeneralRecap,
  type GeneralRecap,
  type MeetingType,
} from "./meeting-classify";
import { generatePostCallSummary, type PostCallSummary } from "./post-call-summary";
import {
  buildDemoStrategy,
  buildNarrative,
  type DemoStrategy,
  type GroundingTrace,
  type Narrative,
  type PassResult,
} from "./recap-passes";
import { getDealExtraction, getUpcomingCallForDeal } from "./supabase-queries";
import { supabaseAdmin } from "./supabase";
import { generateTasksFromCall, type GeneratedTask } from "./tasks";
import type { Framework } from "./framework";

/**
 * Which recap this call gets, and why.
 *
 * `reason` is carried on every variant rather than only on failures, because
 * "this got a narrative instead of a qualification audit" is a decision a rep
 * may disagree with, and a decision nobody can see is one nobody can correct.
 */
export type RecapBuild =
  | {
      kind: "qualification";
      reason: string;
      account: string;
      meetingType: MeetingType;
      stageKey: string;
      summary: PostCallSummary;
      /** Pass 1. Written from the transcript alone; never sees the extraction. */
      narrative: PassResult<Narrative>;
      /** What grounding removed from the narrative, so deletions are visible. */
      narrativeGrounding: GroundingTrace;
      /** Pass 3. Written from the verified narrative, not the raw transcript. */
      demoStrategy: PassResult<DemoStrategy>;
      /**
       * What prior calls on this deal established, and the BDR's Salesforce
       * notes. The two things the doc says our recap can carry that a generic
       * transcript tool cannot.
       */
      history: string | null;
      crmContext: string | null;
      /** Why crmContext is what it is. Never collapse this to a boolean. */
      crmContextStatus: DealContext["crmContextStatus"] | "context_unavailable";
      /** Generated, NOT persisted. The caller decides whether to write them. */
      tasks: GeneratedTask[];
    }
  | {
      kind: "general";
      reason: string;
      account: string;
      meetingType: MeetingType;
      /** The readout. Runs for every call type; only the audit is routed. */
      narrative: PassResult<Narrative>;
      narrativeGrounding: GroundingTrace;
      /** Old shallow shape, ONLY when the narrative produced nothing. */
      recap: GeneralRecap | null;
    };

export type BuildRecapInput = {
  tenantId: string;
  dealId: string;
  account: string;
  framework: Framework;
  /** Stage from the deal row, used only if the deal context cannot be built. */
  fallbackStageKey: string;
  closeDate?: string | null;
  extraction: ExtractionMap;
  transcript: string;
  callId?: string | null;
  /**
   * When this call happened. Bounds prior-call history so a recap for an older
   * call cannot cite a later one. Omit and history runs to the real now.
   */
  callAt?: string | null;
  meetingType?: MeetingType;
  /**
   * Skip task generation. The preview leaves this off so it shows the full
   * artifact; a caller that will not persist them can turn it off to save an
   * Anthropic call.
   */
  withTasks?: boolean;
};

/**
 * The deal's qualification state as it stood at `asOf`.
 *
 * field_extractions holds one row per (deal, field) carrying only its CURRENT
 * value plus `last_updated_from_call_id`, so "as of" is reconstructed by keeping
 * the rows whose current value was written by a call at or before that instant.
 *
 * Rows with no originating call are kept deliberately: those are the CRM
 * baseline seeded on day zero, which predates every call and was therefore true
 * at any asOf.
 *
 * This is an approximation and worth being honest about. A field a later call
 * OVERWROTE shows its later value, because the earlier one is not stored
 * anywhere. What it fixes is the case that actually bit: a field first
 * established after this call no longer counts as known at the time of it.
 */
async function extractionAsOf(tenantId: string, dealId: string, asOf: string): Promise<ExtractionMap> {
  const db = supabaseAdmin();
  const calls = await db
    .from("calls")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId)
    .lte("scheduled_start", asOf);
  if (calls.error) throw new Error(`as-of call list failed: ${calls.error.message}`);
  const ids = (calls.data ?? []).map((c) => c.id);

  const fx = await db
    .from("field_extractions")
    .select("framework_field_key, status, answer, evidence, confidence, last_updated_from_call_id")
    .eq("deal_id", dealId);
  if (fx.error) throw new Error(`as-of extraction read failed: ${fx.error.message}`);

  const allowed = new Set(ids);
  const rows = (fx.data ?? []).filter((r) => {
    const from = (r as { last_updated_from_call_id: string | null }).last_updated_from_call_id;
    return from === null || allowed.has(from);
  });
  return Object.fromEntries(
    rows.map((r) => [String((r as { framework_field_key: string }).framework_field_key), r]),
  ) as unknown as ExtractionMap;
}

export async function buildRecap(input: BuildRecapInput): Promise<RecapBuild> {
  // Classify the meeting. DealRipe auto-joins every invited meeting, so not
  // every call is a new-opportunity sales call. A customer or internal meeting
  // gets a plain takeaways + next-steps recap instead of the qualification one
  // (which would be the wrong shape and read as noise, per Eduardo's feedback).
  const meetingType = input.meetingType ?? (await classifyMeetingType(input.transcript));

  // THE NARRATIVE RUNS FOR EVERY CALL TYPE, and it runs first.
  //
  // It used to be reachable only on the new-opportunity path, so a renewal or a
  // support call fell through to generateGeneralRecap and got summary,
  // takeaways and next steps. That is thinner than what a discovery call gets,
  // which is exactly backwards: Medov is a contract review with a 70,000
  // character transcript and the rep needs the readout more there, not less.
  //
  // docs/recap-target-eduardo.md is explicit that a call on an existing account
  // "should produce a narrative and no qualification record". The narrative is
  // framework-free by construction, so it is the right artifact for any call.
  // What must not run on a renewal is the AUDIT, and that is now the only thing
  // the routing decides.
  const narrativePass = await buildNarrative({
    account: input.account,
    transcript: input.transcript,
  }).catch((err) => ({
    result: {
      status: "unavailable" as const,
      reason: `the narrative pass threw: ${err instanceof Error ? err.message : String(err)}`,
    },
    grounding: { droppedFacts: 0, droppedNumbers: 0, examples: [] },
  }));

  if (meetingType !== "new_opportunity") {
    // No audit, no demo strategy. A renewal does not get budget and decision
    // process listed as open on a customer who has paid for years.
    let fallback: GeneralRecap | null = null;
    if (narrativePass.result.status !== "present") {
      // Only when the narrative produced nothing. Losing both is worse than
      // sending the old shallow shape.
      fallback = await generateGeneralRecap({
        account: input.account,
        transcript: input.transcript,
      });
    }
    return {
      kind: "general",
      reason: `meeting classified as ${meetingType}, so the qualification audit does not apply. The readout still runs.`,
      account: input.account,
      meetingType,
      narrative: narrativePass.result,
      narrativeGrounding: narrativePass.grounding,
      recap: fallback,
    };
  }

  // "Still open" reflects the deal's cumulative call-verified state (the
  // field_extractions roll-up, which already includes this call by the time
  // this runs), not just what this one call covered, and never a stale CRM
  // entry. Best-effort.
  //
  // Bounded to this call when callAt is set, for the same reason history is.
  // A recap for the Aug 12 Dunavant discovery listed Signature, Business Terms
  // and Legal Terms as open, which is true of the deal today and absurd about a
  // first conversation. Gaps belong to the stage the deal was at WHEN THE CALL
  // HAPPENED. In production the recap runs minutes after the call so the two
  // are the same set and nothing changes; on a re-run or a backfill they are
  // not, and the audit was reading the deal's future back onto its past.
  let gapExtraction = input.extraction;
  try {
    gapExtraction = input.callAt
      ? await extractionAsOf(input.tenantId, input.dealId, input.callAt)
      : ((await getDealExtraction(input.dealId)) as unknown as ExtractionMap);
  } catch (err) {
    console.warn(
      `[recap-build] extraction roll-up read failed for deal ${input.dealId}: ${
        err instanceof Error ? err.message : String(err)
      }; using this call's extraction`,
    );
  }

  // Stage is calls-first (from the canonical deal context), so the recap's
  // "where it stands" agrees with the briefing and the deal page rather than
  // deferring to a stale/absent CRM stage. Best-effort.
  //
  // The same read also supplies prior-call history and the Salesforce BDR
  // context. Those are the two things docs/recap-target-eduardo.md names as
  // what our recap can carry and a generic tool cannot, and the first version
  // of this rebuild carried neither: getDealContext was called purely for the
  // stage and the rest of it was thrown away. Dunavant has two captured calls,
  // so the history was real and available the whole time.
  let stageKey = input.fallbackStageKey;
  let history: string | null = null;
  let crmContext: string | null = null;
  let crmContextStatus: DealContext["crmContextStatus"] | "context_unavailable" = "context_unavailable";
  try {
    const ctx = await getDealContext(input.tenantId, input.dealId, { asOf: input.callAt ?? null });
    if (ctx) {
      // effectiveStageKey is where the deal stands NOW. For a recap bounded to
      // an older call, re-derive it from the as-of extraction so the audit
      // measures gaps against the stage the call was actually at.
      stageKey = input.callAt
        ? inferStageKey(input.framework, gapExtraction as never, ctx.nominalStageKey)
        : ctx.effectiveStageKey;
      history = ctx.history;
      crmContext = ctx.crmContext;
      // Carried through verbatim rather than collapsed to a boolean. "No
      // Salesforce account for this company" and "the Salesforce lookup failed"
      // both produce a null crmContext and only one of them is a fact about the
      // customer.
      crmContextStatus = ctx.crmContextStatus;
    }
  } catch (err) {
    console.warn(
      `[recap-build] deal context read failed for deal ${input.dealId}: ${
        err instanceof Error ? err.message : String(err)
      }; using the deal's stored stage, and the recap will carry no history or CRM context`,
    );
  }

  // Pass 1 and the existing summary run CONCURRENTLY. They share no state and
  // neither needs the other, so serializing them would add a full generation to
  // the wall clock of a transcript-sync that already has a 240 second budget and
  // was killed mid-chain on 2026-08-13.
  //
  // The demo strategy cannot join them: it takes the VERIFIED narrative as
  // input, so it has to wait. That is deliberate. Running it off the raw
  // transcript in parallel would make it a third independent opinion, and we
  // already know what that produces. On the Aug 14 Dunavant call the recap said
  // a demo was booked for Thursday while the task list said no meeting was
  // scheduled, because those were two independent generations over one
  // transcript with nothing shared between them.
  const [summary] = await Promise.all([
    generatePostCallSummary({
      account: input.account,
      stageKey,
      closeDate: input.closeDate ?? undefined,
      framework: input.framework,
      extraction: input.extraction,
      gapExtraction,
      transcript: input.transcript,
    }),
  ]);

  let demoStrategy: PassResult<DemoStrategy>;
  if (narrativePass.result.status === "present") {
    demoStrategy = await buildDemoStrategy({
      account: input.account,
      transcript: input.transcript,
      narrative: narrativePass.result.value,
    }).catch((err) => ({
      status: "unavailable" as const,
      reason: `the demo strategy pass threw: ${err instanceof Error ? err.message : String(err)}`,
    }));
  } else {
    // Say which upstream pass caused it rather than reporting an empty section.
    demoStrategy = {
      status: narrativePass.result.status,
      reason: `no readout to plan from: ${narrativePass.result.reason}`,
    };
  }

  // The timezone is DERIVED, never inferred, and it overrides the model.
  //
  // Three previews of the same Dunavant call returned ET, ET and CT for a
  // customer who says "our main office is in Memphis, Tennessee". This value
  // decides whether a proposed meeting time is unambiguous, so a confident
  // wrong answer is worse than none, which the recap prompt already said while
  // asking a model to infer it anyway.
  //
  // When no place is named we clear it rather than keeping the model's guess.
  // "They never said where they are" is the honest answer and the draft can
  // handle it; a plausible wrong zone cannot be recovered from.
  const tz = readCustomerTimezone(input.transcript);
  summary.customerTimezone = tz.status === "found" ? tz.label.replace("CST_CN", "China Standard Time") : null;

  // "Next step agreed but no meeting booked": if the call implies a follow-up
  // meeting and the calendar has no upcoming call for this deal, flag it so the
  // rep books it now instead of letting it slip. Best-effort; a read failure
  // just leaves the flag off.
  if (summary.followUpMeetingExpected) {
    try {
      const upcoming = await getUpcomingCallForDeal(input.tenantId, input.dealId);
      summary.noFollowupBooked = !upcoming;
    } catch (err) {
      console.warn(
        `[recap-build] upcoming-call check failed for deal ${input.dealId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // Generated here, persisted by the caller. Keeping the write out of this
  // function is what lets the preview run the identical path safely.
  let tasks: GeneratedTask[] = [];
  if (input.withTasks !== false && input.callId) {
    tasks = await generateTasksFromCall({
      account: input.account,
      transcript: input.transcript,
      stageKey,
      nextStepHint: summary.nextStepCommitment ?? summary.suggestedNextStep,
    }).catch(() => []);
  }

  return {
    kind: "qualification",
    reason:
      meetingType === "new_opportunity"
        ? "meeting classified as new_opportunity"
        : `meeting classified as ${meetingType}, but the general recap could not be generated, so the qualification recap was used instead`,
    account: input.account,
    meetingType,
    stageKey,
    summary,
    narrative: narrativePass.result,
    narrativeGrounding: narrativePass.grounding,
    demoStrategy,
    history,
    crmContext,
    crmContextStatus,
    tasks,
  };
}
