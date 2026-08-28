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
  /**
   * NOTE ON CAPS, 2026-08-28. The per-block "at most N" limits are gone and this
   * budget is now the only governor.
   *
   * They were belt-and-braces on top of it and they were costing real content:
   * with 14 populated Sales Development fields and a five-line ceiling, the BDR
   * block dropped Compelling Events, Budget Confirmed and Executive Sponsorship,
   * which is precisely the pre-qualification data the block was built to carry.
   * A cap cannot tell a fact the rep needs from one they do not, so it drops
   * whatever the model ranked last, and short unglamorous fields rank last next
   * to narrative ones.
   *
   * Relevance is the rule everywhere now; length is governed here, in one place,
   * where a briefing that runs long is caught and regenerated rather than
   * silently trimmed. The maxima below were raised to match, so a deal with a
   * full record cannot fail the length check twice and be suppressed.
   */
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
  /**
   * Whether to print the BDR's Sales Development record on this call type.
   *
   * A plain flag rather than a BlockName, because this block is RENDERED from
   * Salesforce and never asked of the model, so it has no entry in the contract
   * and does not belong in the list that builds one.
   *
   * Juan Lopez drew this line himself when asked whether he wanted the intake
   * record on demo and proposal calls too, and said no: by then the customer has
   * told US, our own calls carry it, and twenty fields of a colleague's intake
   * notes is page a rep has to scroll past. It is on for discovery and for
   * unknown, since a call we hold intake notes for and no captured history of
   * our own is a first conversation whatever the resolver could prove.
   */
  bdrRecord?: boolean;
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
  blocks: ["bookThis", "coachThis", "inTheRoom", "openItems", "sinceLastContact", "theNumbers", "questions", "doNotDo"],
  questionBudget: 3,
  bdrRecord: true,
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
  maxWords: 1000,
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
    blocks: ["bookThis", "coachThis", "inTheRoom", "openItems", "sinceLastContact", "theNumbers", "questions", "doNotDo"],
    questionBudget: 3,
    bdrRecord: true,
    // 700 -> 800 for the handoff block. It is the one raise on this shape that
    // buys the rep something they cannot get anywhere else on a first call:
    // every other block is assembled from OUR history, and on a discovery call
    // we have none.
    maxWords: 950,
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
  inTheRoom: `"inTheRoom": [ { "person": string, "points": [string] } ]   // The people who decide what happens in this room. No fixed limit on people, but this is not an attendee list: someone who has never appeared on a captured call and carries nothing to say about them belongs here only if their presence is itself the news. "person" is the NAME ONLY, exactly as it appears in the attendee list, because their job title is already printed beside it. "points" is 1 to 4 SEPARATE bullets about THAT person, each a complete sentence and each a DIFFERENT kind of thing: what they said hurts, in their own words where we have them; what they pushed back on; what they are waiting for; what they own in the decision. Do not pack several facts into one bullet and do not split one fact across two. "CIO and signatory" is a directory entry and belongs in none of them. "Said go live as soon as possible this year" and "The approval path lives with him" are two bullets because they are two facts. A person we know nothing about gets ONE bullet saying what to find out about them.`,
  openItems: `"openItems": { "us": [string], "them": [string] }   // Every item still outstanding on each side, not a sample of them. No fixed limit: an unclosed commitment that got trimmed to fit is the exact thing this block exists to prevent. Each line names the item, when it was agreed, and its STATUS in plain words: "sent Aug 21", "still not sent", "agreed Aug 13 for Thursday, never booked". A rep needs to know which ones are outstanding at a glance, so never leave the status off. Empty array when a side owes nothing.`,
  sinceLastContact: `"sinceLastContact": string   // ONE or TWO sentences, no more. What we last said, what they last said, how long ago. Summarise the CONTENT, never the subject line.`,
  theNumbers: `"theNumbers": [ { "label": string, "value": string, "note": string | null } ]   // Every figure we actually hold that bears on this call: what we quoted, what they pay today, user or seat counts, volumes, contract terms. No fixed limit, because a number the rep needs and does not have is worse than a longer list; drop a figure only when it bears on nothing. Empty array if we hold none. NEVER a bare number. "label" says what the figure IS and WHOSE it is, in two to four words: "What we quoted, monthly", "Their CargoWise spend today", "Users in scope". A rep who reads "$34,400 per month" without knowing which side of the table it sits on will say it out loud and be wrong. "value" is the figure alone. "note" is where it came from and when, one short clause, for example "quoted August 14, Debra said it is within her range", or null when we do not know.`,
  questions: `"questions": [ { "ask": string, "why": string, "targetFields": [string], "targetLabel": string } ]`,
  showThis: `"showThis": [ { "item": string, "why": string } ]   // 2 or 3, in the order THEY would care about. "why" is ONE line, at most 16 words, tied to something they said. Not a feature tour.`,
  fork: `"fork": { "question": string, "branches": [ { "ifThey": string, "then": string } ] } | null   // ONE fork, 2 or 3 branches. "ifThey" and "then" are each ONE short line. Null when there is no real fork; do not invent one.`,
  coachThis: `"coachThis": { "lastTime": string, "thisTime": string } | null   // ONLY from the COACHING FROM PRIOR CALLS block, never invented and never inferred from anywhere else. "lastTime" is ONE sentence saying what was asked for and what happened, stated as a fact about the deal and NEVER as a judgement about the rep: "the last briefing asked for the signing path and the transcript has no one raising it" is a fact, "you failed to ask" is a scolding. "thisTime" is ONE sentence naming the specific move that closes it today. Null whenever that block is absent or carries nothing that bears on this call.`,
  bookThis: `"bookThis": { "what": string, "when": string, "say": string } | null   // The next meeting to get ON THE CALENDAR before this call ends. "what" is the meeting (a proposal walk-through, a technical session with their IT lead). "when" is a concrete near-term window after today. "say" is the ACTUAL SENTENCE the rep says to book it, written to be read aloud, naming the meeting and proposing a specific time. Null only when a booked meeting is genuinely not the right outcome, which is rare.`,
  doNotDo: `"doNotDo": string   // one line. The thing that would waste this call or damage it.`,
};

/**
 * Drop "where it stands" lines that belong to another block on the page.
 *
 * ENFORCED, NOT INSTRUCTED, and only after instructing failed three times. The
 * prompt names the blocks that own each subject and lists the forbidden labels
 * verbatim; the Orvia briefing answered "What we owe" with "What we owe them",
 * three lines under an Open items block that already listed all three items with
 * their dates. A model asked not to say something says it under a new name,
 * because the fact is genuinely relevant and it has been given a block with no
 * other source to fill from.
 *
 * So the instruction stays, since it shapes what gets written, and this catches
 * what survives it. Matching is on the LABEL only: the label is the model's own
 * statement of what a line is about, which makes it the honest thing to test,
 * and testing the sentence would start dropping true lines for sharing a word.
 */
const LABEL_OWNED_ELSEWHERE: Array<{ block: BlockName; pattern: RegExp }> = [
  { block: "openItems", pattern: /\b(we|they|us|them)\s+owe|owed|outstanding|not\s+(yet\s+)?(sent|delivered|returned)|waiting\s+on|questionnaire|still\s+open\b/i },
  { block: "bookThis", pattern: /\bnot\s+booked|nothing\s+(is\s+)?on\s+the\s+calendar|no\s+(next\s+)?meeting\b/i },
  { block: "theNumbers", pattern: /^(the\s+)?(money|numbers|pricing|price|amount|revenue|users?)$/i },
];

export function stripOwnedLines<T extends { label?: string | null }>(
  lines: ReadonlyArray<T>,
  shape: BriefingShape,
): T[] {
  return lines.filter((l) => {
    const label = String(l?.label ?? "").trim();
    if (!label) return true;
    return !LABEL_OWNED_ELSEWHERE.some((r) => shape.blocks.includes(r.block) && r.pattern.test(label));
  });
}

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
  // WHERE IT STANDS RESTATES THE REST OF THE PAGE UNLESS IT IS STOPPED.
  //
  // It is the only block with no single source, so it fills itself from whatever
  // else is available, and everything else on the page is available. The
  // Cargosystems briefing printed "What we owe" three lines below an Open Items
  // block that already listed all three things we owe, put James Wilson in it
  // when he already had his own entry in the room, and restated the Auckland
  // visit that "Book this" was about. Every line was true and the reader had
  // read all of it already.
  //
  // Named as a division of labour rather than a ban, because "do not repeat"
  // makes a model drop the fact from both places. Its job is the CONSEQUENCE:
  // what the facts elsewhere on the page add up to for this call.
  const owned: string[] = [];
  // Naming the forbidden LABELS is what makes these stick. The same instruction
  // written as a general prohibition was followed for the BDR block, where the
  // labels were listed, and ignored for open items, where they were not: the
  // Orvia briefing still carried a "Questionnaire and pricing" line three lines
  // under an Open items block that already listed both.
  if (shape.blocks.includes("openItems"))
    owned.push(
      'what either side owes, promised, sent or has not delivered, including anything we committed to prepare or send for this call (Open items has all of it, with dates). Lines labelled like "What we owe", "Outstanding", "Questionnaire and pricing", "Not yet sent" or "Waiting on them" are forbidden here',
    );
  if (shape.blocks.includes("inTheRoom")) owned.push("who is on the call and what they each care about (On the call has it)");
  if (shape.blocks.includes("sinceLastContact")) owned.push("what was last said by either side (Since last contact has it)");
  if (shape.blocks.includes("theNumbers")) owned.push("figures, users, volumes and amounts (The numbers has it)");
  if (shape.blocks.includes("bookThis")) owned.push("the meeting we want booked (Book this has it)");
  const noRestate = ` THE PAGE ALSO CARRIES A BLOCK, RENDERED STRAIGHT FROM SALESFORCE, HOLDING EVERYTHING THE BDR RECORDED: their pain, their requirements, the software they run, their go-live date, their budget and sponsorship position, their size. The rep reads it directly and you are not writing it. "whereItStands" MAY NOT CONTAIN A LINE ABOUT ANY OF THAT, in other words, summarised, or under a different label ("Core pain", "Scope", "What they need", "Go-live target" are all forbidden).${
    owned.length > 0
      ? ` It equally may not restate ${owned.join("; ")}.`
      : ""
  } What is left is its actual job, and it is the only block that can do it: what all of that ADDS UP TO. How long this has been sitting, what has still never been verified, what is missing that we would need, what the timeline now demands of US, what this call has to change. If that is two lines, RETURN TWO LINES. Two lines the rest of the page has not already said are worth more than six that repeat it.`;
  const core = [
    `  "callObjective": string,`,
    // LABELLED LINES, NEVER A PARAGRAPH.
    //
    // This is the densest block in the brief. Six sentences of prose is a wall,
    // and a rep scanning for the money finds it only by reading the timeline
    // first. The facts were never joined by anything except being true, so they
    // are separated here and each one is told what it is about.
    `  "whereItStands": [ { "label": string, "point": string } ],   // Ordered most consequential first, as many lines as there are consequential things and no more. No fixed limit, and equally no quota: do not pad to reach a length. "point" is ONE complete sentence, said the way you would say it to a colleague. "label" is two or three words naming what the line is ABOUT, for example "The money", "Timeline", "Where the NDA got to", "Not captured". Never repeat a label.${noRestate}`,
    `  "nextStepCommitment": string,`,
    `  "whatsAtRisk": string,`,
    `  "signalFlag": string | null`,
  ];
  const extra = shape.blocks.map((b) => `  ${BLOCK_CONTRACT[b]}`);
  return [`{`, ...core.map((l) => `${l}`), ...extra, `}`].join("\n");
}
