/**
 * Server-side Magaya pre-call briefing generation.
 *
 * Wraps lib/briefing-magaya.ts (prompts) + lib/anthropic.ts (model) into a
 * single call the prepare page (and a future API/cron) can use. Reads a
 * live Deal's current extraction + open gaps and returns the structured
 * briefing { callObjective, whereItStands, questions[], nextStepCommitment,
 * whatsAtRisk, signalFlag }.
 *
 * Attendees are derived from the deal's contacts for now; once the calendar
 * read is live, pass the actual upcoming-call attendees instead.
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import {
  buildMagayaBriefingSystemPrompt,
  buildMagayaBriefingUserMessage,
  nextStageOf,
  openGapsForStage,
  type ExtractionMap,
} from "./briefing-magaya";
import type { Framework } from "./framework";
import type { Deal } from "./seed-data";

export type BriefingQuestion = {
  ask: string;
  why: string;
  targetFields: string[];
  targetLabel: string;
};

export type MagayaBriefing = {
  callObjective: string;
  whereItStands: string;
  questions: BriefingQuestion[];
  nextStepCommitment: string;
  whatsAtRisk: string;
  signalFlag: string | null;
};

export function attendeesFrom(deal: Deal): string {
  if (deal.contacts.length === 0) return "the customer (attendees not yet confirmed)";
  return deal.contacts
    .map((c) => {
      const rel = c.relationship !== "unknown" ? `, ${c.relationship.replace("_", " ")}` : "";
      return c.role ? `${c.name} (${c.role}${rel})` : c.name;
    })
    .join("; ");
}

function parseJson(raw: string): MagayaBriefing | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(s) as MagayaBriefing;
  } catch {
    return null;
  }
}

export async function generateMagayaBriefing(
  deal: Deal,
  framework: Framework,
): Promise<MagayaBriefing | null> {
  const extraction = deal.extraction as unknown as ExtractionMap;
  const stage = deal.stageKey;
  const next = nextStageOf(stage);
  const currentGaps = openGapsForStage(framework, extraction, stage);
  const nextGaps = next ? openGapsForStage(framework, extraction, next) : [];

  const resp = await getAnthropicClient().messages.create({
    model: getAnthropicModel(),
    max_tokens: 2000,
    temperature: 0.1,
    system: buildMagayaBriefingSystemPrompt(framework),
    messages: [
      {
        role: "user",
        content: buildMagayaBriefingUserMessage({
          account: deal.account,
          stage,
          nextStage: next,
          closeDate: deal.repForecastCloseDate || undefined,
          attendees: attendeesFrom(deal),
          framework,
          extraction,
          currentGaps,
          nextGaps,
        }),
      },
    ],
  });

  const block = resp.content.find((b) => b.type === "text");
  const text = block && "text" in block ? block.text : "";
  return parseJson(text);
}
