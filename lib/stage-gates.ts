/**
 * The rep's checklist, and what it is worth.
 *
 * Rolldog carries 31 stage-requirement items per opportunity, ticked by hand by
 * the rep who owns the deal. We were reading none of them, so every briefing
 * said "0/27 gates confirmed" for deals where the rep had three full stages
 * ticked. That number was true about our database and false about the deal, and
 * a rep reading it concludes the product has not been paying attention.
 *
 * But a tick is not evidence. It is a claim, entered by the person whose
 * forecast depends on it, which is the whole reason Mark wants a call-derived
 * view in the first place. So we keep the two apart and never let one overwrite
 * the other:
 *
 *   confirmed   the customer said it on a call we heard. Evidence.
 *   claimed     the rep ticked it in Rolldog. Real information, unverified.
 *   open        neither.
 *
 * The interesting cell is claimed-but-not-confirmed. On a healthy deal it is
 * just work we did not witness. Concentrated at a late stage on a deal about to
 * close, it is precisely what a CRO wants flagged before the forecast call.
 */

import type { ExtractionMap } from "./briefing-magaya";
import { runWithAuthorizedOpportunities } from "./crm-scope";
import { getStageRequirements, type RolldogStageRequirements } from "./rolldog";

export type GateState = "confirmed" | "claimed" | "open";

/**
 * What a false actually means on this item.
 *
 * Most items are tasks: true is done, false is not done yet. Four are questions
 * ("Is Magaya Selected Vendor?", "Is Legal Internal?", "Executive Involvement
 * Needed?", "Agreement on Signature"), and on those false is an ANSWER OF NO,
 * not an unfinished step. The distinction is load-bearing in both directions.
 * GHY carries "Is Magaya Selected Vendor?" false, which does not mean nobody has
 * got round to it: it means the rep has recorded that we are not the chosen
 * vendor, which at SQL3 is the most important fact about the deal. Mark's own
 * screen showed exactly that, rendered as "Magaya is not the Selected Vendor"
 * under Solution, next to an area-of-concern flag.
 *
 * Rolldog signals this with no_score, which strictly means the item does not
 * feed the opportunity score. The correlation with question-shaped items is
 * exact across the four, but it is a correlation, so it is used only where a
 * wrong reading is harmless: to withhold a stage inference and to raise a flag
 * a human will check, never to mark a gate satisfied.
 */
export type GateKind = "task" | "question";

export type StageGate = {
  /** Rolldog's stable definition id. The only safe join key. */
  rolldogId: number;
  name: string;
  /** SQL0..SQL5, derived from position, not from parsing the stage name. */
  stageKey: string;
  ticked: boolean;
  kind: GateKind;
  /** Our framework field, where one corresponds. Null for internal-action gates. */
  fieldKey: string | null;
  state: GateState;
};

export type StageGateSummary = {
  gates: StageGate[];
  /** Stage Rolldog says the deal is in, from current-stage-position. */
  crmStageKey: string | null;
  tickedCount: number;
  confirmedCount: number;
  total: number;
  /** Ticked by the rep with no call evidence behind it. The signal Mark wants. */
  claimedNotConfirmed: StageGate[];
  /** Question-type items answered NO. Not pending work: a recorded negative. */
  negativeAnswers: StageGate[];
};

/**
 * Position to stage key.
 *
 * Deliberately positional rather than parsed from the name: the second stage is
 * called "SQL - Develop Opportunity (Qualify)" with no digit at all, so any
 * regex over the name silently misfiles every SQL1 gate. Position 1 is SQL0.
 */
function stageKeyForPosition(position: number): string {
  const n = Math.max(0, position - 1);
  return `SQL${n}`;
}

/**
 * Rolldog definition id to our framework field key.
 *
 * Joined on the numeric id, never the name: the live payload contains
 * " Create Initial Close Plan and Presented" with a leading space and "Validate
 * Who Negotiate and Signs" with a grammatical error, and both would break a
 * string match the first time someone tidies them.
 *
 * Only call-detectable gates map. The rest are internal actions (a meeting
 * happened, a document was sent, a signature was collected) that no transcript
 * can evidence and that Rolldog is the rightful source for. Mapping those would
 * mean marking a gate unconfirmed forever because a call can never confirm it.
 *
 * Ids observed on opportunity 65462. They are template-level and shared across
 * opportunities; verify-stage-gates.ts checks that assumption on real deals.
 */
export const ROLLDOG_GATE_TO_FIELD: Readonly<Record<number, string>> = Object.freeze({
  398: "sql1_storyboard_positioned", // Positioned Storyboard
  401: "sql1_close_plan_presented", // Create Initial Close Plan and Presented
  402: "sql2_site_visit", // Site Visit
  404: "sql2_demo_completed", // Product Demonstration
  408: "sql2_proposal_delivered", // Create/Deliver Proposal
  396: "sql3_legal_internal", // Is Legal Internal?
  409: "sql3_selected_vendor", // Is Magaya Selected Vendor?
  413: "sql3_final_proposal", // Prepare/Submit Final Proposal
});

/** Internal-action gates: real work, but nothing a customer call can evidence. */
export function isCallDetectable(rolldogId: number): boolean {
  return rolldogId in ROLLDOG_GATE_TO_FIELD;
}

export function summarizeStageGates(
  raw: RolldogStageRequirements,
  extraction: ExtractionMap,
): StageGateSummary {
  const gates: StageGate[] = [];

  for (const stage of raw.stages) {
    const stageKey = stageKeyForPosition(stage.position);
    for (const item of stage.attributes) {
      const fieldKey = ROLLDOG_GATE_TO_FIELD[item.id] ?? null;
      const confirmed = fieldKey ? extraction[fieldKey]?.status === "Yes" : false;
      gates.push({
        rolldogId: item.id,
        name: item.name,
        stageKey,
        ticked: item.value,
        kind: item.no_score === false ? "question" : "task",
        fieldKey,
        state: confirmed ? "confirmed" : item.value ? "claimed" : "open",
      });
    }
  }

  // Rolldog does not always carry current-stage-position: opportunity 70908 (TW
  // Customs) returns it null. Falling back to "no stage" meant that deal briefed
  // at SQL0 as a first discovery call while the rep had "Is Magaya Selected
  // Vendor?" ticked, which is about as wrong as a briefing can be. The ticks
  // themselves establish a floor: a deal cannot be earlier than the latest stage
  // it has ticked work in.
  // Only completed TASKS establish a floor. A question answered yes is not
  // evidence the deal reached that stage: "Is Legal Internal?" can be answered
  // on any call, and letting it push a deal to SQL4 would brief a discovery
  // conversation as a signature conversation.
  const tickedTasks = gates.filter((g) => g.ticked && g.kind === "task");
  const inferredFloor = tickedTasks.length
    ? tickedTasks
        .map((g) => Number(g.stageKey.replace("SQL", "")))
        .reduce((a, b) => Math.max(a, b), 0)
    : null;

  return {
    gates,
    crmStageKey:
      raw.currentStagePosition !== null
        ? stageKeyForPosition(raw.currentStagePosition)
        : inferredFloor !== null
          ? `SQL${inferredFloor}`
          : null,
    tickedCount: gates.filter((g) => g.ticked).length,
    confirmedCount: gates.filter((g) => g.state === "confirmed").length,
    total: gates.length,
    // Only call-detectable gates can be "claimed but unconfirmed" in any
    // meaningful sense. Flagging "Agreement Signed by Company" as unverified
    // because no transcript mentions it would be noise, and noise in this
    // column is what makes a CRO stop reading the column.
    claimedNotConfirmed: gates.filter((g) => g.state === "claimed" && g.fieldKey !== null),
    negativeAnswers: gates.filter((g) => g.kind === "question" && !g.ticked),
  };
}

/**
 * Read and summarize a deal's checklist. Best-effort at the call site, but note
 * that null here means "could not read", not "no gates": callers must not render
 * an unreadable checklist as an empty one.
 */
export async function getStageGateSummary(
  opportunityId: string,
  extraction: ExtractionMap,
): Promise<StageGateSummary | null> {
  const raw = await runWithAuthorizedOpportunities([opportunityId], () =>
    getStageRequirements(opportunityId),
  );
  return raw ? summarizeStageGates(raw, extraction) : null;
}

/**
 * Ticks that change what kind of call this is, and what each one means.
 *
 * Most of the checklist is texture. A few items are decisive: if Magaya is the
 * selected vendor, the customer has chosen us and nothing about that call is
 * discovery. TW Customs had exactly that ticked and was still being briefed to
 * ask what software they use today, because the checklist reached the prompt as
 * an undifferentiated list and the model weighted it like any other line.
 */
const DECISIVE_GATES: Readonly<Record<number, string>> = Object.freeze({
  409: "The customer has SELECTED MAGAYA. This is not a competitive evaluation and nothing here is discovery. Brief for execution: paperwork, timeline, rollout.",
  404: "A product demonstration has already been given. Never propose a demo or ask what they want to see.",
  408: "A proposal has been delivered. A number is in front of them, so budget is a reaction to that number, never a question of whether budget exists.",
  406: "A preliminary estimate has been shared, so they have seen pricing.",
  420: "The agreement is signed. This is a customer, not a prospect.",
  424: "Their license is confirmed and they are live or going live.",
  402: "A site visit has happened.",
});

/** The checklist block for the briefing prompt. Null when there is nothing useful. */
/**
 * A recorded "no" on a question item, and what it means for the call.
 *
 * These matter more than the ticks. A rep who has recorded that Magaya is not
 * the selected vendor on a deal sitting at Proposal Validation has written down
 * the single most important fact about it, and a briefing that walks past that
 * to ask about implementation timelines is worse than useless.
 */
const NEGATIVE_ANSWERS: Readonly<Record<number, string>> = Object.freeze({
  409: "The rep has recorded that MAGAYA IS NOT THE SELECTED VENDOR. Someone else is ahead, or the choice is open. Do not brief this as a won deal, and do not talk about implementation. The job is to find out who is ahead and why.",
  396: "Legal review is NOT internal, so outside counsel is involved. Expect a longer signature path and ask about their timeline.",
});

export function stageGateLines(summary: StageGateSummary): string | null {
  const ticked = summary.gates.filter((g) => g.ticked);
  const openAtOrBelow = summary.gates.filter((g) => !g.ticked && g.kind === "task");

  // A negative answer is worth briefing on even when nothing is ticked, so this
  // check comes before the early return.
  const negatives = summary.negativeAnswers
    .map((g) => NEGATIVE_ANSWERS[g.rolldogId])
    .filter((v): v is string => Boolean(v));

  if (ticked.length === 0 && negatives.length === 0) return null;

  const byStage = (list: StageGate[]): string =>
    list.map((g) => `- [${g.stageKey}] ${g.name}`).join("\n");

  const parts: string[] = [];

  // Decisive ticks go first and carry their consequence with them, so the model
  // cannot read past them. Buried in a list they were being ignored.
  const decisive = ticked
    .map((g) => DECISIVE_GATES[g.rolldogId])
    .filter((v): v is string => Boolean(v));
  if (decisive.length > 0 || negatives.length > 0) {
    parts.push(
      `THIS CHANGES THE CALL:`,
      ...negatives.map((d) => `- ${d}`),
      ...decisive.map((d) => `- ${d}`),
      ``,
    );
  }

  if (ticked.length > 0) {
    parts.push(
      `The rep has ticked ${summary.tickedCount} of ${summary.total} items on this deal's checklist in the CRM:`,
      byStage(ticked),
    );
  }

  if (openAtOrBelow.length > 0) {
    parts.push(
      ``,
      `Still open on the checklist:`,
      byStage(openAtOrBelow.slice(0, 12)),
    );
  }

  return parts.join("\n");
}
