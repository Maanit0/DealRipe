/**
 * Meeting-type classification + non-sales recap.
 *
 * DealRipe auto-joins every meeting a rep is invited to, so not every captured
 * call is a new-opportunity sales call. Eduardo's feedback: a customer or
 * internal meeting still deserves a recap, but the sales-qualification framing
 * (captured gates / still-open gates) is the wrong shape for it. This module
 * classifies the meeting and, for non-sales meetings, produces a plain
 * takeaways + next-steps recap instead.
 *
 * Both calls fail soft: on any error the caller falls back to the existing
 * sales recap, so a classification hiccup never blocks a rep's recap.
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";

export type MeetingType = "new_opportunity" | "existing_customer" | "internal";

const MAX_CHARS = 14000; // enough signal for classification/summary, keeps cost low

/** Classify a call transcript. Defaults to "new_opportunity" on any failure. */
export async function classifyMeetingType(transcript: string): Promise<MeetingType> {
  if (!process.env.ANTHROPIC_API_KEY || transcript.trim().length < 50) return "new_opportunity";
  const system = `Classify a B2B call transcript into exactly one type. Reply with ONLY the type word, nothing else.
- new_opportunity: a sales call with a prospect or a not-yet-closed deal (discovery, demo, qualification, evaluation, pricing).
- existing_customer: a call with a CURRENT customer already using or implementing the product (support, account management, onboarding, expansion of an already-won deal).
- internal: a call among the seller's own team with no customer/prospect present.`;
  try {
    const resp = await getAnthropicClient().messages.create({
      model: getAnthropicModel(),
      max_tokens: 10,
      temperature: 0,
      system,
      messages: [{ role: "user", content: `Transcript:\n\n${transcript.slice(0, MAX_CHARS)}` }],
    });
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").toLowerCase();
    if (text.includes("existing_customer")) return "existing_customer";
    if (text.includes("internal")) return "internal";
    return "new_opportunity";
  } catch {
    return "new_opportunity";
  }
}

export type GeneralRecap = {
  summary: string;
  takeaways: string[];
  nextSteps: string[];
};

/**
 * Produce a plain recap for a non-sales meeting: what it was about, the key
 * takeaways, and concrete next steps with owners where stated. No qualification
 * framing. Returns null on failure so the caller can fall back.
 */
export async function generateGeneralRecap(args: {
  account: string;
  transcript: string;
}): Promise<GeneralRecap | null> {
  if (!process.env.ANTHROPIC_API_KEY || args.transcript.trim().length < 50) return null;
  const system = `You recap a call for the rep who was on it (or invited). This is NOT a sales-qualification call, so do NOT use budget/authority/close-plan framing. Return ONLY JSON:
{
  "summary": string,        // 2-3 sentences: what this call was about
  "takeaways": string[],    // 3-6 key points that were discussed or decided
  "nextSteps": string[]     // concrete next steps, each naming the owner if stated (e.g. "Erika to send the list of 3 members needing API access")
}
Ground everything strictly in the transcript. If there are no clear next steps, return an empty array for nextSteps.`;
  try {
    const resp = await getAnthropicClient().messages.create({
      model: getAnthropicModel(),
      max_tokens: 1200,
      temperature: 0.2,
      system,
      messages: [{ role: "user", content: `Account: ${args.account}\n\nTranscript:\n\n${args.transcript.slice(0, MAX_CHARS)}` }],
    });
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
    return {
      summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "",
      takeaways: arr(parsed.takeaways),
      nextSteps: arr(parsed.nextSteps),
    };
  } catch {
    return null;
  }
}
