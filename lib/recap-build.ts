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
import { getDealContext } from "./deal-context";
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
      /** Generated, NOT persisted. The caller decides whether to write them. */
      tasks: GeneratedTask[];
    }
  | {
      kind: "general";
      reason: string;
      account: string;
      meetingType: MeetingType;
      recap: GeneralRecap;
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
  meetingType?: MeetingType;
  /**
   * Skip task generation. The preview leaves this off so it shows the full
   * artifact; a caller that will not persist them can turn it off to save an
   * Anthropic call.
   */
  withTasks?: boolean;
};

export async function buildRecap(input: BuildRecapInput): Promise<RecapBuild> {
  // Classify the meeting. DealRipe auto-joins every invited meeting, so not
  // every call is a new-opportunity sales call. A customer or internal meeting
  // gets a plain takeaways + next-steps recap instead of the qualification one
  // (which would be the wrong shape and read as noise, per Eduardo's feedback).
  const meetingType = input.meetingType ?? (await classifyMeetingType(input.transcript));

  if (meetingType !== "new_opportunity") {
    const general = await generateGeneralRecap({
      account: input.account,
      transcript: input.transcript,
    });
    if (general) {
      return {
        kind: "general",
        reason: `meeting classified as ${meetingType}, so the qualification audit does not apply`,
        account: input.account,
        meetingType,
        recap: general,
      };
    }
    // Deliberate fall-through, preserved from the original. A failed general
    // recap is not a reason to send nothing, and the qualification recap is
    // still grounded in the same transcript.
  }

  // "Still open" reflects the deal's cumulative call-verified state (the
  // field_extractions roll-up, which already includes this call by the time
  // this runs), not just what this one call covered, and never a stale CRM
  // entry. Best-effort.
  let gapExtraction = input.extraction;
  try {
    gapExtraction = (await getDealExtraction(input.dealId)) as unknown as ExtractionMap;
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
  let stageKey = input.fallbackStageKey;
  try {
    const ctx = await getDealContext(input.tenantId, input.dealId);
    if (ctx) stageKey = ctx.effectiveStageKey;
  } catch (err) {
    console.warn(
      `[recap-build] deal context read failed for deal ${input.dealId}: ${
        err instanceof Error ? err.message : String(err)
      }; using the deal's stored stage`,
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
  const [summary, narrativePass] = await Promise.all([
    generatePostCallSummary({
      account: input.account,
      stageKey,
      closeDate: input.closeDate ?? undefined,
      framework: input.framework,
      extraction: input.extraction,
      gapExtraction,
      transcript: input.transcript,
    }),
    buildNarrative({ account: input.account, transcript: input.transcript }).catch((err) => ({
      result: {
        status: "unavailable" as const,
        reason: `the narrative pass threw: ${err instanceof Error ? err.message : String(err)}`,
      },
      grounding: { droppedFacts: 0, droppedNumbers: 0, examples: [] },
    })),
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
    tasks,
  };
}
