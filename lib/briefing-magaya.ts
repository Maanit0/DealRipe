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
4. Each question is an object with four parts. "ask": REP-FACING, one tight sentence the rep says to the CUSTOMER on the call, phrased the way a rep actually talks, verbatim-usable, aim for about 15 words, never an internal assessment question. "why": one short clause for the rep's eyes only on the gap it closes and who it is for. "targetFields": the list of field IDs from the qualification state below that this question is designed to unblock or gather information on, using the exact field IDs shown. "targetLabel": the human-readable category of the primary target field, for example Authority, Budget, Timeline, People, Competition, Situation.
5. Generate at most 3 questions, targeting the highest-leverage OPEN gaps for the current and next stage, the ones that most move the deal toward the next gate or commitment. Fewer than 3 is fine if only one or two gaps truly matter for this call. Do not pad.
6. Target the phrasing to who is on the upcoming call. A question for the economic buyer or CFO is framed differently than one for a champion or a technical contact. Use the attendee list.
7. Prefer questions that uncover unknowns the agent cannot know (the customer's procurement steps, signing path, legal sequence, internal timeline). Serve the question, do not assume the answer.
8. "callObjective" is what you want the CUSTOMER to DO by the end of the call (a concrete action or commitment), not what to confirm. Name the person or action.
9. "whatsAtRisk" is what slips if the call goes badly, stated in the customer's own compelling-event or timeline words where available.
10. "signalFlag" is one short flag ONLY if there is a live risk worth surfacing (economic buyer not engaged, deal stalled, competitor ahead, close date unvalidated). Otherwise null.
11. Do not invent facts that are not in the provided state.
12. Be brief and scannable, the rep reads this live on a call. Every text field (callObjective, whereItStands, nextStepCommitment, whatsAtRisk, signalFlag) is ONE tight sentence, at most about 22 words, no run-ons and no lists. Each question "ask" is at most about 18 words. Each "why" is one short line, at most about 14 words. Favor fewer words over completeness.
13. "nextStepCommitment" must be a specific, dated commitment: name the action and a concrete near-term date or timeframe the rep proposes on this call, anchored to TODAY in the user message (for example "early next week" or "the week of <a date after TODAY>"). Never use a past date. ${CLOSING_DISCIPLINE}
14. The user message includes a reference block of how Magaya's best reps phrase questions for these gaps. Match that voice and style in your "ask" wording, and adapt each to this customer and the attendees. Do not copy the reference verbatim when it does not fit.

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

  const lines = [
    args.today ? `TODAY: ${args.today}` : "",
    `ACCOUNT: ${args.account}`,
    args.meetingSubject ? `THIS MEETING IS TITLED: "${args.meetingSubject}"` : "",
    `CURRENT STAGE: ${args.stage}${args.nextStage ? ` (next: ${args.nextStage})` : ""}`,
    args.closeDate ? `CLOSE DATE: ${args.closeDate}` : "",
    ``,
    `ON THE UPCOMING CALL: ${args.attendees}`,
    ``,
    `CURRENT QUALIFICATION STATE (${framework.name}):`,
    stateLines,
    ``,
    `OPEN GAPS, CURRENT STAGE (${args.stage}):`,
    args.currentGaps.length ? args.currentGaps.map(gapLine).join("\n") : "- none",
    ``,
    `OPEN GAPS, NEXT STAGE (${args.nextStage ?? "n/a"}):`,
    args.nextGaps.length ? args.nextGaps.map(gapLine).join("\n") : "- none",
  ];

  if (args.history) {
    lines.push(``, `SINCE LAST CALL:`, args.history);
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
