"use client";

import Link from "next/link";
import { useState } from "react";
import { OnboardingShell } from "@/components/onboarding/OnboardingShell";
import {
  CATEGORY_LABELS,
  INTEGRATIONS,
  type Integration,
  type IntegrationCategory,
} from "@/lib/onboarding-data";
import {
  allRequiredCategoriesConnected,
  useOnboardingState,
} from "@/lib/onboarding-state";

const SIM_USER = "Mike Rogers";

const CATEGORY_ORDER: IntegrationCategory[] = [
  "call_recording",
  "crm",
  "communication",
];

export default function ConnectPage() {
  const { state, update } = useOnboardingState();
  const [pending, setPending] = useState<Set<string>>(new Set());

  function connect(id: string) {
    setPending((prev) => new Set(prev).add(id));
    setTimeout(() => {
      update((prev) => ({
        ...prev,
        connections: {
          ...prev.connections,
          [id]: {
            user: SIM_USER,
            connectedAt: new Date().toISOString(),
          },
        },
      }));
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 1500);
  }

  const canContinue = allRequiredCategoriesConnected(state);

  return (
    <OnboardingShell
      step={1}
      title="Connect your data sources."
      subtitle="DealRipe reads from your existing tools. Connect each source so we can extract qualification fields and surface blind spots automatically."
      footer={
        <Link
          href={canContinue ? "/onboarding/framework" : "#"}
          aria-disabled={!canContinue}
          className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl2 text-[14px] font-semibold transition ${
            canContinue
              ? "bg-ink text-white hover:bg-ink/90"
              : "bg-bg border border-line text-muted cursor-not-allowed"
          }`}
          onClick={(e) => {
            if (!canContinue) e.preventDefault();
          }}
        >
          Continue
          <span aria-hidden>→</span>
        </Link>
      }
    >
      <div className="space-y-10">
        {CATEGORY_ORDER.map((category) => (
          <CategorySection
            key={category}
            category={category}
            integrations={INTEGRATIONS.filter((i) => i.category === category)}
            connections={state.connections}
            pending={pending}
            onConnect={connect}
          />
        ))}
      </div>
    </OnboardingShell>
  );
}

function CategorySection({
  category,
  integrations,
  connections,
  pending,
  onConnect,
}: {
  category: IntegrationCategory;
  integrations: Integration[];
  connections: Record<string, { user: string; connectedAt: string }>;
  pending: Set<string>;
  onConnect: (id: string) => void;
}) {
  return (
    <section>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-4">
        {CATEGORY_LABELS[category]}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {integrations.map((i) => (
          <IntegrationCard
            key={i.id}
            integration={i}
            connection={connections[i.id]}
            isPending={pending.has(i.id)}
            onConnect={() => onConnect(i.id)}
          />
        ))}
      </div>
    </section>
  );
}

function IntegrationCard({
  integration,
  connection,
  isPending,
  onConnect,
}: {
  integration: Integration;
  connection: { user: string; connectedAt: string } | undefined;
  isPending: boolean;
  onConnect: () => void;
}) {
  const isConnected = !!connection;

  return (
    <div
      className={`bg-white rounded-xl2 border p-5 flex flex-col gap-4 transition ${
        isConnected ? "border-accent/40" : "border-line"
      }`}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center text-white font-bold text-[14px] shrink-0"
          style={{ backgroundColor: integration.brandColor }}
          aria-hidden
        >
          {integration.brandLetter}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-ink">{integration.name}</div>
          <p className="text-[12px] text-muted leading-snug mt-1">
            {integration.description}
          </p>
        </div>
      </div>

      <div className="mt-auto pt-2">
        {isConnected ? (
          <div className="flex items-center gap-2 text-[12px]">
            <span className="w-4 h-4 rounded-full bg-accent flex items-center justify-center shrink-0">
              <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="none" stroke="white" strokeWidth="3">
                <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-ink font-semibold">Connected as {connection!.user}</div>
              <div className="text-muted">Last sync: just now</div>
            </div>
          </div>
        ) : isPending ? (
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Spinner />
            <span>Connecting...</span>
          </div>
        ) : (
          <button
            onClick={onConnect}
            className="w-full px-3 py-2 rounded-lg border border-line text-[13px] font-semibold text-ink hover:bg-bg transition"
          >
            Connect
          </button>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="w-3.5 h-3.5 animate-spin text-muted"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
