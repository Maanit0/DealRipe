import type { ExtractionResult, FieldExtraction } from "./scotsman";

/**
 * Minimal framework shape this module needs. Compatible with both
 * lib/framework.ts (server-side, DB-loaded) and the
 * SCOTSMAN_AS_FRAMEWORK constant in scotsman.ts (client-side).
 */
type MergeFrameworkField = { fieldKey: string };
type MergeFramework = { fields: ReadonlyArray<MergeFrameworkField> };

/**
 * Merge a new extraction into a prior extraction.
 *
 * Rules:
 *   - Prior Yes is never demoted (immutable once confirmed).
 *   - Prior No → new Yes  : promote, mark as changed.
 *   - Prior Unknown → new Yes or No: promote, mark as changed.
 *   - Newly-promoted Yes entries are tagged with `lastUpdatedFromCallId`
 *     when callId is non-empty.
 *
 * Iterates the supplied framework's field list, not a hardcoded SCOTSMAN
 * list. Callers pass:
 *   - server: Framework loaded via lib/framework.ts (matches the deal)
 *   - client: SCOTSMAN_AS_FRAMEWORK from lib/scotsman.ts (topsort demo)
 */
export function mergeExtraction(
  framework: MergeFramework,
  prior: ExtractionResult,
  incoming: ExtractionResult,
  callId: string,
): { merged: ExtractionResult; changedIds: string[] } {
  const merged: ExtractionResult = {};
  const changedIds: string[] = [];

  function tagIfYes(entry: FieldExtraction): FieldExtraction {
    if (entry.status === "Yes" && callId) {
      return { ...entry, lastUpdatedFromCallId: callId };
    }
    return entry;
  }

  for (const f of framework.fields) {
    const key = f.fieldKey;
    const p: FieldExtraction = prior[key] ?? { status: "Unknown" };
    const n: FieldExtraction = incoming[key] ?? { status: "Unknown" };

    if (p.status === "Yes") {
      merged[key] = p;
      continue;
    }

    if (p.status === "No") {
      if (n.status === "Yes") {
        merged[key] = tagIfYes(n);
        changedIds.push(key);
      } else {
        merged[key] = p;
      }
      continue;
    }

    if (n.status === "Yes") {
      merged[key] = tagIfYes(n);
      changedIds.push(key);
    } else if (n.status === "No") {
      merged[key] = n;
      changedIds.push(key);
    } else {
      merged[key] = p;
    }
  }

  return { merged, changedIds };
}
