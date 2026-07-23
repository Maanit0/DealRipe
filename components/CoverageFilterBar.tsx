"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { RANGE_LABELS, type RangeKey } from "@/lib/date-range";

const PRESETS: RangeKey[] = [
  "24h",
  "today",
  "yesterday",
  "7d",
  "30d",
  "this_month",
  "last_month",
  "6mo",
  "1yr",
];

export function CoverageFilterBar() {
  const router = useRouter();
  const params = useSearchParams();
  const current = (params.get("range") ?? "30d") as RangeKey;
  const view = params.get("view") ?? "coverage";
  const [showCustom, setShowCustom] = useState(current === "custom");
  const [from, setFrom] = useState(params.get("from") ?? "");
  const [to, setTo] = useState(params.get("to") ?? "");

  function apply(next: Partial<{ range: string; from: string; to: string }>) {
    const sp = new URLSearchParams(params.toString());
    sp.set("view", view);
    if (next.range) sp.set("range", next.range);
    if (next.from !== undefined) next.from ? sp.set("from", next.from) : sp.delete("from");
    if (next.to !== undefined) next.to ? sp.set("to", next.to) : sp.delete("to");
    if (next.range && next.range !== "custom") {
      sp.delete("from");
      sp.delete("to");
    }
    router.push(`/activity?${sp.toString()}`);
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-1.5">
      {PRESETS.map((r) => (
        <button
          key={r}
          onClick={() => {
            setShowCustom(false);
            apply({ range: r });
          }}
          className={`text-[12px] px-2.5 py-1 rounded-full border transition ${
            current === r
              ? "bg-ink text-white border-ink"
              : "bg-white text-muted border-line hover:bg-bg"
          }`}
        >
          {RANGE_LABELS[r]}
        </button>
      ))}
      <button
        onClick={() => setShowCustom((s) => !s)}
        className={`text-[12px] px-2.5 py-1 rounded-full border transition ${
          current === "custom" ? "bg-ink text-white border-ink" : "bg-white text-muted border-line hover:bg-bg"
        }`}
      >
        Custom
      </button>

      {showCustom && (
        <div className="flex items-center gap-1.5 ml-1">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="text-[12px] px-2 py-1 rounded-md border border-line bg-white text-ink"
          />
          <span className="text-[12px] text-muted">to</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="text-[12px] px-2 py-1 rounded-md border border-line bg-white text-ink"
          />
          <button
            onClick={() => apply({ range: "custom", from, to })}
            disabled={!from || !to}
            className="text-[12px] px-2.5 py-1 rounded-md bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
