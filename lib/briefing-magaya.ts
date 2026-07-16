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
    `ACCOUNT: ${args.account}`,
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

  lines.push(
    ``,
    `Write the briefing JSON. Generate rep-facing questions for the highest-leverage open gaps, targeted to who is on the call. Return JSON only.`,
  );

  return lines.filter((l) => l !== "").join("\n");
}
