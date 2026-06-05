"use client";

import Link from "next/link";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import { SIM_DEALS, type SimDeal } from "@/lib/onboarding-data";
import { useOnboardingState } from "@/lib/onboarding-state";

const MAX_PILOT_DEALS = 3;

export default function DealsPage() {
  const { state, update } = useOnboardingState();

  function toggle(id: string) {
    update((prev) => {
      const isSelected = prev.selectedDeals.includes(id);
      if (isSelected) {
        return {
          ...prev,
          selectedDeals: prev.selectedDeals.filter((x) => x !== id),
        };
      }
      if (prev.selectedDeals.length >= MAX_PILOT_DEALS) {
        return prev;
      }
      return { ...prev, selectedDeals: [...prev.selectedDeals, id] };
    });
  }

  const selectedCount = state.selectedDeals.length;
  const canContinue = selectedCount > 0;

  return (
    <OnboardingShell
      step={4}
      title="Choose your pilot deals."
      subtitle="Pick 1 to 3 deals to start. DealRipe will analyze these deals only. Your other deals stay untouched."
      footer={
        <div className="flex items-center gap-3">
          <Link
            href="/onboarding/team"
            className="text-[13px] font-semibold text-muted hover:text-ink transition"
          >
            Back
          </Link>
          <Link
            href={canContinue ? "/onboarding/complete" : "#"}
            aria-disabled={!canContinue}
            onClick={(e) => {
              if (!canContinue) e.preventDefault();
            }}
            className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl2 text-[14px] font-semibold transition ${
              canContinue
                ? "bg-ink text-white hover:bg-ink/90"
                : "bg-bg border border-line text-muted cursor-not-allowed"
            }`}
          >
            Finish setup
            <span aria-hidden>→</span>
          </Link>
        </div>
      }
    >
      <div className="bg-white rounded-xl2 border border-line overflow-hidden">
        <div className="px-5 py-3 border-b border-line bg-bg flex items-center justify-between">
          <span className="text-[12px] font-semibold text-ink">
            {SIM_DEALS.length} active deals on your account
          </span>
          <span className="text-[12px] text-muted">
            {selectedCount} of {MAX_PILOT_DEALS} selected
          </span>
        </div>
        <ul className="divide-y divide-line">
          {SIM_DEALS.map((d) => (
            <DealRow
              key={d.id}
              deal={d}
              selected={state.selectedDeals.includes(d.id)}
              capReached={
                selectedCount >= MAX_PILOT_DEALS &&
                !state.selectedDeals.includes(d.id)
              }
              onToggle={() => toggle(d.id)}
            />
          ))}
        </ul>
      </div>
    </OnboardingShell>
  );
}

function DealRow({
  deal,
  selected,
  capReached,
  onToggle,
}: {
  deal: SimDeal;
  selected: boolean;
  capReached: boolean;
  onToggle: () => void;
}) {
  const disabled = capReached;
  return (
    <li
      className={`px-5 py-3.5 flex items-center gap-4 transition ${
        selected ? "bg-accent/[0.04]" : ""
      }`}
    >
      <button
        onClick={onToggle}
        disabled={disabled}
        aria-pressed={selected}
        aria-label={`Select ${deal.account}`}
        className={`w-5 h-5 rounded border-2 shrink-0 transition flex items-center justify-center ${
          selected
            ? "bg-accent border-accent"
            : disabled
              ? "border-line bg-bg cursor-not-allowed"
              : "border-line bg-white hover:border-muted"
        }`}
      >
        {selected && (
          <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="white" strokeWidth="3">
            <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold text-ink">{deal.account}</div>
        <div className="text-[12px] text-muted mt-0.5">
          {deal.stage} · Closes {deal.close}
        </div>
      </div>
      <div className="text-[14px] font-bold text-ink shrink-0 text-right">
        {formatMoney(deal.arr)}
      </div>
    </li>
  );
}

function formatMoney(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${v}`;
}
