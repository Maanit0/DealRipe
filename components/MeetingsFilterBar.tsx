"use client";

import { useRouter, useSearchParams } from "next/navigation";

export type FilterOptions = {
  reps: string[];
  deals: { id: string; account: string }[];
};

const TYPE_OPTS = [
  { v: "", label: "All types" },
  { v: "discovery", label: "Discovery" },
  { v: "demo", label: "Demo" },
  { v: "proposal", label: "Proposal" },
  { v: "follow_up", label: "Follow-up" },
  { v: "existing_customer", label: "Customer" },
  { v: "internal", label: "Internal" },
];

const RANGE_OPTS = [
  { v: "", label: "All time" },
  { v: "7d", label: "Last 7 days" },
  { v: "30d", label: "Last 30 days" },
  { v: "90d", label: "Last 90 days" },
];

const STATUS_OPTS = [
  { v: "", label: "All meetings" },
  { v: "noshow", label: "No-shows only" },
  { v: "hide_noshow", label: "Hide no-shows" },
];

export function MeetingsFilterBar({ options }: { options: FilterOptions }) {
  const router = useRouter();
  const sp = useSearchParams();
  const view = sp.get("view") === "upcoming" ? "upcoming" : "recorded";

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(sp.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.push(`/meetings?${next.toString()}`);
  };

  const setView = (v: "recorded" | "upcoming") => {
    const next = new URLSearchParams(sp.toString());
    if (v === "upcoming") next.set("view", "upcoming");
    else next.delete("view");
    router.push(`/meetings?${next.toString()}`);
  };

  return (
    <div className="mt-4 flex items-center justify-between gap-4 flex-wrap">
      <div className="inline-flex rounded-lg border border-line overflow-hidden">
        <TabToggle label="Recorded" active={view === "recorded"} onClick={() => setView("recorded")} />
        <TabToggle label="Upcoming" active={view === "upcoming"} onClick={() => setView("upcoming")} />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {view === "recorded" && (
          <>
            <Sel value={sp.get("range") ?? ""} onChange={(v) => setParam("range", v)} opts={RANGE_OPTS} />
            <Sel value={sp.get("status") ?? ""} onChange={(v) => setParam("status", v)} opts={STATUS_OPTS} />
          </>
        )}
        <Sel value={sp.get("type") ?? ""} onChange={(v) => setParam("type", v)} opts={TYPE_OPTS} />
        <Sel
          value={sp.get("rep") ?? ""}
          onChange={(v) => setParam("rep", v)}
          opts={[{ v: "", label: "All reps" }, ...options.reps.map((r) => ({ v: r, label: r }))]}
        />
        <Sel
          value={sp.get("deal") ?? ""}
          onChange={(v) => setParam("deal", v)}
          opts={[{ v: "", label: "All deals" }, ...options.deals.map((d) => ({ v: d.id, label: d.account }))]}
        />
        <input
          defaultValue={sp.get("q") ?? ""}
          placeholder="Search participant…"
          onKeyDown={(e) => {
            if (e.key === "Enter") setParam("q", (e.target as HTMLInputElement).value.trim());
          }}
          className="text-[12px] border border-line rounded-md px-2.5 py-1.5 bg-white text-ink w-[150px] focus:outline-none focus:border-ink/30"
        />
      </div>
    </div>
  );
}

function TabToggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 text-[12px] font-medium transition ${
        active ? "bg-ink text-white" : "bg-white text-muted hover:text-ink"
      }`}
    >
      {label}
    </button>
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
      className="text-[12px] border border-line rounded-md px-2 py-1.5 bg-white text-ink focus:outline-none focus:border-ink/30 max-w-[160px]"
    >
      {opts.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
