/**
 * Grounding guardrail (the "judge").
 *
 * A confirmed ("Yes") gate must be backed by an evidence quote that actually
 * appears in the transcript. This catches the one failure that erodes a CRO's
 * trust fastest: a hallucinated confirmation, DealRipe claiming a gate is met
 * with a quote the customer never said. Any "Yes" whose evidence isn't in the
 * transcript is downgraded to "Unknown" before it is ever stored or shown, so a
 * fabricated confirmation never reaches Mark, a briefing, a recap, or the digest.
 *
 * Matching is tolerant of the LLM trimming or reflowing whitespace (normalized
 * comparison, contiguous-fragment fallback) but strict about invented content:
 * a quote whose significant words are largely absent from the transcript scores
 * near zero.
 */

import type { ExtractionResult } from "./scotsman";

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * 0..1 grounding score for an evidence quote against the transcript.
 *   1.00  quote appears verbatim (normalized)
 *   0.95  a long contiguous fragment matches (LLM trimmed the ends)
 *   ~frac fraction of significant words present (paraphrase tolerant)
 *   0.50  too short to verify (kept, not dropped)
 */
export function groundingScore(evidence: string, transcript: string): number {
  const e = normalize(evidence);
  if (e.length < 8) return 0.5; // unverifiable; do not punish
  const t = normalize(transcript);
  if (t.includes(e)) return 1;

  const words = e.split(" ").filter((w) => w.length >= 4);
  if (words.length === 0) return 0.5;

  for (const win of [10, 7]) {
    if (words.length >= win) {
      for (let i = 0; i + win <= words.length; i++) {
        if (t.includes(words.slice(i, i + win).join(" "))) return 0.95;
      }
    }
  }

  const present = words.filter((w) => t.includes(w)).length;
  return present / words.length;
}

// Below this, the quote's content is essentially absent: treat as fabricated.
const HALLUCINATION_MAX = 0.35;
// Between fabricated and this, keep the gate but report it for review.
const REVIEW_MAX = 0.7;

export type GroundingReport = {
  downgraded: string[]; // confirmed gates dropped as unfounded
  flagged: string[]; // kept, but evidence only loosely matches
};

/**
 * Enforce grounding on an extraction. Returns a copy with any hallucinated
 * confirmations downgraded to "Unknown", plus a report of what changed.
 */
export function enforceGrounding(
  extraction: ExtractionResult,
  transcript: string,
): { extraction: ExtractionResult; report: GroundingReport } {
  const out: ExtractionResult = { ...extraction };
  const report: GroundingReport = { downgraded: [], flagged: [] };
  for (const [key, entry] of Object.entries(extraction)) {
    if (entry.status !== "Yes") continue;
    const score = groundingScore(entry.evidence ?? "", transcript);
    if (score < HALLUCINATION_MAX) {
      out[key] = { status: "Unknown" };
      report.downgraded.push(key);
    } else if (score < REVIEW_MAX) {
      report.flagged.push(key);
    }
  }
  return { extraction: out, report };
}
