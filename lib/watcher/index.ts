/**
 * Watcher dataset registry + the volume generator.
 *
 * Each vertical config authors ~12 hero deals by hand (full alerts,
 * commitments, probability ledgers) and generates the rest of a realistic
 * ~100-opportunity book deterministically, so the pipeline reads Salesforce-
 * real without hand-writing 100 rows. Deterministic PRNG: same data on every
 * load, no hydration surprises.
 */

import type { DealForecast, WatcherDataset } from "./types";

export * from "./types";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so generated volume is stable across loads.
// ---------------------------------------------------------------------------
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)];
}

/** Generate volume (non-hero) forecasts: realistic funnel, deliberate mess. */
export function generateVolumeForecasts(args: {
  seed: number;
  count: number;
  reps: string[]; // display names, weighted by position (earlier = more deals)
  accountPrefixes: readonly string[];
  accountSuffixes: readonly string[];
  stages: ReadonlyArray<{ key: string; sharePct: number; baselinePct: number; label: string }>;
  amountRange: [number, number];
  idPrefix: string;
}): DealForecast[] {
  const r = rng(args.seed);
  const out: DealForecast[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < args.count; i++) {
    // Stage by share.
    let roll = r() * 100;
    let stage = args.stages[0];
    for (const s of args.stages) {
      if (roll < s.sharePct) {
        stage = s;
        break;
      }
      roll -= s.sharePct;
    }
    // Unique plausible account name.
    let account = "";
    do {
      account = `${pick(r, args.accountPrefixes)} ${pick(r, args.accountSuffixes)}`;
    } while (usedNames.has(account));
    usedNames.add(account);

    const amount = Math.round((args.amountRange[0] + r() * (args.amountRange[1] - args.amountRange[0])) / 500) * 500;
    const rep = args.reps[Math.floor(r() * args.reps.length)];

    // Rep prob: baseline +/- optimism noise; a slice of the book carries the
    // classic hygiene mess (stale end-of-month dates, inflated commits).
    const messy = r() < 0.28;
    const repProbPct = Math.min(95, Math.max(5, Math.round(stage.baselinePct + (messy ? 25 : 5) + (r() - 0.5) * 20)));
    const drift = messy ? -Math.round(8 + r() * 14) : Math.round((r() - 0.5) * 8);
    const drProbPct = Math.min(97, Math.max(3, repProbPct + drift));

    const daysOut = Math.round(10 + r() * 80);
    const close = new Date(Date.now() + daysOut * 86_400_000);
    const closeIso = close.toISOString().slice(0, 10);
    const drClose = new Date(close.getTime() + (drift < -8 ? 45 : 0) * 86_400_000).toISOString().slice(0, 10);

    const adjustments = messy
      ? [
          { label: "Close date not confirmed by the customer on any call", pts: Math.min(-4, Math.round(drift / 2)) },
          { label: "No dated next step on the record", pts: Math.max(-8, drift - Math.round(drift / 2)) },
        ]
      : drift >= 0
        ? [{ label: "Qualification confirmed on recent calls", pts: drift }]
        : [{ label: "Stage age above winning baseline", pts: drift }];

    const resolved = Math.min(97, drProbPct + (messy ? Math.abs(drift) : 4));
    out.push({
      dealId: `${args.idPrefix}-vol-${i + 1}`,
      account,
      rep,
      stageKey: stage.key,
      amountUsd: amount,
      repProbPct,
      repCloseDate: closeIso,
      baselinePct: stage.baselinePct,
      baselineLabel: `${stage.label} baseline`,
      adjustments,
      drProbPct,
      drCloseDate: drClose,
      resolvedProbPct: resolved,
      recoverableUsd: Math.round(((resolved - drProbPct) / 100) * amount),
      bucket: "watched",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY = new Map<string, () => WatcherDataset>();

export function registerWatcherDataset(slug: string, loader: () => WatcherDataset): void {
  REGISTRY.set(slug, loader);
}

const cache = new Map<string, WatcherDataset>();

export function getWatcherDataset(slug: string): WatcherDataset | null {
  if (cache.has(slug)) return cache.get(slug)!;
  const loader = REGISTRY.get(slug);
  if (!loader) return null;
  const ds = loader();
  cache.set(slug, ds);
  return ds;
}

// Derived helpers the views share.
export function totals(ds: WatcherDataset) {
  const pipeline = ds.forecasts.reduce((s, f) => s + f.amountUsd, 0);
  const repW = ds.forecasts.reduce((s, f) => s + (f.amountUsd * f.repProbPct) / 100, 0);
  const drW = ds.forecasts.reduce((s, f) => s + (f.amountUsd * f.drProbPct) / 100, 0);
  const recoverable = ds.forecasts.reduce((s, f) => s + f.recoverableUsd, 0);
  return { pipeline, repW: Math.round(repW), drW: Math.round(drW), recoverable };
}

export function bucketCounts(ds: WatcherDataset) {
  const needsYou = ds.forecasts.filter((f) => f.bucket === "needs_you").length;
  const handled = ds.forecasts.filter((f) => f.bucket === "being_handled").length;
  const watched = ds.forecasts.filter((f) => f.bucket === "watched").length;
  return { needsYou, handled, watched };
}
