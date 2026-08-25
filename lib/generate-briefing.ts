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

import { runModel } from "./model-run";
import {
  briefingErrors,
  describeFindings,
  lintBriefing,
  type BriefingFinding,
} from "./briefing-lint";
import {
  buildMagayaBriefingSystemPrompt,
  buildMagayaBriefingUserMessage,
  nextStageOf,
  openGapsForStage,
  openGapsUpToStage,
  type ExtractionMap,
} from "./briefing-magaya";
import type { PreCallTypeRead } from "./call-type-precall";
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
  /** Salesforce BDR context, present only on deals with no Rolldog opp. */
  crmContext?: string;
  /** Calendar subject of the call, so the briefing matches the kind of call. */
  meetingSubject?: string | null;
  /** The rep's ticked checklist from Rolldog, rendered for the prompt. */
  stageGates?: string | null;
  /** What the last calls established and what is still owed. */
  history?: string;
  /** When this call happens (YYYY-MM-DD), so commitments land after it. */
  meetingDate?: string | null;
  /** The rep's own written notes from Rolldog's narrative tabs. */
  rolldogNarrative?: string | null;
  /** What kind of call this is, resolved pre-call. See lib/call-type-precall.ts. */
  callType?: PreCallTypeRead | null;
  /**
   * DealRipe's measured flags on this deal, rendered for the prompt.
   *
   * Optional and absent by default, so every existing caller behaves exactly as
   * before. See renderFlagsForBriefing in lib/deal-flags.ts for why the model
   * must not infer these.
   */
  dealFlags?: string | null;
  /**
   * Meetings on this deal DealRipe could not capture. Optional and absent by
   * default, so every existing caller behaves exactly as before. See
   * DealContext.uncapturedCalls for why a rep must be told.
   */
  uncapturedCalls?: Array<{ date: string; reason: string }>;
  /**
   * What the mailbox says, rendered. Ranks below the calls and above the CRM.
   * See emailLinesForBriefing for why it carries facts and not a verdict.
   */
  emailContext?: string | null;
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

  const userMessage = buildMagayaBriefingUserMessage({
    account: state.account,
    stage: stageKey,
    nextStage: next,
    closeDate: state.closeDate,
    attendees: state.attendees,
    framework,
    extraction,
    currentGaps,
    nextGaps,
    crmContext: state.crmContext,
    meetingSubject: state.meetingSubject,
    meetingDate: state.meetingDate,
    stageGates: state.stageGates,
    uncapturedCalls: state.uncapturedCalls,
    emailContext: state.emailContext,
    history: state.history,
    rolldogNarrative: state.rolldogNarrative,
    callType: state.callType,
    dealFlags: state.dealFlags,
    today: new Date().toISOString().slice(0, 10),
  });

  // Generate, check, and on a hard failure regenerate once with the specific
  // findings fed back. The linter enforces the handful of rules that must never
  // break (insider language spoken to a customer, dashes, asking whether budget
  // exists after we have quoted a price). A prompt makes those unlikely; only
  // code makes them impossible. If the second attempt still fails we return
  // nothing, because a rep is better served by no briefing than by one that
  // makes them sound like they are reading from a file.
  let last: MagayaBriefing | null = null;
  let lastFindings: BriefingFinding[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: userMessage },
    ];
    if (attempt > 0 && last) {
      messages.push({ role: "assistant", content: JSON.stringify(last) });
      messages.push({
        role: "user",
        content: `That draft breaks rules that cannot be broken:\n${briefingErrors(lastFindings)
          .map((f) => `- ${f.field}: ${f.rule}${f.detail ? ` -> "${f.detail}"` : ""}`)
          .join("\n")}\n\nRewrite the whole briefing fixing exactly those problems. Keep everything else. Return JSON only.`,
      });
    }

    const resp = await runModel({
      task: "briefing",
      maxTokens: 2000,
      temperature: 0.1,
      system: buildMagayaBriefingSystemPrompt(framework),
      messages,
    });

    const block = resp.message.content.find((b) => b.type === "text");
    const text = block && "text" in block ? block.text : "";
    const parsed = parseJson(text);
    if (!parsed) continue;

    last = parsed;
    lastFindings = lintBriefing(parsed, { stageKey, meetingSubject: state.meetingSubject });
    const errors = briefingErrors(lastFindings);
    if (errors.length === 0) return parsed;

    console.warn(
      `[briefing] ${state.account}: regenerating, ${describeFindings(errors)}`,
    );
  }

  const remaining = briefingErrors(lastFindings);
  if (remaining.length > 0) {
    console.error(
      `[briefing] ${state.account}: SUPPRESSED after two attempts, ${describeFindings(remaining)}`,
    );
    return null;
  }
  return last;
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
