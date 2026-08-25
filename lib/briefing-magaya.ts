/**
 * Magaya pre-call briefing builder.
 *
 * Stage-aware and framework-driven: it computes open gaps from each field's
 * stage_key (set by scripts/seed-magaya-framework.ts), so it works for the
 * Magaya SQL0-SQL5 framework without the SCOTSMAN/seed-data coupling in
 * lib/briefing-prompt.ts (which still serves the topsort demo).
 *
 * The LLM generates the REP-FACING questions (what the rep asks the
 * customer), targeted to who is on the upcoming call. We do not echo the
 * extraction question text, which is an internal assessment question.
 *
 * Output contract (JSON): callObjective, whereItStands, questions[],
 * nextStepCommitment, whatsAtRisk, signalFlag.
 */

import type { PreCallTypeRead } from "./call-type-precall";
import type { Framework } from "./framework";
import { CLOSING_DISCIPLINE, formatPlaysForBriefing } from "./magaya-plays";

export type FieldStatus = {
  status: "Yes" | "No" | "Unknown";
  answer?: string;
  evidence?: string;
  confidence?: number;
};

export type ExtractionMap = Record<string, FieldStatus>;

export type Gap = {
  fieldKey: string;
  label: string;
  question: string;
  stageKey: string | null;
  status: "No" | "Unknown";
};

const STAGE_ORDER = ["SQL0", "SQL1", "SQL2", "SQL3", "SQL4", "SQL5"] as const;

export function nextStageOf(stage: string): string | null {
  const i = STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
  if (i < 0 || i >= STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[i + 1];
}

/**
 * Open gaps at a given stage: framework fields tagged with that stage_key
 * whose extraction status is not "Yes" (i.e. No or Unknown).
 */
export function openGapsForStage(
  framework: Framework,
  extraction: ExtractionMap,
  stage: string,
): Gap[] {
  const out: Gap[] = [];
  for (const f of framework.fields) {
    if (f.stageKey !== stage) continue;
    const status = extraction[f.fieldKey]?.status;
    if (status === "Yes") continue;
    out.push({
      fieldKey: f.fieldKey,
      label: f.label,
      question: f.question,
      stageKey: f.stageKey,
      status: status === "No" ? "No" : "Unknown",
    });
  }
  return out;
}

/**
 * Open gaps at every stage up to AND including the given stage. Use this so a
 * briefing for an advanced deal still surfaces critical un-filled gaps beneath
 * it (e.g. Budget at SQL2 when the deal is at SQL4), instead of only the current
 * stage's slice. Ordered by stage.
 */
export function openGapsUpToStage(
  framework: Framework,
  extraction: ExtractionMap,
  stage: string,
): Gap[] {
  const rank = (k: string | null): number => {
    const m = (k ?? "").match(/(\d+)/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  };
  const ceiling = rank(stage);
  const out: Gap[] = [];
  for (const f of framework.fields) {
    if (!f.stageKey || rank(f.stageKey) > ceiling) continue;
    const status = extraction[f.fieldKey]?.status;
    if (status === "Yes") continue;
    out.push({
      fieldKey: f.fieldKey,
      label: f.label,
      question: f.question,
      stageKey: f.stageKey,
      status: status === "No" ? "No" : "Unknown",
    });
  }
  return out.sort((a, b) => rank(a.stageKey) - rank(b.stageKey));
}

export function buildMagayaBriefingSystemPrompt(framework: Framework): string {
  return `You write pre-call briefings for B2B sales reps using the ${framework.name} qualification framework. The briefing arms the rep for their next customer call so they advance the deal toward the next stage gate and toward commitment. It is concise, scannable, and rep-facing.

Rules:
1. No em-dashes (—) or en-dashes (–) anywhere. Use commas, periods, or rephrase. Hard rule, no exceptions.
2. No marketing language. Use the direct, concrete language a CRO uses with their rep.
3. Anchor every line to the deal's actual state below. Reference verbatim customer evidence where it exists.
4. An "ask" is spoken out loud to the CUSTOMER, so it must never reveal what our systems hold about them. Never write phrasing like "budget was noted as confirmed on our end", "our records show", "the notes say", "we have you down as". The customer did not tell us those things and hearing them read back is both awkward and a disclosure of internal data. Use what we hold to choose a sharper question, never as the preamble to one: ask "how are you planning to fund this?", not "we have budget marked confirmed, is that right?".
5. Every "ask" must be an actual QUESTION the customer answers with information, ending in a question mark. Never a statement, never a template with a placeholder for the rep to fill in, never a script direction. "Based on what you've shared, here's what I'd suggest we do next and when. Does that work for you?" is not a question, it is a stage cue with a blank in it, and a rep reading it live has nothing to say. Never spend an ask on booking the next meeting either: that is what nextStepCommitment is for, and using a slot on it wastes one of only three.
6. Each question is an object with four parts. "ask": REP-FACING, one tight sentence the rep says to the CUSTOMER on the call, phrased the way a rep actually talks, verbatim-usable, aim for about 15 words, never an internal assessment question. "why": one short clause for the rep's eyes only on the gap it closes and who it is for. "targetFields": the list of field IDs from the qualification state below that this question is designed to unblock or gather information on, using the exact field IDs shown. "targetLabel": the human-readable category of the primary target field, for example Authority, Budget, Timeline, People, Competition, Situation.
7. Generate at most 3 questions, targeting the highest-leverage OPEN gaps for the current and next stage, the ones that most move the deal toward the next gate or commitment. Fewer than 3 is fine if only one or two gaps truly matter for this call. Do not pad.
8. The attendee list names the CUSTOMER's people. Anyone listed after "Also on the call from Magaya" is the rep's own colleague and must NEVER be treated as a customer: an objective reading "get Laerte, Donna, Scott and Juan to share their current situation" asks the seller to brief himself, and every rep who reads it stops trusting the product. Shared inboxes are not people and are never addressed by name. Target the phrasing to who is on the upcoming call. A question for the economic buyer or CFO is framed differently than one for a champion or a technical contact. Use the attendee list.
9. When SINCE LAST CALL is present, it is the most important block in this message and "whereItStands" must be built from it. Name what the customer actually said, with their numbers, dates and words: "Mishel asked for the portal added at 250 a month and expects a management answer within two weeks" is a briefing, "budget, decision process and close date are all blank" is a database report. Never describe a gap only as missing; describe what the gap is blocking given what they told us. If we owe them something from last time, opening with it is almost always the right move, and if a question has already failed once, do not ask it again in the same words.
10. Budget. Once a proposal, estimate or price is in play, budget is a reaction to a number and never a question of existence: ask whether the investment range works, what would have to change for it to, or how they plan to fund it. Never ask whether budget exists on a proposal, pricing, contract or negotiation call, because the customer is holding our number and asking tells them we did not register that we quoted them. Before a number exists, PREFER ANCHORING over asking: "for reference, licensing for an operation your size runs about X to Y per month, I want you to have a ballpark so there are no surprises" surfaces the real budget reaction and controls the pricing narrative, where "do you have budget for this" invites a defensive non-answer. Only fall back to the two-option probe ("do you have budget allocated, or are you still exploring and would need to create it?") when anchoring does not fit. On a first conversation, budget is rarely the most valuable third question at all: their pain, their trigger and their decision process are worth more, and budget follows naturally once they want the thing. Do not reach for a budget question to fill a third slot.
11. Prefer questions that uncover unknowns the agent cannot know (the customer's procurement steps, signing path, legal sequence, internal timeline). Serve the question, do not assume the answer.
12. "callObjective" is what you want the CUSTOMER to DO by the end of the call (a concrete action or commitment), not what to confirm. Name the person or action.
13. "whatsAtRisk" is what slips if the call goes badly, stated in the customer's own compelling-event or timeline words where available.
14. "signalFlag" is one short flag ONLY if there is a live risk worth surfacing. When the user message carries a WHAT DEALRIPE HAS FLAGGED block, signalFlag MUST come from it and must not be invented: those flags are measured (days of silence against this deal's own cadence, how far and how often the close date has moved, whether we are waiting on a reply, whether the rep's band is ahead of the evidence) and the qualification fields alone cannot tell you any of them. Pick the single most consequential one and say it in the rep's language. If that block is absent or empty, signalFlag is null.
15. Do not invent facts that are not in the provided state.
15a. "Unknown" on a field means DEALRIPE HAS NOT HEARD IT, not that the customer has not decided it. Never say or imply otherwise. "whereItStands" describes the DEAL, never our own record: no "zero prior qualification data", no "all qualification fields are blank", no "nothing is on record", no "qualification record is empty". A rep does not care what our database holds, and telling them it is empty reads as an apology. If we truly know nothing about the deal, say what the call itself is and what you need out of it, for example "First working session on their inbond filings, so the job is to learn how they run today and leave with a dated next step."
16. Be brief and scannable, the rep reads this live on a call. callObjective, nextStepCommitment, whatsAtRisk and signalFlag are ONE tight sentence each, at most about 22 words, no run-ons and no lists. "whereItStands" is the exception, and the test is whether there is real material to carry, not which block it came from. Where you hold specifics, from SINCE LAST CALL, the rep checklist or the BDR record, it may run to four or five sentences, because naming what the customer said, what we owe them and what is at stake is worth more than brevity. Where you hold nothing specific, one sentence, because padding out an empty record is how a briefing becomes filler. Each question "ask" is at most about 18 words. Each "why" is one short line, at most about 14 words. Favor fewer words over completeness.
17. "nextStepCommitment" must be a specific, dated commitment: name the action and a concrete near-term date or timeframe the rep proposes on this call, anchored to TODAY in the user message (for example "early next week" or "the week of <a date after TODAY>"). Never use a past date, and never a date on or before THIS MEETING: proposing to "book a call for Thursday August 13" on a call that is itself Thursday August 13 reads as though nothing knows when this conversation is happening. The commitment is for what comes after today's call. ${CLOSING_DISCIPLINE}
18. The user message includes a reference block of how Magaya's best reps phrase questions for these gaps. Match that voice and style in your "ask" wording, and adapt each to this customer and the attendees. Do not copy the reference verbatim when it does not fit.

Return a single JSON object, no prose, no markdown fences:
{
  "callObjective": string,
  "whereItStands": string,
  "questions": [ { "ask": string, "why": string, "targetFields": [string], "targetLabel": string } ],
  "nextStepCommitment": string,
  "whatsAtRisk": string,
  "signalFlag": string | null
}
"ask" and "why" are shown to the rep; "targetFields" and "targetLabel" link the question to the gap it closes for the system to track.`;
}

export function buildMagayaBriefingUserMessage(args: {
  account: string;
  stage: string;
  nextStage: string | null;
  closeDate?: string;
  attendees: string;
  framework: Framework;
  extraction: ExtractionMap;
  currentGaps: Gap[];
  nextGaps: Gap[];
  history?: string;
  /** Today's date (YYYY-MM-DD), so the next-step commitment anchors a real near-term date. */
  today?: string;
  /**
   * Salesforce Sales Development context, recorded by the BDR before the rep
   * ever spoke to this company. Only present on deals with no Rolldog
   * opportunity yet, which is exactly where a briefing would otherwise have
   * almost nothing to work from. Explicitly second-class to the qualification
   * state above: it is a colleague's notes, not something the customer
   * confirmed to us, so the prompt is told to treat it as a lead to test.
   */
  crmContext?: string;
  /**
   * The calendar subject of the call being briefed.
   *
   * Without it the prompt sees only that a deal has no captured history and
   * concludes "first discovery call", which was wrong on half of Alexandra's
   * week: "Onboarding & Training" is an existing customer, "Proposal Walk
   * Through" is late-stage, "CONT. DEMO" and "Follow up session" are neither
   * first nor discovery. Telling a rep to book a demo before a proposal
   * walkthrough is how a briefing loses their trust in one reading.
   */
  meetingSubject?: string | null;
  /** When this call happens (YYYY-MM-DD), so the next step lands after it. */
  meetingDate?: string | null;
  /**
   * The rep's own stage checklist from Rolldog, rendered.
   *
   * This is the single biggest thing the briefing was missing. Without it a
   * deal three stages into the pipeline looked identical to a cold inbound,
   * because our extraction record was empty for both, and the briefing opened
   * an audit session with a customer of two years by asking what they do.
   */
  stageGates?: string | null;
  /**
   * Meetings on this deal DealRipe could not capture. Passed as a FACT rather
   * than handled by instruction: the prompt already told the model that an
   * empty record does not mean a first conversation, and on 2026-08-24 it
   * still wrote "First conversation DealRipe has data on for ATI" for a deal
   * whose rep had met the same people four days earlier in a meeting that died
   * in a Teams lobby. An instruction can be hedged around. A date cannot.
   */
  uncapturedCalls?: Array<{ date: string; reason: string }>;
  /**
   * The mailbox, rendered by emailLinesForBriefing.
   *
   * Placed between the calls and the CRM in this prompt on purpose. The calls
   * are the customer speaking to us. Email is the customer ACTING: replying,
   * not replying, adding people, going quiet. The CRM is a rep's summary of
   * both, written once and ageing since.
   */
  emailContext?: string | null;
  /**
   * The calendar invite, read for more than names. Placed ABOVE email in the
   * prompt: for a call that is about to happen, who is in the room outranks
   * what the inbox says.
   */
  attendeeContext?: string | null;
  /**
   * The rep's own notes from Rolldog's narrative tabs. Ranks above the BDR
   * record: the rep has spoken to this customer and the BDR filled in a form.
   */
  rolldogNarrative?: string | null;
  /**
   * What kind of call this is, resolved before it happens by
   * lib/call-type-precall.ts. Absent or "unknown" falls back to the prose
   * guidance, which is what the prompt had on its own.
   */
  callType?: PreCallTypeRead | null;
  /**
   * DealRipe's computed flags on this deal, as facts.
   *
   * Rule 14 asks the model to notice "a live risk worth surfacing", which means
   * signalFlag has always been INFERRED from the same qualification state the
   * rest of the briefing reads. Everything that makes those risks knowable is
   * computed deterministically elsewhere and was not reaching the prompt: how
   * long the customer has been silent measured against this deal's own rhythm,
   * how many times the close date has moved and by how much, whether we are
   * waiting on a reply, whether the rep's band is ahead of the evidence.
   *
   * None of that is in the extraction, so the model could not have known it,
   * and a flag it invented from an empty field is a guess wearing a fact's
   * clothes. Passed in as text so the prompt states rather than deduces.
   */
  dealFlags?: string | null;
}): string {
  const { framework, extraction } = args;

  const stateLines = framework.fields
    .map((f) => {
      const e = extraction[f.fieldKey];
      if (e && e.status === "Yes") {
        return `- ${f.fieldKey} (${f.label}) [${f.stageKey ?? "-"}]: Yes. ${e.answer ?? ""} Evidence: "${e.evidence ?? ""}"`;
      }
      const label = e?.status === "No" ? "No" : "Unknown";
      return `- ${f.fieldKey} (${f.label}) [${f.stageKey ?? "-"}]: ${label}`;
    })
    .join("\n");

  const gapLine = (g: Gap) => `- ${g.fieldKey} (${g.label}) [${g.status}]`;

  // Gaps beneath the current stage are a different animal from gaps at it.
  //
  // The deal has already cleared those gates in the CRM: a rep at Proposal
  // Validation has budget and an approver, they just never said it on a call we
  // heard. Presented in one undifferentiated list, the model reads a wall of
  // Unknown and reaches for the earliest, which is why GHY at SQL3 was being
  // told to ask whether they have budget set aside. Asking a proposal-stage
  // customer an opening qualification question is the single fastest way to
  // lose a rep, because they know it is wrong the moment they read it.
  const rankOf = (k: string | null): number => {
    const m = (k ?? "").match(/(\d+)/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  };
  const here = rankOf(args.stage);
  const atStage = args.currentGaps.filter((g) => rankOf(g.stageKey) >= here);
  const behind = args.currentGaps.filter((g) => rankOf(g.stageKey) < here);

  const lines = [
    args.today ? `TODAY: ${args.today}` : "",
    `ACCOUNT: ${args.account}`,
    args.meetingSubject ? `THIS MEETING IS TITLED: "${args.meetingSubject}"` : "",
    args.meetingDate ? `THIS MEETING HAPPENS ON: ${args.meetingDate}. Every commitment you propose must fall AFTER that date.` : "",
    `CURRENT STAGE: ${args.stage}${args.nextStage ? ` (next: ${args.nextStage})` : ""}`,
    args.closeDate ? `CLOSE DATE: ${args.closeDate}` : "",
    ``,
    `ON THE UPCOMING CALL: ${args.attendees}`,
    ``,
    `CURRENT QUALIFICATION STATE (${framework.name}):`,
    stateLines,
    ``,
    `OPEN GAPS, CURRENT STAGE (${args.stage}):`,
    atStage.length ? atStage.map(gapLine).join("\n") : "- none",
    ``,
    `OPEN GAPS, NEXT STAGE (${args.nextStage ?? "n/a"}):`,
    args.nextGaps.length ? args.nextGaps.map(gapLine).join("\n") : "- none",
  ];

  if (behind.length) {
    lines.push(
      ``,
      `CLEARED IN THE CRM BUT NEVER CONFIRMED TO US (stages below ${args.stage}):`,
      behind.map(gapLine).join("\n"),
      `The deal has already passed these gates, so the customer has answered them for someone. We simply have no recording of it. Do NOT open with these and do NOT ask them as discovery. Raise one only if it is genuinely load-bearing for this specific call, and then as a confirmation of something assumed, for example "just so I have it right, is the budget still coming out of your operations line?" rather than "do you have budget for this?".`,
    );
  }

  if (args.history) {
    lines.push(``, `SINCE LAST CALL:`, args.history);
  }

  if (args.dealFlags) {
    // Above the plays and below the history: it is more current than the
    // reference material and less specific than what the customer last said.
    lines.push(
      ``,
      `WHAT DEALRIPE HAS FLAGGED ON THIS DEAL. These are measured, not inferred, and`,
      `are the only acceptable basis for "signalFlag". Do not invent a risk that is`,
      `not here, and do not repeat one verbatim to the customer in an "ask".`,
      args.dealFlags,
    );
  }

  // What kind of call this is, RESOLVED, not left for the model to infer.
  //
  // The prose block below has been in this prompt since the Alexandra week and
  // it is guidance, not a decision: the model had to notice the title, weigh it
  // against an empty qualification record, and get it right every time. The
  // prescription ledger measured how often that failed. 25% follow-through on
  // discovery calls against 0% on demos, follow-ups and existing-customer
  // calls, because the questions issued to those calls were first-discovery
  // questions and the reps correctly did not ask them.
  //
  // lib/call-type-precall.ts now decides this from the deal's own captured
  // history and the invite title, before the call, and states it as a fact with
  // its source. The prose stays underneath as the fallback for "unknown".
  if (args.callType && args.callType.type !== "unknown") {
    const t = args.callType;
    lines.push(``, `THIS IS A ${t.type.toUpperCase().replace("_", " ")} CALL, because ${t.reason}.`);
    if (t.type === "existing_customer") {
      lines.push(
        `They have already bought. Do NOT qualify them, do NOT ask what systems they run today, do NOT ask what is driving them to look for a solution, and never propose a demo. Brief on what is unresolved operationally, what they are trying to get done, and the health of the account. A qualification question here tells a paying customer we do not know who they are.`,
      );
    } else if (t.type === "internal") {
      lines.push(
        `This is not a customer call. There is nothing to qualify and nobody to ask.`,
      );
    } else if (t.type === "proposal") {
      lines.push(
        `Our number is in front of them, or is about to be. The job is a decision, a signing path or a redline, not discovery. Never ask whether budget exists, never ask what systems they run today, and never ask what is driving them to look: all three tell the customer we have not registered our own proposal. Ask about the approval sequence, what would have to change for the investment to work, and who signs.`,
      );
    } else if (t.type === "demo") {
      lines.push(
        `They have seen or are about to see the product. Discovery framing is wrong: asking what they run today, after we built a demo for them, reads as a rep who did not prepare. Ask what they need to see to be convinced, who else must see it, and what happens after.`,
      );
    } else if (t.type === "follow_up") {
      lines.push(
        `This conversation is already in progress. Never open as though meeting them for the first time and never re-ask what they have already told us. Pick up what was left open.`,
      );
    }
  }

  if (args.uncapturedCalls?.length) {
    const when = args.uncapturedCalls
      .map((c) => new Date(c.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }))
      .join(", ");
    lines.push(
      ``,
      `MEETINGS WE MISSED. DealRipe could not capture this deal's meeting(s) on ${when}. As far as anyone knows those conversations HAPPENED and we have no record of them.`,
      `So this is NOT a first conversation, and you must not write that it is. Say plainly, once, that the ${when} call could not be captured and that this briefing therefore has no history behind it.`,
      `Frame every gap below as UNKNOWN TO US rather than as unasked. Telling a rep to ask what he already asked on ${when} is the fastest way to make him stop opening these.`,
    );
  }

  if (args.meetingSubject) {
    lines.push(
      ``,
      `WHAT KIND OF CALL THIS IS. Read the meeting title above and brief for THAT call. An empty qualification record means DealRipe has not listened to this account before; it does NOT mean this is a first conversation, and the rep will know instantly if you get this wrong.`,
      `- "Onboarding", "Training", "Kickoff", "Implementation": they have already bought. Do not qualify them and never propose a demo. Brief on making the rollout succeed and on what is unresolved operationally.`,
      `- "Proposal", "Proposal Walk Through", "Pricing", "Contract", "Renewal": late stage. The objective is a decision, a signature path or a redline, not discovery.`,
      `- "CONT.", "Continued", "Follow up", "Additional session", "Next steps", "Part 2": a conversation already in progress. Never open as though meeting them for the first time.`,
      `- "Audit", "Review", "Check-in", "Office Hours": an existing relationship. Brief on the account's health and what they are trying to get done.`,
      `- "Intro", "Discovery", "Demo" with nothing prior: genuinely early, so discovery framing is right.`,
      `Where the title and the qualification record disagree, trust the title about the STAGE of the relationship and the record about WHICH FACTS are confirmed.`,
    );
  }

  if (args.stageGates) {
    lines.push(
      ``,
      `WHAT THE REP HAS ALREADY DONE (their checklist in the CRM):`,
      args.stageGates,
      ``,
      `This is the rep's own record of the work, so treat every ticked item as done and never ask the customer to confirm it happened. If a demo, a proposal or a site visit is ticked, that call has already occurred: brief for what comes after it. These ticks are a claim rather than evidence, so they may be used to rule a question OUT but never to fill a qualification gap IN.`,
    );
  }

  if (args.attendeeContext) {
    lines.push(``, args.attendeeContext);
  }

  // Email goes ABOVE both CRM blocks. Ranking, stated once so it is not
  // re-litigated: the calls are the customer speaking to us, email is the
  // customer ACTING, and the CRM is a rep's summary of both that ages from the
  // moment it is saved. A reply that never came outranks a note about it.
  if (args.emailContext) {
    lines.push(``, args.emailContext);
  }

  if (args.rolldogNarrative) {
    lines.push(
      ``,
      `WHAT THE REP HAS WRITTEN ABOUT THIS DEAL (their own notes in the CRM):`,
      args.rolldogNarrative,
      ``,
      `This is the rep's own account, so it outranks the BDR record below and is usually the most accurate picture of the deal available before the call. It is still not the customer speaking, so use it to aim the questions rather than to fill a qualification gap. If it records a concern, a competitor or a stated objection, that is almost always the most important thing on this call.`,
    );
  }

  if (args.crmContext) {
    lines.push(
      ``,
      `WHAT THE BDR RECORDED BEFORE THIS CALL (from Salesforce):`,
      args.crmContext,
      ``,
      `Treat the block above as unverified. A colleague wrote it down; the customer has not confirmed any of it to us. Use it to make the questions specific and to avoid asking what is already known, but never state it back as established fact, and never let it fill a qualification gap. If something in it is important and unconfirmed, that is a good thing to ask about.`,
    );
  }

  // Reference: how Magaya's best reps phrase questions for the open gaps on this
  // call. Guides the voice of the generated "ask" fields; adapted, not copied.
  const gapLabels = [...args.currentGaps, ...args.nextGaps].map((g) => g.label);
  const playsBlock = formatPlaysForBriefing(gapLabels);
  if (playsBlock) {
    lines.push(``, playsBlock);
  }

  lines.push(
    ``,
    `Write the briefing JSON. Generate rep-facing questions for the highest-leverage open gaps, targeted to who is on the call. Return JSON only.`,
  );

  return lines.filter((l) => l !== "").join("\n");
}
