import {
  SCOTSMAN_FIELDS,
  type ExtractionResult,
  type FieldExtraction,
} from "./scotsman";

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
 * Used both client-side (UI render + flash animation) and server-side
 * (audit-trail upsert into field_extractions).
 */
export function mergeExtraction(
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

  for (const f of SCOTSMAN_FIELDS) {
    const p: FieldExtraction = prior[f.id] ?? { status: "Unknown" };
    const n: FieldExtraction = incoming[f.id] ?? { status: "Unknown" };

    if (p.status === "Yes") {
      merged[f.id] = p;
      continue;
    }

    if (p.status === "No") {
      if (n.status === "Yes") {
        merged[f.id] = tagIfYes(n);
        changedIds.push(f.id);
      } else {
        merged[f.id] = p;
      }
      continue;
    }

    if (n.status === "Yes") {
      merged[f.id] = tagIfYes(n);
      changedIds.push(f.id);
    } else if (n.status === "No") {
      merged[f.id] = n;
      changedIds.push(f.id);
    } else {
      merged[f.id] = p;
    }
  }

  return { merged, changedIds };
}
