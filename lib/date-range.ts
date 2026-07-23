/**
 * Sybill-style date range resolution for the activity views. All calendar
 * boundaries (today / yesterday / this month / last month) are computed in the
 * pilot timezone (America/Chicago), because the server renders in UTC and naive
 * boundaries would land the day break at the wrong local hour. Rolling ranges
 * (last 24h / 7d / 30d / 6mo / 1yr) are timezone-agnostic offsets from now.
 */

export const TZ = "America/Chicago";

export type RangeKey =
  | "24h"
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "this_month"
  | "last_month"
  | "6mo"
  | "1yr"
  | "custom";

export const RANGE_LABELS: Record<RangeKey, string> = {
  "24h": "Last 24 hours",
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  this_month: "This month",
  last_month: "Last month",
  "6mo": "Last 6 months",
  "1yr": "Last year",
  custom: "Custom",
};

// A Date whose UTC fields hold the Chicago wall-clock time of `d`.
function wallClock(d: Date): Date {
  return new Date(d.toLocaleString("en-US", { timeZone: TZ }));
}
function offsetMs(d: Date): number {
  const wall = wallClock(d).getTime();
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return wall - utc;
}
function toUtc(wall: Date, ref: Date): Date {
  return new Date(wall.getTime() - offsetMs(ref));
}

function chicagoDayStart(d: Date): Date {
  const w = wallClock(d);
  w.setHours(0, 0, 0, 0);
  return toUtc(w, d);
}
function chicagoMonthStart(d: Date): Date {
  const w = wallClock(d);
  w.setDate(1);
  w.setHours(0, 0, 0, 0);
  return toUtc(w, d);
}

export type ResolvedRange = { sinceIso?: string; untilIso?: string; key: RangeKey };

export function resolveRange(
  key: string | undefined,
  from?: string,
  to?: string,
  now: Date = new Date(),
): ResolvedRange {
  const k = (key ?? "30d") as RangeKey;
  const ms = now.getTime();
  const day = 86400000;

  const rolling = (backMs: number): ResolvedRange => ({
    sinceIso: new Date(ms - backMs).toISOString(),
    untilIso: now.toISOString(),
    key: k,
  });

  switch (k) {
    case "24h":
      return rolling(day);
    case "7d":
      return rolling(7 * day);
    case "30d":
      return rolling(30 * day);
    case "6mo": {
      const w = wallClock(now);
      w.setMonth(w.getMonth() - 6);
      return { sinceIso: toUtc(w, now).toISOString(), untilIso: now.toISOString(), key: k };
    }
    case "1yr": {
      const w = wallClock(now);
      w.setFullYear(w.getFullYear() - 1);
      return { sinceIso: toUtc(w, now).toISOString(), untilIso: now.toISOString(), key: k };
    }
    case "today":
      return { sinceIso: chicagoDayStart(now).toISOString(), untilIso: now.toISOString(), key: k };
    case "yesterday": {
      const todayStart = chicagoDayStart(now);
      const yStart = chicagoDayStart(new Date(todayStart.getTime() - 12 * 3600000));
      return { sinceIso: yStart.toISOString(), untilIso: todayStart.toISOString(), key: k };
    }
    case "this_month":
      return { sinceIso: chicagoMonthStart(now).toISOString(), untilIso: now.toISOString(), key: k };
    case "last_month": {
      const thisMonth = chicagoMonthStart(now);
      const lastMonth = chicagoMonthStart(new Date(thisMonth.getTime() - 12 * 3600000));
      return { sinceIso: lastMonth.toISOString(), untilIso: thisMonth.toISOString(), key: k };
    }
    case "custom": {
      const since = from ? chicagoDayStart(new Date(`${from}T12:00:00Z`)) : undefined;
      const until = to ? new Date(chicagoDayStart(new Date(`${to}T12:00:00Z`)).getTime() + day) : undefined;
      return { sinceIso: since?.toISOString(), untilIso: until?.toISOString(), key: k };
    }
    default:
      return rolling(30 * day);
  }
}
