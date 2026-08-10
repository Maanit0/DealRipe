/**
 * Microsoft Graph timestamps, parsed the one correct way.
 *
 * Graph returns event times as a naive local-to-the-event-timezone string with
 * no offset, like "2026-08-11T20:00:00.0000000", alongside a separate timeZone
 * field which is UTC by default. JavaScript parses a string in that shape as
 * LOCAL time, so `new Date(ev.start.dateTime)` silently shifts every meeting by
 * the reader's UTC offset.
 *
 * That shift is invisible when it is small and catastrophic when it is not: the
 * scheduling path appends "Z" and gets it right, while every diagnostic script
 * printed the UTC clock face and made a 3pm Central call look like an 8pm one.
 * Two readings of the same calendar disagreeing is how a rep stops trusting
 * both. So there is exactly one parser, here, and callers use it.
 */

/** Magaya's reps work Central. Meeting subjects are written in CST/CDT. */
export const MAGAYA_TZ = "America/Chicago";

/** A Graph dateTime (naive UTC) as a real instant. Returns null if unparseable. */
export function graphInstant(dateTime: string | null | undefined): Date | null {
  if (!dateTime) return null;
  const s = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(dateTime) ? dateTime : `${dateTime}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A Graph dateTime as a canonical ISO string, for storing and for row lookup. */
export function graphIso(dateTime: string | null | undefined): string | null {
  return graphInstant(dateTime)?.toISOString() ?? null;
}

/**
 * A Graph dateTime rendered in the rep's working timezone.
 *
 * Always pass an explicit timeZone. Defaulting to the reader's machine means
 * the same script prints different times for me and for Mark, and neither of us
 * can tell which one the rep will actually see.
 */
export function formatMeetingTime(
  dateTime: string | null | undefined,
  timeZone: string = MAGAYA_TZ,
): string {
  const d = graphInstant(dateTime);
  if (!d) return "(no time)";
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  });
}
