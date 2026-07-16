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
  openGapsUpToStage,
  type ExtractionMap,
} from "./briefing-magaya";
import { inferStageKey } from "./deal-state";
import type { ExtractionResult } from "./scotsman";
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

export type BriefingState = {
  account: string;
  stageKey: string;
  closeDate?: string;
  attendees: string;
  framework: Framework;
  extraction: ExtractionMap;
};

/**
 * Generate a briefing from an explicit state (extraction + stage + context),
 * regardless of where that state came from. The deal-based path below builds
 * state from a Deal; the Rolldog-context path (scripts/preview-rolldog-briefing)
 * builds it from a live Rolldog opportunity read.
 */
export async function generateBriefingFromState(
  state: BriefingState,
): Promise<MagayaBriefing | null> {
  const { framework, extraction } = state;
  // Brief against the stage the calls actually show, not a stale/absent CRM
  // stage: if the deal has captured signal beyond state.stageKey, use that.
  const stageKey = inferStageKey(
    framework,
    extraction as unknown as ExtractionResult,
    state.stageKey,
  );
  const next = nextStageOf(stageKey);
  // Open gaps at AND beneath the effective stage, so an advanced deal still gets
  // asked about critical un-filled gaps lower down, not just its current slice.
  const currentGaps = openGapsUpToStage(framework, extraction, stageKey);
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
          account: state.account,
          stage: stageKey,
          nextStage: next,
          closeDate: state.closeDate,
          attendees: state.attendees,
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

export async function generateMagayaBriefing(
  deal: Deal,
  framework: Framework,
): Promise<MagayaBriefing | null> {
  return generateBriefingFromState({
    account: deal.account,
    stageKey: deal.stageKey,
    closeDate: deal.repForecastCloseDate || undefined,
    attendees: attendeesFrom(deal),
    framework,
    extraction: deal.extraction as unknown as ExtractionMap,
  });
}
