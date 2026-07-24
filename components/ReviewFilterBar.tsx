"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { RANGE_LABELS, type RangeKey } from "@/lib/date-range";

const PRESETS: RangeKey[] = ["yesterday", "this_week", "last_week", "this_month", "last_month"];

export function ReviewFilterBar({ reps }: { reps: Array<{ email: string; name: string }> }) {
  const router = useRouter();
  const params = useSearchParams();
  const range = (params.get("range") ?? "this_week") as RangeKey;
  const netNew = params.get("netnew") === "1";
  const noShow = params.get("noshow") === "1";
  const tracked = params.get("tracked") === "1";
  const rep = params.get("rep") ?? "";
  const [from, setFrom] = useState(params.get("from") ?? "");
  const [to, setTo] = useState(params.get("to") ?? "");
  const [showCustom, setShowCustom] = useState(range === "custom");

  function push(next: Record<string, string | null>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v === null || v === "") sp.delete(k);
      else sp.set(k, v);
    }
    router.push(`/review?${sp.toString()}`);
  }

  const chip = (active: boolean) =>
    `text-[12px] px-2.5 py-1 rounded-full border transition ${
      active ? "bg-ink text-white border-ink" : "bg-white text-muted border-line hover:bg-bg"
    }`;

  return (
    <div className="mt-4 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {PRESETS.map((r) => (
          <button key={r} onClick={() => { setShowCustom(false); push({ range: r, from: null, to: null }); }} className={chip(range === r)}>
            {RANGE_LABELS[r]}
          </button>
        ))}
        <button onClick={() => setShowCustom((v) => !v)} className={chip(range === "custom")}>
          Custom
        </button>
        {showCustom && (
          <span className="flex items-center gap-1.5 ml-1">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="text-[12px] px-2 py-1 rounded-md border border-line bg-white text-ink" />
            <span className="text-[12px] text-muted">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="text-[12px] px-2 py-1 rounded-md border border-line bg-white text-ink" />
            <button onClick={() => push({ range: "custom", from, to })} disabled={!from || !to} className="text-[12px] px-2.5 py-1 rounded-md bg-accent text-white disabled:opacity-50">
              Apply
            </button>
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={() => push({ tracked: tracked ? null : "1" })} className={chip(tracked)}>Tracked by DealRipe</button>
        <button onClick={() => push({ netnew: netNew ? null : "1" })} className={chip(netNew)}>Net-new only</button>
        <button onClick={() => push({ noshow: noShow ? null : "1" })} className={chip(noShow)}>No-shows</button>
        {reps.map((r) => (
          <button key={r.email} onClick={() => push({ rep: rep === r.email ? null : r.email })} className={chip(rep === r.email)}>
            {r.name}
          </button>
        ))}
      </div>
    </div>
  );
}
