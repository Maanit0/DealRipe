"use client";

import Link from "next/link";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import {
  FRAMEWORK_META,
  MEDDIC_FIELDS,
  MEDDPICC_FIELDS,
  type FrameworkField,
  type FrameworkKey,
} from "@/lib/onboarding-data";
import { useOnboardingState } from "@/lib/onboarding-state";
import { SCOTSMAN_FIELDS } from "@/lib/scotsman";

const FRAMEWORK_ORDER: FrameworkKey[] = ["MEDDIC", "MEDDPICC", "SCOTSMAN", "CUSTOM"];

export default function FrameworkPage() {
  const { state, update } = useOnboardingState();

  function pick(key: FrameworkKey) {
    update((prev) => ({ ...prev, framework: key }));
  }

  const canContinue = !!state.framework;

  return (
    <OnboardingShell
      step={2}
      title="Configure your sales qualification framework."
      subtitle="DealRipe extracts the qualification fields your team already uses. Pick yours below or define a custom variation."
      footer={
        <div className="flex items-center gap-3">
          <Link
            href="/onboarding/connect"
            className="text-[13px] font-semibold text-muted hover:text-ink transition"
          >
            Back
          </Link>
          <Link
            href={canContinue ? "/onboarding/team" : "#"}
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
            Continue
            <span aria-hidden>→</span>
          </Link>
        </div>
      }
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {FRAMEWORK_ORDER.map((key) => (
          <FrameworkCard
            key={key}
            frameworkKey={key}
            selected={state.framework === key}
            onSelect={() => pick(key)}
          />
        ))}
      </div>

      {state.framework && (
        <div className="mt-10 bg-white rounded-xl2 border border-line overflow-hidden">
          <div className="px-5 py-4 border-b border-line flex items-center justify-between">
            <div>
              <div className="text-[15px] font-semibold text-ink">
                {FRAMEWORK_META[state.framework].label} fields
              </div>
              <div className="text-[12px] text-muted mt-0.5">
                {FRAMEWORK_META[state.framework].fieldCount}
              </div>
            </div>
          </div>
          <FrameworkFields frameworkKey={state.framework} />
        </div>
      )}
    </OnboardingShell>
  );
}

function FrameworkCard({
  frameworkKey,
  selected,
  onSelect,
}: {
  frameworkKey: FrameworkKey;
  selected: boolean;
  onSelect: () => void;
}) {
  const meta = FRAMEWORK_META[frameworkKey];
  return (
    <button
      onClick={onSelect}
      className={`text-left bg-white rounded-xl2 border p-5 transition ${
        selected
          ? "border-ink ring-2 ring-ink/10"
          : "border-line hover:border-muted/50"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[16px] font-semibold text-ink">{meta.label}</div>
          <div className="text-[11px] uppercase tracking-wider font-bold text-muted mt-1">
            {meta.fieldCount}
          </div>
        </div>
        {selected && (
          <span className="w-5 h-5 rounded-full bg-ink flex items-center justify-center shrink-0">
            <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="white" strokeWidth="3">
              <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}
      </div>
      <p className="mt-3 text-[13px] text-muted leading-snug">{meta.description}</p>
    </button>
  );
}

function FrameworkFields({ frameworkKey }: { frameworkKey: FrameworkKey }) {
  if (frameworkKey === "MEDDIC") {
    return <SimpleFieldTable fields={MEDDIC_FIELDS} />;
  }
  if (frameworkKey === "MEDDPICC") {
    return <SimpleFieldTable fields={MEDDPICC_FIELDS} />;
  }
  if (frameworkKey === "SCOTSMAN") {
    return <ScotsmanFieldTable />;
  }
  return (
    <div className="px-5 py-6 text-[13px] text-muted leading-relaxed">
      No fixed schema. We will work with your team during the pilot to define
      the exact fields you want extracted from every call.
    </div>
  );
}

function SimpleFieldTable({ fields }: { fields: FrameworkField[] }) {
  return (
    <ul className="divide-y divide-line">
      {fields.map((f, i) => (
        <li key={`${f.name}-${i}`} className="px-5 py-3 flex items-baseline gap-3">
          <span className="font-mono text-[10px] font-bold text-ink bg-bg border border-line rounded px-1.5 py-0.5 shrink-0">
            {f.letter}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold text-ink">{f.name}</div>
            <div className="text-[12px] text-muted mt-0.5">{f.description}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ScotsmanFieldTable() {
  const grouped = new Map<string, typeof SCOTSMAN_FIELDS>();
  SCOTSMAN_FIELDS.forEach((f) => {
    const arr = grouped.get(f.category) ?? [];
    arr.push(f);
    grouped.set(f.category, arr);
  });
  return (
    <div className="divide-y divide-line">
      {Array.from(grouped.entries()).map(([category, fields]) => (
        <div key={category} className="px-5 py-3">
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-2">
            {category}
          </div>
          <ul className="space-y-1.5">
            {fields.map((f) => (
              <li key={f.id} className="flex items-baseline gap-2">
                <span className="font-mono text-[10px] text-muted shrink-0 pt-0.5">
                  {f.id}
                </span>
                <span className="text-[12.5px] text-ink leading-snug">
                  {f.question}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
