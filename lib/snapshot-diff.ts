/**
 * Did a deal's state actually change between two daily snapshots?
 *
 * WHY THIS IS NOT JUST !==
 *
 * deal_signal_snapshots.signals carries `capturedAt`, a timestamp written on
 * every run. So a byte comparison of two consecutive snapshots reports a change
 * every single day, on every deal, forever. Measured on IFF Inc, 2026-08-24: 47
 * "changes" across 48 days by raw comparison, and 8 once capturedAt is removed.
 *
 * Eight is the real number and it is a genuinely useful series. Forty-seven is
 * noise that would make any change detection, any "what moved this week", and
 * any learning loop over this table conclude that everything changes constantly
 * and therefore that nothing means anything.
 *
 * This is the same class of bug as reading our own refusal as a CRM saying no:
 * a field we write ourselves being mistaken for a fact about the deal.
 *
 * VOLATILE FIELDS, and why each is excluded:
 *
 *   capturedAt   when WE ran, not when anything happened. Pure noise.
 *   daysInStage  increments by one every day by definition. A deal sitting
 *                still is not changing, and counting it as change means a
 *                stalled deal looks maximally active, which is backwards.
 */

/** Written by us or by the calendar, not by the deal. */
const VOLATILE = new Set(["capturedAt", "daysInStage"]);

function stable(signals: unknown): string {
  if (!signals || typeof signals !== "object") return "";
  const copy: Record<string, unknown> = {};
  // Sorted, so a re-ordered jsonb round trip is not mistaken for a change.
  for (const k of Object.keys(signals as Record<string, unknown>).sort()) {
    if (VOLATILE.has(k)) continue;
    copy[k] = (signals as Record<string, unknown>)[k];
  }
  return JSON.stringify(copy);
}

export function snapshotChanged(a: unknown, b: unknown): boolean {
  return stable(a) !== stable(b);
}

/** The fields that genuinely differ, for saying WHAT moved rather than THAT it did. */
export function changedFields(a: unknown, b: unknown): string[] {
  const A = (a ?? {}) as Record<string, unknown>;
  const B = (b ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(A), ...Object.keys(B)])]
    .filter((k) => !VOLATILE.has(k))
    .filter((k) => JSON.stringify(A[k]) !== JSON.stringify(B[k]))
    .sort();
}
