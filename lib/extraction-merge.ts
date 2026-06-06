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
 * Per-field rules (updated 2026-06-06 — deals evolve, so newer
 * customer statements supersede older ones; full per-run history
 * lives in extraction_runs.raw_response so nothing is lost by
 * overwriting):
 *
 *   incoming = Yes,     prior = Yes:        OVERWRITE prior payload with
 *                                            incoming (answer, evidence,
 *                                            confidence) and stamp
 *                                            lastUpdatedFromCallId.
 *                                            Status unchanged (no entry
 *                                            in changedIds).
 *   incoming = Yes,     prior = No/Unknown: incoming wins, status flips.
 *   incoming = No,      prior = Yes:        KEEP prior Yes payload, stamp
 *                                            lastUpdatedFromCallId. A
 *                                            deflection on a later call
 *                                            does not erase established
 *                                            evidence, but the call did
 *                                            observe the field.
 *   incoming = No,      prior = No:         Keep No (status unchanged).
 *   incoming = No,      prior = Unknown:    Incoming wins, status flips
 *                                            (Unknown -> No).
 *   incoming = Unknown:                      Never touches the field.
 *                                            "Topic did not come up" is
 *                                            not a field touch.
 *
 * changedIds tracks status flips only. Yes->Yes overwrites are not in
 * changedIds because status didn't change — the diagnostic log keeps
 * fields_observed (all touches) and state_changes (status flips)
 * separate so an operator can see both.
 *
 * lastUpdatedFromCallId is tagged on every Yes branch (incoming wins,
 * prior wins, doesn't matter) when callId is non-empty. transcript-sync
 * needs this so the row stamping is consistent with "this call touched
 * this field". Note: the DB upsert in writeAuditTrail uses the loop's
 * callUuid directly for last_updated_from_call_id, so this tag is
 * primarily for the client-side ExtractView flash animation; the two
 * paths happen to converge.
 */
export function mergeExtraction(
  framework: MergeFramework,
  prior: ExtractionResult,
  incoming: ExtractionResult,
  callId: string,
): { merged: ExtractionResult; changedIds: string[] } {
  const merged: ExtractionResult = {};
  const changedIds: string[] = [];

  function tagYes(entry: FieldExtraction): FieldExtraction {
    if (entry.status === "Yes" && callId) {
      return { ...entry, lastUpdatedFromCallId: callId };
    }
    return entry;
  }

  for (const f of framework.fields) {
    const key = f.fieldKey;
    const p: FieldExtraction = prior[key] ?? { status: "Unknown" };
    const n: FieldExtraction = incoming[key] ?? { status: "Unknown" };

    // Unknown incoming never touches the field.
    if (n.status === "Unknown") {
      merged[key] = p;
      continue;
    }

    // No incoming vs Yes prior: keep the Yes payload, stamp the callId.
    if (n.status === "No" && p.status === "Yes") {
      merged[key] = tagYes(p);
      // Status unchanged; not a state flip.
      continue;
    }

    // Yes incoming wins over anything (overwrites prior Yes payload too).
    if (n.status === "Yes") {
      merged[key] = tagYes(n);
      // changedIds tracks status flips only. Yes->Yes is a payload
      // overwrite, not a status flip.
      if (p.status !== "Yes") {
        changedIds.push(key);
      }
      continue;
    }

    // n.status === "No" and p.status in {No, Unknown}.
    merged[key] = n;
    if (p.status !== "No") {
      changedIds.push(key);
    }
  }

  return { merged, changedIds };
}
