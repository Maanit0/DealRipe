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
  | "bdrHandoff"
  | "bookThis"
  | "coachThis"
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
  /**
   * The order of the three cards the rep reads: what to DO on this call, what
   * to SAY, and the background they need to KNOW.
   *
   * Every shape uses act, say, know. NOTHING overrides it, and the field is
   * kept because the override was TRIED and is worth not trying again.
   *
   * Discovery was briefly inverted to act, know, say, on the reasoning that the
   * asks are the output of what we already know so the state should come first.
   * Read as an artifact it was plainly worse: the questions, which are the whole
   * point of a discovery call and the thing the rep needs in their hand when the
   * customer joins, sat under six lines of "where it stands" and two of open
   * items. Nobody scrolls past the history to find the questions.
   *
   * The rule that came out of it: the rep ACTS from the top of the page and
   * reads DOWN for context, never the reverse. Commitment, then the words, then
   * the background. Five different skeletons would be five templates again,
   * which is the mistake this file exists to undo.
   */
  cardOrder?: ReadonlyArray<"act" | "say" | "know">;
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
  // bdrHandoff is here as well as on discovery, because the resolver returns
  // unknown for roughly 60% of meetings and a call we hold intake notes for and
  // no captured history of our own is a first conversation whatever the resolver
  // could prove. The block renders nothing when there are no notes, so the cost
  // of being wrong is zero and the cost of omitting it is Juan's call.
  blocks: ["bookThis", "coachThis", "bdrHandoff", "inTheRoom", "openItems", "sinceLastContact", "theNumbers", "questions", "doNotDo"],
  questionBudget: 3,
  // 700 -> 860 with the handoff, and the extra 60 over discovery's 800 is
  // HEADROOM RATHER THAN PERMISSION.
  //
  // This is the widest shape in the file, it covers roughly 60% of meetings,
  // and unlike discovery it can land on a deal carrying full history: the first
  // Cargosystems run under the new block came in at 766 and only after one
  // regeneration for length. Two failures suppress a briefing entirely, so a
  // budget set at the measured ceiling does not fail safe here, it fails to
  // send. The rep who lost the briefing would be the one this whole change was
  // for.
  maxWords: 860,
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
    // "questions" was missing here while questionBudget said 1, so the prompt was
    // told it could ask one question and given no field to put it in. The Impexx
    // briefing wrote "there is one question below. Ask it" above a page with no
    // questions block on it. A budget and a block list that disagree produce a
    // briefing that points at something that is not there.
    blocks: ["bookThis", "coachThis", "inTheRoom", "openItems", "sinceLastContact", "theNumbers", "showThis", "questions", "fork", "doNotDo"],
    questionBudget: 1,
    // Raised three times, each time to match measured output rather than a
    // guess. 430 -> 480 because a shape carrying showThis AND fork needs more
    // room. 480 -> 540 when the plain-language rule landed: "month to month
    // with CargoWise and ready to move" is shorter than "they are on a
    // month-to-month contract with CargoWise, so they can leave whenever they
    // want", and only the second is readable at a glance, so the budget pays
    // for clear. 700 -> 780 for the labels: a two-word label on a line of
    // "where it stands" and a four-word label on a figure are the difference
    // between a block a rep scans and a block a rep skips, so they earn their
    // words several times over. Every raise so far has bought structure or
    // clarity. A raise that buys another true sentence is the one to refuse.
    maxWords: 780,
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
    // bdrHandoff sits at the front of the KNOW card and only on this shape and
    // unknown. Juan Lopez asked for it by naming what a briefing without it
    // costs him: "if I don't have Salesforce on me for any reason, or the BDR
    // can't join the call, they can't hand it off." He also drew the boundary
    // himself when asked whether he wanted it on demo and proposal calls too,
    // and said no. By then the customer has told US, and the intake note is
    // history.
    blocks: ["bookThis", "coachThis", "bdrHandoff", "inTheRoom", "openItems", "sinceLastContact", "theNumbers", "questions", "doNotDo"],
    questionBudget: 3,
    // 700 -> 800 for the handoff block. It is the one raise on this shape that
    // buys the rep something they cannot get anywhere else on a first call:
    // every other block is assembled from OUR history, and on a discovery call
    // we have none.
    maxWords: 800,
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
    blocks: ["bookThis", "coachThis", "inTheRoom", "openItems", "sinceLastContact", "theNumbers", "questions", "fork", "doNotDo"],
    questionBudget: 2,
    // Also carries fork, and pays the same plain-language cost. See demo.
    maxWords: 740,
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
    blocks: ["bookThis", "coachThis", "openItems", "sinceLastContact", "questions", "doNotDo"],
    questionBudget: 2,
    maxWords: 580,
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
    blocks: ["coachThis", "inTheRoom", "openItems", "sinceLastContact", "doNotDo"],
    questionBudget: 1,
    maxWords: 520,
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
  bdrHandoff: `"bdrHandoff": { "lines": [ { "label": string, "point": string } ], "asOf": string | null } | null   // WHAT THE BDR ALREADY LEARNED, taken ONLY from the "Recorded by the BDR before this call" block and from nowhere else. Null when that block is absent or says the Sales Development section is empty. NEVER infer it, never carry a point over from our own calls, and never write it from the framework. 2 to 5 lines, most consequential first. "label" is two or three words naming what the line is ABOUT ("What hurts", "What they run today", "Why now", "Who decides", "Go-live"). "point" is ONE sentence in the CUSTOMER's own words where the field holds them, quoted, and in plain words where it does not. Keep their phrasing: it is the only unmediated thing on the page. Do NOT restate a Magaya field name, do not write "Budget Confirmed: true"; write what that means for this call. "asOf" is the date the BDR recorded it if the block gives one, else null. This is a HANDOFF, not analysis: the rep is reading it because Salesforce is not open in front of them.`,
  inTheRoom: `"inTheRoom": [ { "person": string, "note": string } ]   // AT MOST 3 people, the ones who decide what happens in this room. "person" is the NAME ONLY, exactly as it appears in the attendee list: their job title is already printed beside it and repeating it wastes the line. "note" is up to 30 words and carries what THEY care about, in their own words where we have them: their pain, what they pushed on, what they are waiting for. "CIO and signatory" is a directory entry. "Said go live as soon as possible this year, and the approval path lives with him" is useful.`,
  openItems: `"openItems": { "us": [string], "them": [string] }   // Up to 3 per side. Each line names the item, when it was agreed, and its STATUS in plain words: "sent Aug 21", "still not sent", "agreed Aug 13 for Thursday, never booked". A rep needs to know which ones are outstanding at a glance, so never leave the status off. Empty array when a side owes nothing.`,
  sinceLastContact: `"sinceLastContact": string   // ONE or TWO sentences, no more. What we last said, what they last said, how long ago. Summarise the CONTENT, never the subject line.`,
  theNumbers: `"theNumbers": [ { "label": string, "value": string, "note": string | null } ]   // AT MOST 4 figures: what we quoted, what they pay today, user or seat counts, volumes, contract terms. Empty array if we hold none. NEVER a bare number. "label" says what the figure IS and WHOSE it is, in two to four words: "What we quoted, monthly", "Their CargoWise spend today", "Users in scope". A rep who reads "$34,400 per month" without knowing which side of the table it sits on will say it out loud and be wrong. "value" is the figure alone. "note" is where it came from and when, one short clause, for example "quoted August 14, Debra said it is within her range", or null when we do not know.`,
  questions: `"questions": [ { "ask": string, "why": string, "targetFields": [string], "targetLabel": string } ]`,
  showThis: `"showThis": [ { "item": string, "why": string } ]   // 2 or 3, in the order THEY would care about. "why" is ONE line, at most 16 words, tied to something they said. Not a feature tour.`,
  fork: `"fork": { "question": string, "branches": [ { "ifThey": string, "then": string } ] } | null   // ONE fork, 2 or 3 branches. "ifThey" and "then" are each ONE short line. Null when there is no real fork; do not invent one.`,
  coachThis: `"coachThis": { "lastTime": string, "thisTime": string } | null   // ONLY from the COACHING FROM PRIOR CALLS block, never invented and never inferred from anywhere else. "lastTime" is ONE sentence saying what was asked for and what happened, stated as a fact about the deal and NEVER as a judgement about the rep: "the last briefing asked for the signing path and the transcript has no one raising it" is a fact, "you failed to ask" is a scolding. "thisTime" is ONE sentence naming the specific move that closes it today. Null whenever that block is absent or carries nothing that bears on this call.`,
  bookThis: `"bookThis": { "what": string, "when": string, "say": string } | null   // The next meeting to get ON THE CALENDAR before this call ends. "what" is the meeting (a proposal walk-through, a technical session with their IT lead). "when" is a concrete near-term window after today. "say" is the ACTUAL SENTENCE the rep says to book it, written to be read aloud, naming the meeting and proposing a specific time. Null only when a booked meeting is genuinely not the right outcome, which is rare.`,
  doNotDo: `"doNotDo": string   // one line. The thing that would waste this call or damage it.`,
};

export function contractFor(shape: BriefingShape): string {
  // WHERE IT STANDS AND THE HANDOFF COMPETE FOR THE SAME FACTS.
  //
  // On a first discovery call whereItStands has no history of ours to draw on,
  // so given the BDR block it fills itself from the BDR block. The first
  // Coordinadora briefing generated under this shape said their in-house system
  // supports one customer, what they need built, and their January go-live
  // date, twice, in two sections a few lines apart. Both were accurate, and the
  // page still read as padded, which on an artifact whose whole budget is two
  // minutes of a rep's attention is a real cost.
  //
  // Told to the model as a division of labour rather than a prohibition. "Do
  // not repeat" makes a model drop the fact from both blocks; naming what each
  // block is FOR keeps it in the right one.
  const handoffSplit = shape.blocks.includes("bdrHandoff")
    ? ` THIS SHAPE ALSO CARRIES "bdrHandoff", AND THE TWO BLOCKS MUST NOT OVERLAP. The handoff already carries their pain, their requirements, their current software, their go-live date and their budget or sponsorship position. So "whereItStands" MAY NOT CONTAIN A LINE ABOUT ANY OF THOSE. It is banned from restating them in other words, from summarising them, and from labelling them differently ("Core pain", "Scope", "What they need" and "Go-live target" are all forbidden here when the handoff exists). It covers ONLY what is true about the DEAL and not about the customer: whether we have ever spoken to them, what we owe and when, what has not been verified, what is missing that we would need, and what the timeline demands of US. If that leaves fewer than 3 lines, RETURN FEWER LINES. Two true lines the handoff did not already say beat five that restate it.`
    : "";
  const core = [
    `  "callObjective": string,`,
    // LABELLED LINES, NEVER A PARAGRAPH.
    //
    // This is the densest block in the brief. Six sentences of prose is a wall,
    // and a rep scanning for the money finds it only by reading the timeline
    // first. The facts were never joined by anything except being true, so they
    // are separated here and each one is told what it is about.
    `  "whereItStands": [ { "label": string, "point": string } ],   // 3 to 6 lines, ordered most consequential first. "point" is ONE complete sentence, said the way you would say it to a colleague. "label" is two or three words naming what the line is ABOUT, for example "The money", "Timeline", "Where the NDA got to", "Not captured". Never repeat a label.${handoffSplit}`,
    `  "nextStepCommitment": string,`,
    `  "whatsAtRisk": string,`,
    `  "signalFlag": string | null`,
  ];
  const extra = shape.blocks.map((b) => `  ${BLOCK_CONTRACT[b]}`);
  return [`{`, ...core.map((l) => `${l}`), ...extra, `}`].join("\n");
}
