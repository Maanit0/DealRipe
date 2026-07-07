/**
 * Turn a live Rolldog opportunity read (getDealRoom) into the briefing state:
 * which qualification fields Rolldog already has filled (known) and which are
 * blank (the blindspots / gaps to close on the call).
 *
 * It inverts each framework field's write_target: the same mapping the writer
 * uses to PUSH a field is used here to CHECK whether Rolldog already holds it.
 * Rolldog is typically sparse (reps don't fill these), so most fields come back
 * as gaps, which is exactly what makes the briefing pointed.
 */

import type { ExtractionMap } from "./briefing-magaya";
import type { Framework } from "./framework";
import type { DealRoom } from "./rolldog";

const METHOD_TO_KEY: Record<string, Exclude<keyof DealRoom, "core">> = {
  writeBudget: "budget",
  writeTimeline: "timeline",
  writeSituation: "situation",
  writeCompetitionNotes: "competition",
  writeParticipantNotes: "participant",
};

function isPresent(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/**
 * Build an ExtractionMap reflecting Rolldog's current state:
 *   - field's rolldog attribute is populated  -> { status: "Yes", answer }
 *   - populated attribute absent / null / ""   -> { status: "Unknown" } (gap)
 *   - field has no rolldog write_target        -> { status: "Unknown" } (gap)
 */
export function buildExtractionFromRolldog(
  framework: Framework,
  room: DealRoom,
): ExtractionMap {
  const out: ExtractionMap = {};
  for (const f of framework.fields) {
    const wt = f.writeTarget;
    if (!wt || wt.system !== "rolldog") {
      out[f.fieldKey] = { status: "Unknown" };
      continue;
    }
    const method = typeof wt.method === "string" ? wt.method : "";
    const attr = typeof wt.attr === "string" ? wt.attr : "";
    const key = METHOD_TO_KEY[method];
    const sub = key ? room[key] : null;
    const val =
      sub && attr ? (sub.attributes as Record<string, unknown>)[attr] : undefined;
    if (isPresent(val)) {
      out[f.fieldKey] = {
        status: "Yes",
        answer: String(val),
        evidence: "(from Rolldog)",
        confidence: 1,
      };
    } else {
      out[f.fieldKey] = { status: "Unknown" };
    }
  }
  return out;
}

/**
 * Merge live Rolldog context (baseline) with captured-call extractions.
 * Call-derived "Yes" wins (fresher, evidence-backed); otherwise fall back to
 * Rolldog's "Yes"; otherwise it's a gap. So briefings are grounded from day
 * zero on Rolldog and sharpen as calls are captured.
 */
export function mergeRolldogAndCalls(
  rolldog: ExtractionMap,
  calls: ExtractionMap,
): ExtractionMap {
  const out: ExtractionMap = {};
  const keys = new Set([...Object.keys(rolldog), ...Object.keys(calls)]);
  for (const k of keys) {
    const c = calls[k];
    const r = rolldog[k];
    if (c && c.status === "Yes") out[k] = c;
    else if (r && r.status === "Yes") out[k] = r;
    else out[k] = c ?? r ?? { status: "Unknown" };
  }
  return out;
}

/** Parse "SQL 3 - Proposal Validation (Prove)" -> "SQL3". Null if unknown. */
export function stageFromRolldog(room: DealRoom): string | null {
  const name = (room.core as Record<string, unknown>)["stage-name"];
  if (typeof name !== "string") return null;
  const m = name.match(/SQL\s*(\d)/i);
  return m ? `SQL${m[1]}` : null;
}
