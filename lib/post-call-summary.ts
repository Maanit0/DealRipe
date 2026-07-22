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

/** NDA-before-demo read from the transcript. */
export type NdaSignal = {
  demoIsNext: boolean; // a demo/presentation is the agreed next step
  ndaInPlace: boolean; // a mutual NDA is signed or explicitly agreed
  customerResisted: boolean; // the customer pushed back on signing an NDA
};

export type PostCallSummary = {
  account: string;
  stageKey: string;
  recap: string;
  captured: CapturedField[];
  stillOpen: OpenField[];
  suggestedNextStep: string;
  /** The concrete follow-up both sides agreed to, if any. */
  nextStepCommitment: string | null;
  /** The conversation implies a next meeting should be booked. */
  followUpMeetingExpected: boolean;
  /** Set by the caller after checking the calendar: expected but nothing booked. */
  noFollowupBooked?: boolean;
  /** NDA-before-demo read, or null if not relevant on this call. */
  nda: NdaSignal | null;
  /** One short coaching observation (talk-time / pain depth), or null. */
  coaching: string | null;
};

export type PostCallSummaryInput = {
  account: string;
  stageKey: string;
  closeDate?: string;
  attendees?: string;
  framework: Framework;
  /** Extraction from THIS call. Drives "captured on this call". */
  extraction: ExtractionMap;
  /**
   * Optional broader state (Rolldog context merged with all calls) used to
   * compute "still open", so we don't flag gaps Rolldog already has filled.
   * Defaults to `extraction` when omitted.
   */
  gapExtraction?: ExtractionMap;
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
4. "recap": 2 to 3 short sentences, each at most about 16 words, on what actually happened, what the customer said, what moved or was deferred. Concrete, not generic. Brief and scannable, no run-ons.
5. "suggestedNextStep": ONE specific next action for the rep, at most about 18 words. Name the person or action. One tight sentence.
6. Write for the rep's eyes. Second person is fine ("you").
7. "nextStepCommitment": the concrete next action from the rep's side, phrased as a short imperative fragment with NO trailing period and NOT starting with the rep's own name (e.g. "send Ely the product videos and datasheet", "reconvene after their board meets"). At most about 14 words, or null if none was set.
8. "followUpMeetingExpected": true ONLY if a specific next meeting, call, or demo was agreed and could be booked now with both sides ready. Set it FALSE if the immediate next step is asynchronous (sending materials, waiting on the customer's internal review or an RFI), if the next meeting is gated on a prerequisite like a signed NDA, if a meeting was already scheduled on the call, or if the deal is dead. When in doubt, false.
9. "nda": about Magaya's rule of a signed mutual NDA before a demo. Return null if NDAs never came up and no demo is near. Otherwise an object:
   { "demoIsNext": boolean (a demo or presentation is the agreed or imminent next step),
     "ndaInPlace": boolean (a mutual NDA is signed or was explicitly agreed on this call),
     "customerResisted": boolean (the customer questioned or pushed back on signing an NDA) }
10. "coaching": ONE short, kind, specific coaching note for the rep IF and only if the transcript clearly shows the rep moved off a pain point too quickly or dominated the talking when the customer should have. At most about 20 words, second person. null if the rep ran the call well. Do not invent a critique.

Return a single JSON object, no prose, no markdown fences:
{ "recap": string, "suggestedNextStep": string, "nextStepCommitment": string|null, "followUpMeetingExpected": boolean, "nda": {"demoIsNext": boolean, "ndaInPlace": boolean, "customerResisted": boolean}|null, "coaching": string|null }`;
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

type ParsedSummary = {
  recap: string;
  suggestedNextStep: string;
  nextStepCommitment: string | null;
  followUpMeetingExpected: boolean;
  nda: NdaSignal | null;
  coaching: string | null;
};

function parseNda(v: unknown): NdaSignal | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return {
    demoIsNext: o.demoIsNext === true,
    ndaInPlace: o.ndaInPlace === true,
    customerResisted: o.customerResisted === true,
  };
}

function parseJson(raw: string): ParsedSummary | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    if (typeof o.recap !== "string" || typeof o.suggestedNextStep !== "string") return null;
    return {
      recap: o.recap,
      suggestedNextStep: o.suggestedNextStep,
      nextStepCommitment:
        typeof o.nextStepCommitment === "string" && o.nextStepCommitment.trim()
          ? o.nextStepCommitment.trim()
          : null,
      followUpMeetingExpected: o.followUpMeetingExpected === true,
      nda: parseNda(o.nda),
      coaching: typeof o.coaching === "string" && o.coaching.trim() ? o.coaching.trim() : null,
    };
  } catch {
    return null;
  }
}

export async function generatePostCallSummary(
  input: PostCallSummaryInput,
): Promise<PostCallSummary> {
  const captured = capturedFields(input.framework, input.extraction);
  const stillOpen = openFields(
    input.framework,
    input.gapExtraction ?? input.extraction,
    input.stageKey,
  );

  const resp = await getAnthropicClient().messages.create({
    model: getAnthropicModel(),
    max_tokens: 1000,
    temperature: 0.2,
    system: buildSystemPrompt(input.framework),
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });
  const block = resp.content.find((b) => b.type === "text");
  const text = block && "text" in block ? block.text : "";
  const parsed: ParsedSummary = parseJson(text) ?? {
    recap: "Recap unavailable. See the captured fields and open items below.",
    suggestedNextStep: "Review the open items and book the next step with the customer.",
    nextStepCommitment: null,
    followUpMeetingExpected: false,
    nda: null,
    coaching: null,
  };

  return {
    account: input.account,
    stageKey: input.stageKey,
    recap: parsed.recap,
    captured,
    stillOpen,
    suggestedNextStep: parsed.suggestedNextStep,
    nextStepCommitment: parsed.nextStepCommitment,
    followUpMeetingExpected: parsed.followUpMeetingExpected,
    nda: parsed.nda,
    coaching: parsed.coaching,
  };
}
