"use client";

import { useState } from "react";

export type DealTab = { key: string; label: string };

/**
 * Tabbed section for the deal page: Overview / Signals & Risk / Progress /
 * Change Log. Panels are pre-rendered server content passed in as nodes, so the
 * data loading stays on the server and this only handles the switch.
 */
export function DealTabs({ tabs, panels }: { tabs: DealTab[]; panels: Record<string, React.ReactNode> }) {
  const [active, setActive] = useState(tabs[0]?.key ?? "");
  return (
    <div>
      <div className="flex items-center gap-1 border-b border-line overflow-x-auto">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActive(t.key)}
            className={`shrink-0 text-[13px] px-4 py-2.5 -mb-px border-b-2 transition ${
              active === t.key
                ? "border-ink text-ink font-medium"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-5">{panels[active]}</div>
    </div>
  );
}
