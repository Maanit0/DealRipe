"use client";

import { useState } from "react";
import {
  SCOTSMAN_FIELDS,
  extractionToStatus,
  gateStatus,
  type ExtractionResult,
  type FieldExtraction,
  type Stage,
} from "@/lib/scotsman";
import type { CallRecord, Deal } from "@/lib/seed-data";
import { DealHeaderCard } from "./DealHeaderCard";
import { useDemoState } from "./DemoStateProvider";
import {
  FieldIdPill,
  OpportunityControlSheet,
} from "./OpportunityControlSheet";

type Props = {
  deal: Deal;
  call: CallRecord;
  initialTranscript: string;
  stage: Stage;
};

type Phase = "idle" | "extracting" | "error";

type BannerState = {
  dateLabel: string;
  confirms: number;
  gaps: number;
  stageLabel: string;
  missingAfter: string[];
};

const LOADING_FLOOR_MS = 4000;
const FLASH_MS = 1500;
const BANNER_TINT_MS = 8000;

export function ExtractView({ deal, call, initialTranscript, stage }: Props) {
  const { setDealState } = useDemoState();

  const [transcript, setTranscript] = useState(initialTranscript);
  const [extraction, setExtraction] = useState(deal.extraction);
  const [currentCallId, setCurrentCallId] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [flashingIds, setFlashingIds] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<BannerState | null>(null);
  const [bannerTinted, setBannerTinted] = useState(false);

  async function submit() {
    if (phase === "extracting") return;
    if (transcript.trim().length < 50) {
      setErrorMsg("Transcript is too short.");
      setPhase("error");
      return;
    }
    setPhase("extracting");
    setErrorMsg(null);

    const floor = new Promise<void>((r) => setTimeout(r, LOADING_FLOOR_MS));

    try {
      const [response] = await Promise.all([
        fetch("/api/extract-scotsman", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dealId: deal.id, transcript }),
        }),
        floor,
      ]);

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setErrorMsg(body?.error || "Extraction failed. Try again.");
        setPhase("error");
        return;
      }

      const data = (await response.json()) as { extraction: ExtractionResult };
      const { merged, changedIds } = mergeExtraction(
        extraction,
        data.extraction,
        call.id,
      );

      const confirms = changedIds.filter(
        (id) => merged[id].status === "Yes",
      ).length;
      const gaps = changedIds.filter(
        (id) => merged[id].status === "No",
      ).length;
      const gate = gateStatus(stage, extractionToStatus(merged));

      setExtraction(merged);
      setCurrentCallId(call.id);
      setFlashingIds(new Set(changedIds));
      setBanner({
        dateLabel: formatDate(call.date),
        confirms,
        gaps,
        stageLabel: stage.label,
        missingAfter: gate.missing,
      });
      setBannerTinted(true);
      setPhase("idle");

      setDealState(deal.id, { extraction: merged, currentCallId: call.id });

      setTimeout(() => setFlashingIds(new Set()), FLASH_MS);
      setTimeout(() => setBannerTinted(false), BANNER_TINT_MS);
    } catch {
      setErrorMsg("Network error. Try again.");
      setPhase("error");
    }
  }

  const isExtracting = phase === "extracting";
  const dateLabel = formatDate(call.date);
  const bannerNode = banner ? (
    <UpdateBanner state={banner} tinted={bannerTinted} />
  ) : null;

  return (
    <div className="space-y-5">
      <DealHeaderCard
        deal={deal}
        stage={stage}
        extractionOverride={extraction}
        animateForecast={flashingIds.size > 0}
      />

      <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
        <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">
              Transcript from {dateLabel} · {call.durationMinutes} min
            </h2>
            <p className="text-[12px] text-muted mt-0.5">
              {call.participants.join(", ")}
            </p>
          </div>
          <span className="text-[10px] uppercase tracking-wider font-bold text-muted">
            Gong
          </span>
        </div>
        <div className="p-5">
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            disabled={isExtracting}
            spellCheck={false}
            className="w-full h-[320px] resize-y font-mono text-[12px] leading-relaxed text-ink bg-bg border border-line rounded-lg p-3 focus:outline-none focus:ring-2 focus:ring-ink/10 disabled:opacity-70"
          />
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={submit}
              disabled={isExtracting}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 disabled:opacity-60 disabled:cursor-not-allowed transition"
            >
              {isExtracting ? (
                <>
                  <Spinner />
                  Extracting…
                </>
              ) : (
                "Extract Scotsman fields"
              )}
            </button>
            {errorMsg && phase === "error" && (
              <span className="text-[12px] text-danger">{errorMsg}</span>
            )}
          </div>
        </div>
      </div>

      <OpportunityControlSheet
        extraction={extraction}
        stage={stage}
        flashingIds={flashingIds}
        banner={bannerNode}
        currentCallId={currentCallId}
        currentCallLabel={dateLabel}
      />
    </div>
  );
}

function UpdateBanner({
  state,
  tinted,
}: {
  state: BannerState;
  tinted: boolean;
}) {
  const positive = state.confirms >= state.gaps;
  const tintClass = tinted
    ? positive
      ? "bg-accent/10 border-b border-accent/30"
      : "bg-danger/10 border-b border-danger/30"
    : "bg-bg border-b border-line";

  const gatePassed = state.missingAfter.length === 0;

  return (
    <div className={`px-5 py-3 transition-colors duration-1000 ${tintClass}`}>
      <div className="text-[12px] text-ink flex flex-wrap items-center gap-x-1.5">
        <span className="font-semibold">
          Updated from {state.dateLabel} call
        </span>
        <span className="text-muted">
          · {state.confirms}{" "}
          {state.confirms === 1 ? "field" : "fields"} confirmed ·{" "}
          {state.gaps} new {state.gaps === 1 ? "gap" : "gaps"} surfaced
        </span>
      </div>
      <div className="text-[12px] mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
        {gatePassed ? (
          <span className="font-semibold text-accent">
            {state.stageLabel} gate now passed
          </span>
        ) : (
          <>
            <span className="text-ink">
              {state.stageLabel} gate now blocked on{" "}
              <span className="font-semibold">{state.missingAfter.length}</span>{" "}
              {state.missingAfter.length === 1 ? "field" : "fields"}:
            </span>
            <span className="flex flex-wrap gap-1">
              {state.missingAfter.map((id) => (
                <FieldIdPill key={id} id={id} />
              ))}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="w-3.5 h-3.5 animate-spin"
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

function mergeExtraction(
  prior: ExtractionResult,
  incoming: ExtractionResult,
  callId: string,
): { merged: ExtractionResult; changedIds: string[] } {
  const merged: ExtractionResult = {};
  const changedIds: string[] = [];

  function tagIfYes(entry: FieldExtraction): FieldExtraction {
    if (entry.status === "Yes") {
      return { ...entry, lastUpdatedFromCallId: callId };
    }
    return entry;
  }

  for (const f of SCOTSMAN_FIELDS) {
    const p: FieldExtraction = prior[f.id] ?? { status: "Unknown" };
    const n: FieldExtraction = incoming[f.id] ?? { status: "Unknown" };

    if (p.status === "Yes") {
      merged[f.id] = p;
      continue;
    }

    if (p.status === "No") {
      if (n.status === "Yes") {
        merged[f.id] = tagIfYes(n);
        changedIds.push(f.id);
      } else {
        merged[f.id] = p;
      }
      continue;
    }

    if (n.status === "Yes") {
      merged[f.id] = tagIfYes(n);
      changedIds.push(f.id);
    } else if (n.status === "No") {
      merged[f.id] = n;
      changedIds.push(f.id);
    } else {
      merged[f.id] = p;
    }
  }

  return { merged, changedIds };
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
