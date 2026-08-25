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
  | "bookThis"
  | "inTheRoom"
  | "openItems"
  | "sinceLastContact"
  | "theNumbers"
  | "questions"
  | "showThis"
  | "fork"
  | "doNotDo";

export type BriefingShape = {
  /**
   * Total word budget for everything the rep reads.
   *
   * A pre-call brief is a TARGETING MECHANISM, not a research document. It tells
   * the rep where to point their attention and how to open, and it has to be
   * readable in about two minutes while a call is connecting. The first demo
   * briefing generated under the block shape ran to roughly 900 words: six
   * people at three sentences each, a ten-sentence "where it stands". Every
   * sentence was true and the artifact was still wrong, because a rep will not
   * read it.
   *
   * Enforced in lintBriefing rather than asked for in the prompt. A written
   * instruction to be brief is the first thing a model trades away when it has
   * material, which is precisely when brevity matters most.
   */
  maxWords: number;
  /** Which optional blocks this call type asks for, beyond the always-present core. */
  blocks: BlockName[];
  /** How many asks. Zero is a legitimate answer for a call where asking is not the move. */
  questionBudget: number;
  /** What this call is FOR. Stated to the model as the job, not as a description. */
  purpose: string;
};

/** Everything the briefing always emits, whatever the call type. */
export const CORE_FIELDS = ["callObjective", "whereItStands", "nextStepCommitment", "whatsAtRisk", "signalFlag"] as const;

/**
 * The shape when we could not tell what kind of call this is.
 *
 * resolvePreCallType returns "unknown" for roughly 60% of meetings: no captured
 * history on the deal and nothing in the invite title. It refuses to guess on
 * purpose, because defaulting to discovery is what put a first-discovery
 * briefing in front of Cargoservicesgroup mid-implementation.
 *
 * BUT MOST BLOCKS DO NOT NEED THE CALL TYPE. Who is in the room, what each side
 * owes, what the last email said and the numbers on the deal are useful on every
 * call, whatever kind it is. Only three things actually depend on knowing: the
 * ask budget, showThis and fork. Sending the thinnest possible briefing to the
 * majority of meetings, because one field is unresolved, throws away context we
 * already hold for no reason.
 *
 * So unknown gets every SHARED block and none of the type-specific ones, with a
 * conservative ask budget. It is the honest shape for "we have the deal, we do
 * not know the meeting".
 */
const DEFAULT_SHAPE: BriefingShape = {
  blocks: ["bookThis", "inTheRoom", "openItems", "sinceLastContact", "theNumbers", "questions", "doNotDo"],
  questionBudget: 3,
  maxWords: 620,
  purpose:
    "We could not tell what kind of call this is, so do not assume a stage. Lead with what is open and what the customer last said, ask only what is genuinely unknown, and leave with a dated commitment. Never open as though meeting for the first time unless the deal has no history at all.",
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
    blocks: ["bookThis", "inTheRoom", "openItems", "sinceLastContact", "theNumbers", "showThis", "fork", "doNotDo"],
    questionBudget: 1,
    // 540, raised twice and each time to match measured output rather than a
    // guess. First 430 -> 480 because a shape carrying showThis AND fork needs
    // more room. Then 480 -> 540 when the plain-language rule landed: writing
    // complete sentences instead of compressed fragments took Dunavant from 435
    // to 524 words, and that is the trade we chose deliberately. "Month to month
    // with CargoWise and ready to move" is shorter than "they are on a
    // month-to-month contract with CargoWise, so they can leave whenever they
    // want", and the second one is the only one a rep can read at a glance.
    // Clear beats short, so the budget pays for clear.
    maxWords: 700,
    purpose:
      "Show the two or three things this customer actually said hurt, in their order, and leave with the next step booked. They have already told us their pain: do not re-ask it. Asking discovery questions on a demo is the single most common way this briefing gets ignored.",
  },

  /**
   * Discovery. Asking IS the move, so this keeps the three-question budget, but
   * it gains the blocks every call type needs.
   *
   * theNumbers is here because of Linus Warendh: "you might sound dumb. If
   * you're like, hey, how much budget do you have? And they go, well, how much
   * do I need?" On a first call the numbers are usually theirs (volumes, users,
   * headcount) rather than ours, and having them is what makes the budget
   * question answerable rather than embarrassing.
   *
   * No showThis and no fork: there is nothing to demonstrate yet, and a fork
   * invented before you know what they want is a guess.
   */
  discovery: {
    blocks: ["bookThis", "inTheRoom", "openItems", "sinceLastContact", "theNumbers", "questions", "doNotDo"],
    questionBudget: 3,
    maxWords: 620,
    purpose:
      "Learn what actually hurts, what they run today, and who decides, then leave with a dated next step. Asking is the main move. Do not pitch.",
  },

  /**
   * Proposal. The wall.
   *
   * 39 of 77 captured deals reach SQL3 as their furthest stage and 5 reach SQL4.
   * The gates that separated the deals that advanced are all customer
   * disclosures about their own buying process: competition named, champion
   * internal action, decision process described. All three sit at 5% to 16%
   * confirmed across the book, so they are both decisive and almost never
   * asked.
   *
   * Groupe Morneau is the model: one proposal call closed twelve gates,
   * including four named competitors, the champion having already presented
   * internally, the full approval path, and legal confirmed in-house.
   *
   * fork carries the most weight here, because a proposal call is where the
   * pushback lands and where a pre-positioned answer is worth most.
   */
  proposal: {
    blocks: ["bookThis", "inTheRoom", "openItems", "sinceLastContact", "theNumbers", "questions", "fork", "doNotDo"],
    questionBudget: 2,
    // Also carries fork, and pays the same plain-language cost. See demo.
    maxWords: 680,
    purpose:
      "Get the decision machinery on the record: who else is being evaluated, what the champion has done internally, and the exact path from yes to signature. Never ask whether budget EXISTS: a number is already in front of them, so ask whether it works.",
  },

  /**
   * Follow-up. A conversation already in progress.
   *
   * The one thing that matters is what was left open, so openItems carries the
   * call and everything else is context. Never open as though meeting for the
   * first time.
   */
  follow_up: {
    blocks: ["bookThis", "openItems", "sinceLastContact", "questions", "doNotDo"],
    questionBudget: 2,
    maxWords: 520,
    purpose:
      "Pick up exactly what was left open and close it. Never re-open the relationship or re-ask what they have already told us.",
  },

  /**
   * An existing customer. NOT a qualification call.
   *
   * Account.Type says customer, so they have already bought. Asking what is
   * driving them to look at a new solution is the Cargoservicesgroup error:
   * a customer mid-implementation asked a prospect's question. Follow-through
   * on briefings for this call type measures 0%, and the reps were right.
   */
  customer: {
    blocks: ["inTheRoom", "openItems", "sinceLastContact", "doNotDo"],
    questionBudget: 1,
    maxWords: 480,
    purpose:
      "They are already a customer. Brief on making what they bought succeed and on what is unresolved operationally. Do not qualify them, do not propose a demo, and never ask what is driving them to look at a new solution.",
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
  inTheRoom: `"inTheRoom": [ { "person": string, "note": string } ]   // AT MOST 4 people, the ones who decide what happens in this room. note is up to 30 words and must carry what THEY care about, in their own words where we have them, not just a job title: their pain, what they pushed on, what they are waiting for. "CIO and signatory" is a directory entry. "CIO. Said go live as soon as possible this year, and the approval path lives with him" is useful.`,
  openItems: `"openItems": { "us": [string], "them": [string] }   // Up to 3 per side. Each line names the item, when it was agreed, and its STATUS in plain words: "sent Aug 21", "still not sent", "agreed Aug 13 for Thursday, never booked". A rep needs to know which ones are outstanding at a glance, so never leave the status off. Empty array when a side owes nothing.`,
  sinceLastContact: `"sinceLastContact": string   // ONE or TWO sentences, no more. What we last said, what they last said, how long ago. Summarise the CONTENT, never the subject line.`,
  theNumbers: `"theNumbers": [string]   // AT MOST 4, each a FRAGMENT not a sentence ("$34,400/month", "20 users"). Omit anything you do not actually have; never write "not recorded".   // every quantity this deal has: proposal amount, monthly price, user count, volumes, current spend. Empty array if none. A rep asked "how much budget do you have" who cannot answer "how much do I need" sounds unprepared.`,
  questions: `"questions": [ { "ask": string, "why": string, "targetFields": [string], "targetLabel": string } ]`,
  showThis: `"showThis": [ { "item": string, "why": string } ]   // 2 or 3, in the order THEY would care about. "why" is ONE line, at most 16 words, tied to something they said. Not a feature tour.`,
  fork: `"fork": { "question": string, "branches": [ { "ifThey": string, "then": string } ] } | null   // ONE fork, 2 or 3 branches. "ifThey" and "then" are each ONE short line. Null when there is no real fork; do not invent one.`,
  bookThis: `"bookThis": { "what": string, "when": string, "say": string } | null   // The next meeting to get ON THE CALENDAR before this call ends. "what" is the meeting (a proposal walk-through, a technical session with their IT lead). "when" is a concrete near-term window after today. "say" is the ACTUAL SENTENCE the rep says to book it, written to be read aloud, naming the meeting and proposing a specific time. Null only when a booked meeting is genuinely not the right outcome, which is rare.`,
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
