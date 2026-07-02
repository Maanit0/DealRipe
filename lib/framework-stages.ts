/**
 * Framework-driven stages and gates.
 *
 * Generalizes the SCOTSMAN-specific stage/gate logic in lib/scotsman.ts so
 * the UI can render ANY tenant's framework from its framework_fields +
 * stage_key. The Magaya account renders SQL1..SQL5; the TopSort demo keeps
 * using lib/scotsman.ts unchanged.
 *
 * A field is a "gate" for the stage named in its stage_key. A gate is met
 * when its extraction status is "Yes"; otherwise it is open.
 */

import type { Framework, FrameworkField } from "./framework";
import type { ExtractionResult } from "./scotsman";

export type FrameworkStage = {
  key: string;
  fields: FrameworkField[];
};

/** Numeric-aware ordering: SQL1 < SQL2 < ... ; falls back to string order. */
function stageRank(key: string): number {
  const m = key.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
}

/** Distinct stages present in the framework, in order, each with its fields. */
export function frameworkStages(framework: Framework): FrameworkStage[] {
  const byStage = new Map<string, FrameworkField[]>();
  for (const f of framework.fields) {
    if (!f.stageKey) continue; // unstaged fields are not gates
    const list = byStage.get(f.stageKey) ?? [];
    list.push(f);
    byStage.set(f.stageKey, list);
  }
  return [...byStage.entries()]
    .map(([key, fields]) => ({
      key,
      fields: [...fields].sort((a, b) => a.sortOrder - b.sortOrder),
    }))
    .sort((a, b) => stageRank(a.key) - stageRank(b.key) || a.key.localeCompare(b.key));
}

export type GateStatus = {
  met: number;
  total: number;
  openKeys: string[];
  metKeys: string[];
};

/** Gate completion for one stage against an extraction. */
export function stageGateStatus(
  stage: FrameworkStage,
  extraction: ExtractionResult,
): GateStatus {
  const openKeys: string[] = [];
  const metKeys: string[] = [];
  for (const f of stage.fields) {
    if (extraction[f.fieldKey]?.status === "Yes") metKeys.push(f.fieldKey);
    else openKeys.push(f.fieldKey);
  }
  return { met: metKeys.length, total: stage.fields.length, openKeys, metKeys };
}

/** The stage after the given key, or null if it is the last. */
export function nextStage(
  stages: FrameworkStage[],
  currentKey: string,
): FrameworkStage | null {
  const i = stages.findIndex((s) => s.key === currentKey);
  if (i < 0 || i >= stages.length - 1) return null;
  return stages[i + 1];
}

/** Overall confirmed-vs-total across all staged gates (for the "X of N" header). */
export function frameworkProgress(
  framework: Framework,
  extraction: ExtractionResult,
): { confirmed: number; total: number } {
  let confirmed = 0;
  let total = 0;
  for (const f of framework.fields) {
    if (!f.stageKey) continue;
    total += 1;
    if (extraction[f.fieldKey]?.status === "Yes") confirmed += 1;
  }
  return { confirmed, total };
}
