"use client";

import { useRouter, useSearchParams } from "next/navigation";

const KIND_OPTS = [
  { v: "", label: "All activity" },
  { v: "briefing", label: "Briefings" },
  { v: "recap", label: "Recaps" },
  { v: "no_show_draft", label: "No-show drafts" },
  { v: "digest", label: "Digests" },
  { v: "rolldog_write", label: "Rolldog writes" },
];

const RANGE_OPTS = [
  { v: "", label: "All time" },
  { v: "7d", label: "Last 7 days" },
  { v: "30d", label: "Last 30 days" },
  { v: "90d", label: "Last 90 days" },
];

export function ActivityFilterBar({ deals }: { deals: { id: string; account: string }[] }) {
  const router = useRouter();
  const sp = useSearchParams();
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(sp.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`/activity?${next.toString()}`);
  };
  return (
    <div className="mt-4 flex items-center gap-2 flex-wrap">
      <Sel value={sp.get("kind") ?? ""} onChange={(v) => setParam("kind", v)} opts={KIND_OPTS} />
      <Sel value={sp.get("range") ?? ""} onChange={(v) => setParam("range", v)} opts={RANGE_OPTS} />
      <Sel
        value={sp.get("deal") ?? ""}
        onChange={(v) => setParam("deal", v)}
        opts={[{ v: "", label: "All deals" }, ...deals.map((d) => ({ v: d.id, label: d.account }))]}
      />
    </div>
  );
}

function Sel({
  value,
  onChange,
  opts,
}: {
  value: string;
  onChange: (v: string) => void;
  opts: { v: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="text-[12px] border border-line rounded-md px-2 py-1.5 bg-white text-ink focus:outline-none focus:border-ink/30 max-w-[170px]"
    >
      {opts.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
