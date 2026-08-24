/**
 * How deals actually progressed, over any window.
 *
 * The daily snapshot series is the only record of what a deal looked like on a
 * past day, and until now nothing read it. This answers "how are deals moving
 * over 7, 30, 60 days" from the record rather than from the current state.
 *
 * IT USES snapshotChanged, NOT A BYTE COMPARISON. signals carries capturedAt,
 * written on every run, so a raw diff reports a change every day on every deal.
 * IFF Inc shows 47 changes in 48 days by raw comparison and 8 in truth. See
 * lib/snapshot-diff.ts.
 *
 *   npx tsx scripts/deal-progression.ts                 last 30 days
 *   npx tsx scripts/deal-progression.ts --days 7
 *   npx tsx scripts/deal-progression.ts --deal iff      one deal, day by day
 *
 * Read-only.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { changedFields, snapshotChanged } from "../lib/snapshot-diff";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Snap = { deal_id: string; snapshot_date: string; signals: Record<string, unknown> | null };

/**
 * The handful of fields a human reads as "the deal moved", rendered as the
 * DELTA rather than as two values.
 *
 * The first version printed String(v) on everything, so `gatesDealripe`, which
 * is an object, came out as "[object Object] to [object Object]", and
 * `answered`, which is a list of field keys, printed the whole list twice and
 * left the reader to spot the one addition. Both are the same mistake: showing
 * the states instead of the difference between them.
 */
function summarise(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const out: string[] = [];
  const differs = (k: string) => JSON.stringify(before[k]) !== JSON.stringify(after[k]);
  const scalar = (v: unknown) => (v === null || v === undefined || v === "" ? "none" : String(v));

  for (const [key, label] of [
    ["stage", "stage"],
    ["amount", "amount"],
    ["closeDate", "close date"],
  ] as Array<[string, string]>) {
    if (differs(key)) out.push(`${label} ${scalar(before[key])} to ${scalar(after[key])}`);
  }

  // Gate counts, not the objects that hold them.
  for (const [key, label] of [
    ["gatesRolldog", "rep checklist"],
    ["gatesDealripe", "gates from calls"],
  ] as Array<[string, string]>) {
    if (!differs(key)) continue;
    const n = (v: unknown) => {
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const c = o.confirmed ?? o.count ?? Object.keys(o).length;
        return typeof c === "number" ? String(c) : JSON.stringify(v).slice(0, 30);
      }
      return scalar(v);
    };
    out.push(`${label} ${n(before[key])} to ${n(after[key])}`);
  }

  // What was newly ANSWERED, which is the only interesting part of a list that
  // only ever grows.
  if (differs("answered")) {
    const list = (v: unknown): string[] =>
      Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").filter(Boolean) : [];
    const was = new Set(list(before.answered));
    const gained = list(after.answered).filter((x) => !was.has(x));
    const nowSet = new Set(list(after.answered));
    const lost = list(before.answered).filter((x) => !nowSet.has(x));
    if (gained.length > 0) out.push(`answered on a call: ${gained.join(", ")}`);
    // A field un-answering is rare and worth seeing rather than hiding.
    if (lost.length > 0) out.push(`no longer answered: ${lost.join(", ")}`);
  }

  // A read STATUS changing is us, not the deal, and saying so stops a reader
  // counting our own connectivity as deal movement.
  for (const key of ["rolldogRead", "salesforceRead"]) {
    if (differs(key)) out.push(`our ${key.replace("Read", "")} read went ${scalar(before[key])} to ${scalar(after[key])}`);
  }
  return out;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 30);
  const onlyDeal = arg("--deal");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const dealsRes = await db.from("deals").select("id, account, external_id, outcome_label").eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);
  let deals = (dealsRes.data ?? []) as Array<{ id: string; account: string; external_id: string | null; outcome_label: string | null }>;
  if (onlyDeal) {
    const q = onlyDeal.toLowerCase();
    deals = deals.filter((d) => d.account.toLowerCase().includes(q) || (d.external_id ?? "").toLowerCase().includes(q));
  }
  const byId = new Map(deals.map((d) => [d.id, d]));

  // Paged: 115 deals over 60 days is past the 1000-row default, and that cap
  // has silently truncated three separate readings of this database already.
  const snaps: Snap[] = [];
  for (let from = 0; ; from += 1000) {
    const page = await db
      .from("deal_signal_snapshots")
      .select("deal_id, snapshot_date, signals")
      .eq("tenant_id", tenantId)
      .gte("snapshot_date", since)
      .order("snapshot_date", { ascending: true })
      .range(from, from + 999);
    if (page.error) throw new Error(page.error.message);
    const rows = (page.data ?? []) as Snap[];
    snaps.push(...rows.filter((r) => byId.has(r.deal_id)));
    if (rows.length < 1000) break;
  }

  const byDeal = new Map<string, Snap[]>();
  for (const s of snaps) (byDeal.get(s.deal_id) ?? byDeal.set(s.deal_id, []).get(s.deal_id)!).push(s);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`HOW DEALS MOVED, last ${days} days`);
  console.log(`${"=".repeat(80)}\n`);

  if (onlyDeal) {
    for (const [dealId, series] of byDeal) {
      const d = byId.get(dealId)!;
      console.log(`${d.account}  (${series.length} daily snapshots)\n`);
      let prev: Snap | null = null;
      let moves = 0;
      for (const s of series) {
        if (prev && snapshotChanged(prev.signals, s.signals)) {
          moves += 1;
          const what = summarise(prev.signals ?? {}, s.signals ?? {});
          console.log(`  ${s.snapshot_date}  ${what.length > 0 ? what.join("; ") : changedFields(prev.signals, s.signals).join(", ")}`);
        }
        prev = s;
      }
      console.log(`\n  ${moves} real change(s) in ${series.length} days.`);
    }
    console.log("");
    return;
  }

  let moved = 0;
  let still = 0;
  const movers: Array<{ account: string; n: number; last: string }> = [];
  for (const [dealId, series] of byDeal) {
    const d = byId.get(dealId)!;
    if (d.outcome_label) continue;
    let n = 0;
    let last = "";
    for (let i = 1; i < series.length; i++) {
      if (snapshotChanged(series[i - 1].signals, series[i].signals)) {
        n += 1;
        last = series[i].snapshot_date;
      }
    }
    if (n > 0) {
      moved += 1;
      movers.push({ account: d.account, n, last });
    } else still += 1;
  }

  console.log(`  ${moved} deal(s) changed state at least once. ${still} did not move at all.\n`);
  console.log("MOST ACTIVE");
  for (const m of movers.sort((a, b) => b.n - a.n).slice(0, 12)) {
    console.log(`  ${String(m.n).padStart(3)} change(s)   ${m.account.slice(0, 30).padEnd(32)} last ${m.last}`);
  }
  console.log(`\n  A "change" excludes capturedAt and daysInStage, which move every day by construction.`);
  console.log(`  Counting those, every deal would appear to change daily and the series would say nothing.\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
