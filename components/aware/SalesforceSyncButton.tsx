"use client";

import { useState } from "react";
import {
  DUCT_ORDER,
  SALESFORCE_FIELD_MAP,
  type AwareDeal,
} from "@/lib/aware-data";

type Phase = "idle" | "syncing" | "synced";

export function SalesforceSyncButton({ deal }: { deal: AwareDeal }) {
  const [phase, setPhase] = useState<Phase>("idle");

  function sync() {
    if (phase !== "idle") return;
    setPhase("syncing");
    setTimeout(() => setPhase("synced"), 1700);
  }

  if (phase === "synced") {
    return (
      <div className="bg-white rounded-xl2 shadow-card border border-accent/40 p-5">
        <div className="flex items-center gap-3 mb-3">
          <span className="w-6 h-6 rounded-full bg-accent flex items-center justify-center shrink-0">
            <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="none" stroke="white" strokeWidth="3">
              <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <div className="text-[14px] font-semibold text-ink">
              Synced to Salesforce
            </div>
            <div className="text-[12px] text-muted">
              4 fields updated on Aware__Opportunity__{deal.id}
            </div>
          </div>
        </div>
        <ul className="text-[12px] text-muted space-y-1 font-mono pl-9">
          {DUCT_ORDER.map((k) => (
            <li key={k}>
              <span className="text-ink font-semibold">
                {SALESFORCE_FIELD_MAP[k]}
              </span>{" "}
              <span className="text-muted">=</span>{" "}
              <span className="text-ink">{deal.gates[k].status}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (phase === "syncing") {
    return (
      <div className="bg-white rounded-xl2 shadow-card border border-line p-5 flex items-center gap-3">
        <Spinner />
        <div>
          <div className="text-[14px] font-semibold text-ink">
            Syncing 4 DUCT fields to Salesforce...
          </div>
          <div className="text-[12px] text-muted">
            Writing to {deal.account} opportunity record.
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={sync}
      className="w-full bg-white rounded-xl2 shadow-card border border-line p-5 text-left hover:border-ink/40 transition group"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold text-ink">
            Sync to Salesforce
          </div>
          <div className="text-[12px] text-muted mt-0.5">
            Write all four DUCT fields with evidence quotes back to{" "}
            {deal.account}.
          </div>
        </div>
        <span className="text-[14px] font-bold text-accent shrink-0 group-hover:translate-x-1 transition-transform" aria-hidden>
          →
        </span>
      </div>
    </button>
  );
}

function Spinner() {
  return (
    <svg
      className="w-4 h-4 animate-spin text-muted shrink-0"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
