import {
  SCOTSMAN_FIELDS,
  SPIN_FOLLOWUPS,
  STAGES,
  extractionToStatus,
  gateStatus,
  type ExtractionResult,
  type FieldExtraction,
  type ScotsmanCategory,
  type Stage,
} from "@/lib/scotsman";

const CATEGORY_ORDER: ScotsmanCategory[] = [
  "Scope",
  "Competition",
  "Originality",
  "Timescale",
  "Size",
  "Money",
  "Authority",
  "Need",
];

type Props = {
  extraction: ExtractionResult;
  stage: Stage;
  flashingIds?: Set<string>;
  banner?: React.ReactNode;
  currentCallId?: string;
  currentCallLabel?: string;
};

export function OpportunityControlSheet({
  extraction,
  stage,
  flashingIds,
  banner,
  currentCallId,
  currentCallLabel,
}: Props) {
  const grouped = groupByCategory();
  const status = extractionToStatus(extraction);
  const yesCount = SCOTSMAN_FIELDS.filter(
    (f) => extraction[f.id]?.status === "Yes",
  ).length;
  const currentGate = gateStatus(stage, status);
  const currentFilled = stage.required.length - currentGate.missing.length;

  const stageIndex = STAGES.findIndex((s) => s.key === stage.key);
  const nextStage =
    stageIndex >= 0 && stageIndex < STAGES.length - 1
      ? STAGES[stageIndex + 1]
      : null;
  const nextGate = nextStage ? gateStatus(nextStage, status) : null;
  const nextFilled =
    nextStage && nextGate ? nextStage.required.length - nextGate.missing.length : 0;

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      {banner}
      <div className="px-5 py-4 border-b border-line">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Opportunity Control</h2>
            <p className="text-[12px] text-muted mt-0.5">
              Scotsman qualification, extracted from calls
            </p>
          </div>
          <div className="text-[12px] text-muted shrink-0">
            <span className="font-semibold text-ink">{yesCount}</span>
            <span> of 18 confirmed</span>
          </div>
        </div>

        <div className="mt-3 space-y-1.5">
          <GateLine
            tone="current"
            label={`${currentFilled} of ${stage.required.length} needed for ${stage.label} gate`}
            missing={currentGate.missing}
          />
          {nextStage && nextGate && (
            <GateLine
              tone="next"
              label={`Next gate: ${nextStage.label} (${nextStage.pct}) · ${nextFilled} of ${nextStage.required.length} needed`}
              missing={nextGate.missing}
            />
          )}
        </div>
      </div>
      <div className="divide-y divide-line">
        {CATEGORY_ORDER.map((category) => {
          const fields = grouped.get(category) ?? [];
          const counts = countStatuses(fields, extraction);
          return (
            <div key={category} className="px-5 py-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
                  {category}
                </div>
                <CategoryBadge counts={counts} />
              </div>
              <div className="space-y-2">
                {fields.map((f) => {
                  const entry = extraction[f.id];
                  const isNew =
                    entry?.status === "Yes" &&
                    !!currentCallId &&
                    entry.lastUpdatedFromCallId === currentCallId;
                  return (
                    <FieldRow
                      key={f.id}
                      fieldId={f.id}
                      question={f.question}
                      entry={entry}
                      flashing={flashingIds?.has(f.id) ?? false}
                      isNew={isNew}
                      newLabel={currentCallLabel}
                    />
                  );
                })}
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
        <>
          <span className={`font-semibold ${missingColor}`}>
            · {missing.length} missing:
          </span>
          <span className="flex flex-wrap gap-1">
            {missing.map((id) => (
              <FieldIdPill key={id} id={id} />
            ))}
          </span>
        </>
      )}
    </div>
  );
}

export function FieldIdPill({ id }: { id: string }) {
  return (
    <span className="inline-block font-mono text-[10px] font-semibold px-1.5 py-0.5 rounded bg-bg border border-line text-ink">
      {id}
    </span>
  );
}

function FieldRow({
  fieldId,
  question,
  entry,
  flashing,
  isNew,
  newLabel,
}: {
  fieldId: string;
  question: string;
  entry: FieldExtraction | undefined;
  flashing: boolean;
  isNew: boolean;
  newLabel?: string;
}) {
  const status = entry?.status ?? "Unknown";
  const rowBg = isNew
    ? "bg-accent/[0.06] border-l-2 border-accent"
    : status === "No"
      ? "bg-danger/[0.04]"
      : "bg-transparent";
  const flashClass = flashing
    ? status === "Yes"
      ? "flash-yes"
      : status === "No"
        ? "flash-no"
        : ""
    : "";

  return (
    <div className={`flex gap-3 items-start rounded-md px-2 py-2 -mx-2 ${rowBg} ${flashClass}`}>
      <StatusDot status={status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-[10px] text-muted shrink-0 pt-0.5">
            {fieldId}
          </span>
          {isNew && (
            <span
              className="font-mono text-[9px] uppercase tracking-wider font-bold text-accent px-1 py-[1px] rounded bg-accent/10"
              title={newLabel ? `Confirmed via ${newLabel} call` : "Newly confirmed"}
            >
              New
            </span>
          )}
          <span className="text-[13px] text-ink font-medium leading-snug">
            {question}
          </span>
        </div>

        {entry?.status === "Yes" && (
          <div className="mt-1.5 space-y-1">
            <div className="text-[12.5px] text-ink leading-snug">
              {entry.answer}
            </div>
            <div className="text-[12px] text-muted italic leading-snug">
              &ldquo;{entry.evidence}&rdquo;
            </div>
          </div>
        )}

        {status !== "Yes" && SPIN_FOLLOWUPS[fieldId] && (
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-[9px] uppercase tracking-wider font-semibold text-muted shrink-0">
              Ask
            </span>
            <span className="text-[12px] text-muted leading-snug">
              {SPIN_FOLLOWUPS[fieldId]}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: "Yes" | "No" | "Unknown" }) {
  if (status === "Yes") {
    return (
      <span className="w-[18px] h-[18px] rounded-full bg-accent shrink-0 mt-0.5 flex items-center justify-center">
        <svg
          viewBox="0 0 16 16"
          className="w-2.5 h-2.5"
          fill="none"
          stroke="white"
          strokeWidth="3"
        >
          <path
            d="M3 8l3.5 3.5L13 5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  if (status === "No") {
    return (
      <span className="w-[18px] h-[18px] rounded-full bg-danger shrink-0 mt-0.5 flex items-center justify-center">
        <svg
          viewBox="0 0 16 16"
          className="w-2.5 h-2.5"
          fill="none"
          stroke="white"
          strokeWidth="3"
        >
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </span>
    );
  }
  return (
    <span className="w-[18px] h-[18px] rounded-full border-2 border-line bg-white shrink-0 mt-0.5" />
  );
}

function CategoryBadge({
  counts,
}: {
  counts: { yes: number; no: number; unknown: number };
}) {
  if (counts.no > 0) {
    return (
      <span className="text-[9px] uppercase tracking-wider font-bold text-danger">
        · {counts.no} {counts.no === 1 ? "gap" : "gaps"}
      </span>
    );
  }
  if (counts.unknown > 0) {
    return (
      <span className="text-[9px] uppercase tracking-wider font-bold text-warn">
        · {counts.unknown} open
      </span>
    );
  }
  return null;
}

function countStatuses(
  fields: typeof SCOTSMAN_FIELDS,
  extraction: ExtractionResult,
) {
  let yes = 0;
  let no = 0;
  let unknown = 0;
  for (const f of fields) {
    const s = extraction[f.id]?.status ?? "Unknown";
    if (s === "Yes") yes++;
    else if (s === "No") no++;
    else unknown++;
  }
  return { yes, no, unknown };
}

function groupByCategory() {
  const map = new Map<ScotsmanCategory, typeof SCOTSMAN_FIELDS>();
  SCOTSMAN_FIELDS.forEach((f) => {
    const arr = map.get(f.category) ?? [];
    arr.push(f);
    map.set(f.category, arr);
  });
  return map;
}
