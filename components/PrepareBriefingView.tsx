"use client";

import { useEffect, useRef, useState } from "react";
import {
  SCOTSMAN_FIELDS,
  type ExtractionResult,
  type Stage,
} from "@/lib/scotsman";
import type { CallRecord, Deal } from "@/lib/seed-data";
import { DealHeaderCard } from "./DealHeaderCard";
import { useDemoState } from "./DemoStateProvider";

type Briefing = {
  callObjective: string;
  topQuestions: { fieldId: string; question: string }[];
  nextStepCommitment: string;
  whatsAtRisk: string;
};

type Props = {
  deal: Deal;
  stage: Stage;
};

const LOADING_FLOOR_MS = 4000;

export function PrepareBriefingView({ deal, stage }: Props) {
  const { getDealState } = useDemoState();
  const initialState = getDealState(deal.id);

  const [extraction] = useState<ExtractionResult>(
    initialState?.extraction ?? deal.extraction,
  );
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const hasRunRef = useRef(false);

  useEffect(() => {
    if (hasRunRef.current) return;
    hasRunRef.current = true;
    generateBriefing(extraction);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function generateBriefing(ext: ExtractionResult) {
    setLoading(true);
    setErrorMsg(null);
    const floor = new Promise<void>((r) => setTimeout(r, LOADING_FLOOR_MS));
    try {
      const [response] = await Promise.all([
        fetch("/api/prepare-briefing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dealId: deal.id, extraction: ext }),
        }),
        floor,
      ]);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setErrorMsg(body?.error || "Briefing failed. Try again.");
        setLoading(false);
        return;
      }
      const data = (await response.json()) as Briefing;
      setBriefing(data);
      setLoading(false);
    } catch {
      setErrorMsg("Network error. Try again.");
      setLoading(false);
    }
  }

  const contextCall = getMostRecentExtractionCall(deal, extraction);
  const contextDateLabel = contextCall ? formatDate(contextCall.date) : null;

  return (
    <div className="space-y-5">
      <DealHeaderCard deal={deal} stage={stage} extractionOverride={extraction} />

      <div>
        <h2 className="text-[18px] font-semibold text-ink">
          Briefing for next call · {deal.account}
        </h2>
        <p className="text-[12px] text-muted mt-0.5">
          Prepared from current Opportunity Control state
          {contextDateLabel ? ` · Last extracted ${contextDateLabel}` : ""}
        </p>
      </div>

      {loading && <LoadingState />}
      {errorMsg && !loading && (
        <ErrorState
          message={errorMsg}
          onRetry={() => generateBriefing(extraction)}
        />
      )}
      {briefing && !loading && !errorMsg && <BriefingCards briefing={briefing} />}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line p-10 flex items-center justify-center gap-3">
      <Spinner />
      <span className="text-[13px] text-muted">Preparing briefing...</span>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line p-6">
      <div className="text-[13px] text-danger">{message}</div>
      <button
        onClick={onRetry}
        className="mt-3 text-[12px] font-semibold text-accent hover:text-accent/80"
      >
        Try again
      </button>
    </div>
  );
}

function BriefingCards({ briefing }: { briefing: Briefing }) {
  return (
    <div className="space-y-4">
      <BriefingCard label="Call objective">
        <p className="text-[14px] text-ink leading-relaxed">
          {briefing.callObjective}
        </p>
      </BriefingCard>

      <BriefingCard label="Top 3 questions to ask">
        <ol className="space-y-3">
          {briefing.topQuestions.map((q, i) => (
            <li key={q.fieldId} className="flex items-start gap-3">
              <span className="text-[12px] font-bold text-muted shrink-0 w-4 pt-0.5">
                {i + 1}.
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-[10px] font-semibold text-ink px-1.5 py-0.5 rounded bg-bg border border-line">
                    {q.fieldId}
                  </span>
                </div>
                <p className="text-[13.5px] text-ink leading-snug">
                  {q.question}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </BriefingCard>

      <BriefingCard label="Suggested next-step commitment">
        <p className="text-[14px] text-ink leading-relaxed">
          {briefing.nextStepCommitment}
        </p>
      </BriefingCard>

      <BriefingCard label="What's at risk" tone="danger">
        <p className="text-[14px] text-ink leading-relaxed">
          {briefing.whatsAtRisk}
        </p>
      </BriefingCard>
    </div>
  );
}

function BriefingCard({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: "danger";
  children: React.ReactNode;
}) {
  const labelColor = tone === "danger" ? "text-danger" : "text-muted";
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line p-5">
      <div
        className={`text-[10px] uppercase tracking-wider font-bold ${labelColor} mb-2`}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="w-4 h-4 animate-spin text-muted"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke="currentColor"
        strokeWidth="2"
        opacity="0.25"
      />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function getMostRecentExtractionCall(
  deal: Deal,
  extraction: ExtractionResult,
): CallRecord | undefined {
  const callIds = new Set<string>();
  for (const f of SCOTSMAN_FIELDS) {
    const entry = extraction[f.id];
    if (entry && entry.status === "Yes" && entry.lastUpdatedFromCallId) {
      callIds.add(entry.lastUpdatedFromCallId);
    }
  }
  const calls = [...callIds]
    .map((id) => deal.calls.find((c) => c.id === id))
    .filter((c): c is CallRecord => !!c);
  if (calls.length === 0) return undefined;
  return calls.sort((a, b) => (a.date < b.date ? 1 : -1))[0];
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
