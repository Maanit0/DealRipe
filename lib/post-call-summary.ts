/**
 * Post-call summary generator.
 *
 * After a call's transcript is extracted, this produces the rep-facing recap
 * that gets emailed: a short narrative of what happened, the qualification
 * fields captured on the call, what is still open, and one concrete next step.
 *
 * Split of concerns:
 *   - "captured" and "stillOpen" are DETERMINISTIC, computed from the
 *     framework + extraction so they can never drift from the actual data.
 *   - "recap" and "suggestedNextStep" come from the model, grounded in the
 *     transcript and the qualification state.
 *
 * No em-dashes in any output (project convention).
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import {
  nextStageOf,
  openGapsForStage,
  type ExtractionMap,
} from "./briefing-magaya";
import type { Framework } from "./framework";

export type CapturedField = { fieldKey: string; label: string; answer: string };
export type OpenField = { fieldKey: string; label: string; question: string; stageKey: string | null };

export type PostCallSummary = {
  account: string;
  stageKey: string;
  recap: string;
  captured: CapturedField[];
  stillOpen: OpenField[];
  suggestedNextStep: string;
};

export type PostCallSummaryInput = {
  account: string;
  stageKey: string;
  closeDate?: string;
  attendees?: string;
  framework: Framework;
  extraction: ExtractionMap;
  transcript: string;
};

/** Fields the extraction marked Yes, in framework order. */
export function capturedFields(
  framework: Framework,
  extraction: ExtractionMap,
): CapturedField[] {
  const out: CapturedField[] = [];
  for (const f of framework.fields) {
    const e = extraction[f.fieldKey];
    if (e && e.status === "Yes") {
      out.push({ fieldKey: f.fieldKey, label: f.label, answer: e.answer ?? "" });
    }
  }
  return out;
}

/** Open gaps at the current stage plus the next stage, de-duplicated. */
export function openFields(
  framework: Framework,
  extraction: ExtractionMap,
  stageKey: string,
): OpenField[] {
  const next = nextStageOf(stageKey);
  const gaps = [
    ...openGapsForStage(framework, extraction, stageKey),
    ...(next ? openGapsForStage(framework, extraction, next) : []),
  ];
  const seen = new Set<string>();
  const out: OpenField[] = [];
  for (const g of gaps) {
    if (seen.has(g.fieldKey)) continue;
    seen.add(g.fieldKey);
    out.push({ fieldKey: g.fieldKey, label: g.label, question: g.question, stageKey: g.stageKey });
  }
  return out;
}

function buildSystemPrompt(framework: Framework): string {
  return `You write short post-call recaps for a B2B sales rep, using the ${framework.name} qualification framework. The rep was on the call; you were the notetaker. The recap goes to the rep by email right after the call.

Rules:
1. No em-dashes or en-dashes anywhere. Use commas or periods. Hard rule.
2. No marketing language, no praise, no "great call". Plain, factual, the way a sales manager recaps to a rep.
3. Ground every statement in the transcript. Do not invent facts, numbers, names, or commitments that were not said.
4. "recap": 2 to 4 sentences on what actually happened on this call, what the customer said, what moved, what was decided or deferred. Concrete, not generic.
5. "suggestedNextStep": ONE specific next action for the rep to advance the deal, based on what is still open and what the customer said. Name the person or action. One sentence.
6. Write for the rep's eyes. Second person is fine ("you").

Return a single JSON object, no prose, no markdown fences:
{ "recap": string, "suggestedNextStep": string }`;
}

function buildUserMessage(input: PostCallSummaryInput): string {
  const { framework, extraction } = input;
  const stateLines = framework.fields
    .map((f) => {
      const e = extraction[f.fieldKey];
      if (e && e.status === "Yes") {
        return `- ${f.label}: Yes. ${e.answer ?? ""}`;
      }
      const label = e?.status === "No" ? "No" : "Unknown";
      return `- ${f.label}: ${label}`;
    })
    .join("\n");

  return [
    `ACCOUNT: ${input.account}`,
    `STAGE: ${input.stageKey}`,
    input.closeDate ? `CLOSE DATE: ${input.closeDate}` : "",
    input.attendees ? `ATTENDEES: ${input.attendees}` : "",
    ``,
    `QUALIFICATION STATE AFTER THIS CALL (${framework.name}):`,
    stateLines,
    ``,
    `TRANSCRIPT:`,
    input.transcript,
    ``,
    `Write the recap JSON. Ground it in the transcript above. Return JSON only.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function parseJson(raw: string): { recap: string; suggestedNextStep: string } | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const o = JSON.parse(s) as { recap?: string; suggestedNextStep?: string };
    if (typeof o.recap === "string" && typeof o.suggestedNextStep === "string") {
      return { recap: o.recap, suggestedNextStep: o.suggestedNextStep };
    }
    return null;
  } catch {
    return null;
  }
}

export async function generatePostCallSummary(
  input: PostCallSummaryInput,
): Promise<PostCallSummary> {
  const captured = capturedFields(input.framework, input.extraction);
  const stillOpen = openFields(input.framework, input.extraction, input.stageKey);

  const resp = await getAnthropicClient().messages.create({
    model: getAnthropicModel(),
    max_tokens: 1000,
    temperature: 0.2,
    system: buildSystemPrompt(input.framework),
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });
  const block = resp.content.find((b) => b.type === "text");
  const text = block && "text" in block ? block.text : "";
  const parsed = parseJson(text) ?? {
    recap: "Recap unavailable. See the captured fields and open items below.",
    suggestedNextStep: "Review the open items and book the next step with the customer.",
  };

  return {
    account: input.account,
    stageKey: input.stageKey,
    recap: parsed.recap,
    captured,
    stillOpen,
    suggestedNextStep: parsed.suggestedNextStep,
  };
}
