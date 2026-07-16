/**
 * Deterministic "where this deal stands" summary, derived from the framework +
 * current extraction the deal page already loads. No LLM, no storage: it's a
 * read-side rollup so a sales leader gets the glance before the 27-gate audit.
 *
 *   - confirmed / total gates
 *   - how far the signal reaches (highest stage with any confirmed gate) vs the
 *     deal's nominal stage, which surfaces "advanced but with gaps beneath"
 *   - the top open gaps beneath where the deal has already progressed (the ones
 *     that actually matter), and whether a firm next step was captured
 */

import type { Framework } from "./framework";
import type { ExtractionResult } from "./scotsman";
import { frameworkProgress, frameworkStages, stageGateStatus } from "./framework-stages";

export type DealStateGap = { fieldKey: string; label: string; stageKey: string };

export type DealState = {
  confirmed: number;
  total: number;
  /** The deal's nominal stage (from CRM/seed). */
  stageKey: string;
  /** Highest stage that has at least one confirmed gate, i.e. how far the
   *  captured signal actually reaches. Null if nothing is confirmed. */
  reachedStageKey: string | null;
  /** Open gates at or below the reached stage: gaps beneath where the deal has
   *  already moved, which is where the real risk sits. */
  topGaps: DealStateGap[];
  /** The captured "Next Step" answer, if any; null flags no firm next step. */
  nextStepAnswer: string | null;
};

function rank(key: string): number {
  const m = key.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

export function deriveDealState(
  framework: Framework,
  extraction: ExtractionResult,
  stageKey: string,
): DealState {
  const { confirmed, total } = frameworkProgress(framework, extraction);
  const stages = frameworkStages(framework);

  let reachedStageKey: string | null = null;
  for (const s of stages) {
    if (stageGateStatus(s, extraction).met > 0) reachedStageKey = s.key;
  }
  const reachedRank = reachedStageKey ? rank(reachedStageKey) : -1;

  const topGaps: DealStateGap[] = [];
  for (const s of stages) {
    if (reachedRank >= 0 && rank(s.key) > reachedRank) break;
    for (const key of stageGateStatus(s, extraction).openKeys) {
      const field = s.fields.find((f) => f.fieldKey === key);
      if (field) topGaps.push({ fieldKey: key, label: field.label, stageKey: s.key });
    }
  }

  let nextStepAnswer: string | null = null;
  for (const f of framework.fields) {
    const e = extraction[f.fieldKey];
    if (/next step/i.test(f.label) && e?.status === "Yes") {
      nextStepAnswer = e.answer;
      break;
    }
  }

  return { confirmed, total, stageKey, reachedStageKey, topGaps: topGaps.slice(0, 5), nextStepAnswer };
}

/**
 * The stage to brief/qualify against. When a CRM stage exists it's the floor,
 * but if the calls have already captured signal at a HIGHER stage (common when
 * a deal isn't in Rolldog, or Rolldog is stale, so reps never logged the real
 * progress), we use what the calls show. This stops briefings from asking SQL1
 * basics on a deal that's demonstrably at SQL3/SQL4.
 */
export function inferStageKey(
  framework: Framework,
  extraction: ExtractionResult,
  fallbackStageKey: string,
): string {
  const { reachedStageKey } = deriveDealState(framework, extraction, fallbackStageKey);
  if (!reachedStageKey) return fallbackStageKey;
  return rank(reachedStageKey) > rank(fallbackStageKey) ? reachedStageKey : fallbackStageKey;
}
