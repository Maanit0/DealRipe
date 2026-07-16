import type { Framework } from "@/lib/framework";
import type { ExtractionResult } from "@/lib/scotsman";
import {
  frameworkProgress,
  frameworkStages,
  nextStage,
  stageGateStatus,
  type FrameworkStage,
} from "@/lib/framework-stages";

// Human labels for Magaya's SQL stages (data only stores the key).
const STAGE_LABELS: Record<string, string> = {
  SQL0: "Lead",
  SQL1: "Develop Opportunity (Qualify)",
  SQL2: "Solution Finalization (Develop)",
  SQL3: "Proposal Validation (Prove)",
  SQL4: "Negotiations",
  SQL5: "Agreement Formalization",
};

function stageLabel(key: string): string {
  return STAGE_LABELS[key] ? `${key} · ${STAGE_LABELS[key]}` : key;
}

function fmtCaptured(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

type Attribution = Record<string, { callDate: string | null }>;

type Props = {
  framework: Framework;
  extraction: ExtractionResult;
  currentStageKey: string;
  /** fieldKey -> which call captured it, for inline "captured Jul 16" tags. */
  capturedByField?: Attribution;
};

export function MagayaOpportunityControl({
  framework,
  extraction,
  currentStageKey,
  capturedByField = {},
}: Props) {
  const stages = frameworkStages(framework);
  const { confirmed, total } = frameworkProgress(framework, extraction);

  const current = stages.find((s) => s.key === currentStageKey) ?? stages[0];
  const next = current ? nextStage(stages, current.key) : null;
  const currentGate = current ? stageGateStatus(current, extraction) : null;
  const nextGate = next ? stageGateStatus(next, extraction) : null;

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-5 py-4 border-b border-line">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Opportunity Control</h2>
            <p className="text-[12px] text-muted mt-0.5">
              {framework.name} qualification, extracted from calls
            </p>
          </div>
          <div className="text-[12px] text-muted shrink-0">
            <span className="font-semibold text-ink">{confirmed}</span>
            <span> of {total} confirmed</span>
          </div>
        </div>

        <div className="mt-3 space-y-1.5">
          {current && currentGate && (
            <GateLine
              tone="current"
              label={`${currentGate.met} of ${currentGate.total} for ${stageLabel(current.key)} gate`}
              missing={currentGate.openKeys}
            />
          )}
          {next && nextGate && (
            <GateLine
              tone="next"
              label={`Next gate: ${stageLabel(next.key)} · ${nextGate.met} of ${nextGate.total}`}
              missing={nextGate.openKeys}
            />
          )}
        </div>
      </div>

      <div className="divide-y divide-line">
        {stages.map((stage) => (
          <StageSection
            key={stage.key}
            stage={stage}
            extraction={extraction}
            capturedByField={capturedByField}
          />
        ))}
      </div>
    </div>
  );
}

function StageSection({
  stage,
  extraction,
  capturedByField,
}: {
  stage: FrameworkStage;
  extraction: ExtractionResult;
  capturedByField: Attribution;
}) {
  const gate = stageGateStatus(stage, extraction);
  const open = gate.total - gate.met;
  return (
    <div className="px-5 py-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
          {stageLabel(stage.key)}
        </div>
        {open > 0 && (
          <span className="text-[9px] uppercase tracking-wider font-bold text-warn">
            · {open} open
          </span>
        )}
      </div>
      <div className="space-y-2">
        {stage.fields.map((f) => {
          const entry = extraction[f.fieldKey];
          const status = entry?.status ?? "Unknown";
          return (
            <div key={f.fieldKey} className="flex gap-3 items-start rounded-md px-2 py-2 -mx-2">
              <StatusDot status={status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-mono text-[10px] text-muted shrink-0 pt-0.5">
                    {f.label}
                  </span>
                  <span className="text-[13px] text-ink font-medium leading-snug">
                    {f.question}
                  </span>
                </div>
                {entry?.status === "Yes" && (
                  <div className="mt-1.5 space-y-1">
                    <div className="text-[12.5px] text-ink leading-snug">{entry.answer}</div>
                    <div className="text-[12px] text-muted italic leading-snug">
                      &ldquo;{entry.evidence}&rdquo;
                    </div>
                    {capturedByField[f.fieldKey]?.callDate && (
                      <div className="text-[10px] uppercase tracking-wider font-semibold text-accent/80">
                        Captured {fmtCaptured(capturedByField[f.fieldKey]?.callDate)}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GateLine({
  tone,
  label,
  missing,
}: {
  tone: "current" | "next";
  label: string;
  missing: string[];
}) {
  const labelColor = tone === "current" ? "text-ink" : "text-muted";
  const missingColor =
    tone === "current"
      ? missing.length === 0
        ? "text-accent"
        : "text-danger"
      : "text-muted";
  return (
    <div className="text-[12px] leading-relaxed flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span className={labelColor}>{label}</span>
      {missing.length === 0 ? (
        <span className={`font-semibold ${missingColor}`}>· all met</span>
      ) : (
        <span className={`font-semibold ${missingColor}`}>· {missing.length} open</span>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: "Yes" | "No" | "Unknown" }) {
  if (status === "Yes") {
    return (
      <span className="w-[18px] h-[18px] rounded-full bg-accent shrink-0 mt-0.5 flex items-center justify-center">
        <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="none" stroke="white" strokeWidth="3">
          <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    );
  }
  if (status === "No") {
    return (
      <span className="w-[18px] h-[18px] rounded-full bg-danger shrink-0 mt-0.5 flex items-center justify-center">
        <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="none" stroke="white" strokeWidth="3">
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className="w-[18px] h-[18px] rounded-full border-2 border-line bg-white shrink-0 mt-0.5" />
  );
}
