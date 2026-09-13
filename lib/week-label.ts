/**
 * "Week of ..." for the Monday reports, anchored to the WEEK rather than to today.
 *
 * Both Monday artifacts labelled themselves with `new Date()`: the digest at
 * lib/digest-build.ts and the pipeline review at lib/activity-report.ts. That is
 * correct only by accident, because the crons ("0 11 * * 1" and "5 11 * * 1")
 * only ever fire on a Monday, so today IS the week start.
 *
 * Everything else printed a date that is not a week start. A preview run on
 * Saturday said "Week of September 12", which is what prompted this, and a
 * retry or a hand-run send on Tuesday would say "Week of September 15". A
 * leader reading "week of" expects a Monday, so any other day reads as a bug in
 * the data even when the data is fine.
 *
 * THE RULE, which is not simply "most recent Monday":
 *
 *   Mon to Fri   this week's Monday. A Tuesday retry of Monday's send still
 *                says Monday, which is the whole point.
 *   Sat and Sun  the COMING Monday. A weekend run is a rehearsal of the send
 *                that goes out on Monday, so it should carry Monday's label
 *                rather than the label of the week that just ended.
 *
 * The timezone is the customer's, not the server's. Magaya works Central and
 * the crons are UTC, so 11:00 UTC on Monday is 06:00 Monday in Chicago; reading
 * the weekday in UTC would be right today and wrong the moment the cron hour
 * moves. Same reasoning already recorded at lib/activity-report.ts.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function weekOfLabel(args?: {
  now?: Date;
  timeZone?: string;
  /** The pipeline review prints the year; the digest does not. */
  withYear?: boolean;
}): string {
  const now = args?.now ?? new Date();
  const timeZone = args?.timeZone ?? "America/Chicago";

  // The calendar date AND weekday as they are in the customer's timezone.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";

  const idx = WEEKDAYS.indexOf(part("weekday"));
  const year = Number(part("year"));
  const month = Number(part("month"));
  const day = Number(part("day"));
  if (idx < 0 || !year || !month || !day) {
    // Never throw for a label. A wrong-looking date is a smaller failure than a
    // digest that does not send, and the fallback is the old behaviour.
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "long",
      day: "numeric",
      ...(args?.withYear ? { year: "numeric" } : {}),
    }).format(now);
  }

  // Sunday (0) is one day before Monday; Saturday (6) is two.
  const delta = idx === 0 ? 1 : idx === 6 ? 2 : -(idx - 1);

  // Built and formatted in UTC on purpose. The date parts above are already the
  // customer's local calendar day, so applying a second timezone here would
  // shift it again.
  const monday = new Date(Date.UTC(year, month - 1, day + delta));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "long",
    day: "numeric",
    ...(args?.withYear ? { year: "numeric" } : {}),
  }).format(monday);
}
