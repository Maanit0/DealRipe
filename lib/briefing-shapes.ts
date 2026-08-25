/**
 * What a briefing IS, per call type.
 *
 * THE FIXED OUTPUT SCHEMA WAS THE TEMPLATE.
 *
 * Until now every briefing, for every call type, had to produce exactly
 * {callObjective, whereItStands, questions[], nextStepCommitment, whatsAtRisk,
 * signalFlag} and rule 5 of the system prompt hardcoded "only three" questions.
 * So no matter how much context arrived, the model had to compress all of it
 * into three questions. That is why it read like a checklist: the schema forced
 * it, not the prompt and not the context.
 *
 * Steven Johnson, 2026-08-24, unprompted: "I find it nice to have a recap after
 * the Discovery Call. After that, not as useful." Eduardo Bencomo, 2026-08-14,
 * about the same shape: "this does not allow me to prepare for a demo, this is
 * pretty much an overview... it's very tied to the checks that we have."
 * Neither was describing bad content. Both were describing one shape that did
 * not fit their moment.
 *
 * SO THE SHAPE VARIES AND THE SKELETON DOES NOT.
 *
 * Same sections in the same order every time, so a rep learns to read it once.
 * What changes is WHICH sections appear and how much mass each carries. A
 * discovery call is mostly asks. A demo is mostly what to show and almost no
 * asks, because asking discovery questions on a demo is exactly what Steven was
 * complaining about. Five different skeletons would be five templates again.
 *
 * DEFAULTS ARE DELIBERATELY IDENTICAL TO TODAY. Only the call types listed here
 * with a custom shape behave differently, so this ships without changing what
 * five of the six reps receive until each shape has been proven on real calls.
 */

export type BlockName =
  | "inTheRoom"
  | "openItems"
  | "sinceLastContact"
  | "theNumbers"
  | "questions"
  | "showThis"
  | "fork"
  | "doNotDo";

export type BriefingShape = {
  /** Which optional blocks this call type asks for, beyond the always-present core. */
  blocks: BlockName[];
  /** How many asks. Zero is a legitimate answer for a call where asking is not the move. */
  questionBudget: number;
  /** What this call is FOR. Stated to the model as the job, not as a description. */
  purpose: string;
};

/** Everything the briefing always emits, whatever the call type. */
export const CORE_FIELDS = ["callObjective", "whereItStands", "nextStepCommitment", "whatsAtRisk", "signalFlag"] as const;

const DEFAULT_SHAPE: BriefingShape = {
  // Byte-identical to the pre-2026-08-25 behaviour on purpose. See the header.
  blocks: ["questions"],
  questionBudget: 3,
  purpose:
    "Learn what you do not know yet and leave with a dated commitment. Asking is the main move on this call.",
};

const SHAPES: Record<string, BriefingShape> = {
  /**
   * A demo is not a discovery call and must not be briefed as one.
   *
   * Measured follow-through on briefings by call type: 25% on discovery, 8% on
   * proposal, 0% on demo. A rep ignoring a discovery briefing before a demo is
   * behaving correctly, so the fix belongs here rather than in a nudge.
   *
   * The customer has already told us their pain. The job is to show the part of
   * the product that answers it, in their order, and to leave with the next
   * step. One ask at most, and only if something genuinely unknown blocks the
   * next step.
   */
  demo: {
    blocks: ["inTheRoom", "openItems", "sinceLastContact", "theNumbers", "showThis", "fork", "doNotDo"],
    questionBudget: 1,
    purpose:
      "Show the two or three things this customer actually said hurt, in their order, and leave with the next step booked. They have already told us their pain: do not re-ask it. Asking discovery questions on a demo is the single most common way this briefing gets ignored.",
  },
};

export function shapeForCallType(callType: string | null | undefined): BriefingShape {
  const key = String(callType ?? "").toLowerCase().trim();
  return SHAPES[key] ?? DEFAULT_SHAPE;
}

/**
 * The JSON contract for one shape.
 *
 * Built from the shape rather than written once, so a block that was not asked
 * for cannot be returned, and a block that WAS asked for cannot be quietly
 * dropped. The alternative, one fixed contract plus prose telling the model
 * which parts to skip, is how the current schema became a template.
 */
const BLOCK_CONTRACT: Record<BlockName, string> = {
  inTheRoom: `"inTheRoom": [ { "person": string, "note": string } ]   // ONE short line each, customer side first. note = their role and the one thing they care about, from the calls. Invite status only when it matters.`,
  openItems: `"openItems": { "us": [string], "them": [string] }   // what each side owes from last time, and whether it happened. Split the agreed next step by who owes it. Empty array when a side owes nothing.`,
  sinceLastContact: `"sinceLastContact": string   // one or two sentences: what we last said, what they last said, and how long ago. Summarise the CONTENT, never the subject line.`,
  theNumbers: `"theNumbers": [string]   // every quantity this deal has: proposal amount, monthly price, user count, volumes, current spend. Empty array if none. A rep asked "how much budget do you have" who cannot answer "how much do I need" sounds unprepared.`,
  questions: `"questions": [ { "ask": string, "why": string, "targetFields": [string], "targetLabel": string } ]`,
  showThis: `"showThis": [ { "item": string, "why": string } ]   // what to demonstrate, in the order THEY would care about, each tied to something they said. Two or three, not a feature tour.`,
  fork: `"fork": { "question": string, "branches": [ { "ifThey": string, "then": string } ] } | null   // ONE likely fork in the conversation, pre-positioned. Two or three branches. Null when there is no real fork; do not invent one.`,
  doNotDo: `"doNotDo": string   // one line. The thing that would waste this call or damage it.`,
};

export function contractFor(shape: BriefingShape): string {
  const core = [
    `  "callObjective": string,`,
    `  "whereItStands": string,`,
    `  "nextStepCommitment": string,`,
    `  "whatsAtRisk": string,`,
    `  "signalFlag": string | null`,
  ];
  const extra = shape.blocks.map((b) => `  ${BLOCK_CONTRACT[b]}`);
  return [`{`, ...core.map((l) => `${l}`), ...extra, `}`].join("\n");
}
