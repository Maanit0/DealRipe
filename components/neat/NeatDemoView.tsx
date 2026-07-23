"use client";

import { useState } from "react";
import {
  NEAT_AFTER,
  NEAT_BEFORE,
  NEAT_FIELDS,
  SALESFORCE_WRITEBACK,
  SECOND_NATURE_DEAL,
  SECOND_NATURE_TRANSCRIPT,
  SLACK_BRIEFING,
  type NeatCategory,
  type NeatExtraction,
  type NeatField,
} from "@/lib/demos/neat-second-nature";

const CATEGORY_ORDER: NeatCategory[] = [
  "Need",
  "Economic Impact",
  "Access to Authority",
  "Timeline",
];

const LOADING_FLOOR_MS = 3800;
const FLASH_MS = 1600;

type Phase = "idle" | "extracting" | "done";

function fmtDoors(n: number) {
  return n.toLocaleString("en-US");
}
function fmtMoney(n: number) {
  return `$${(n / 1000).toFixed(0)}K`;
}

export function NeatDemoView() {
  const d = SECOND_NATURE_DEAL;
  const [phase, setPhase] = useState<Phase>("idle");
  const [extraction, setExtraction] = useState<NeatExtraction>(NEAT_BEFORE);
  const [flashing, setFlashing] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState(false);

  async function runExtract() {
    if (phase === "extracting") return;
    setPhase("extracting");
    await new Promise((r) => setTimeout(r, LOADING_FLOOR_MS));

    // Which fields changed from BEFORE -> AFTER (for the flash).
    const changed = new Set(
      NEAT_FIELDS.map((f) => f.id).filter(
        (id) => NEAT_BEFORE[id]?.status !== NEAT_AFTER[id]?.status,
      ),
    );
    setExtraction(NEAT_AFTER);
    setFlashing(changed);
    setRevealed(true);
    setPhase("done");
    setTimeout(() => setFlashing(new Set()), FLASH_MS);
  }

  const yesCount = NEAT_FIELDS.filter(
    (f) => extraction[f.id]?.status === "Yes",
  ).length;

  return (
    <div className="space-y-5">
      {/* Deal header */}
      <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-[17px] font-semibold text-ink">{d.account}</h1>
              <span className="text-[11px] font-semibold text-muted px-2 py-0.5 rounded-full bg-bg border border-line">
                {d.stageLabel}
              </span>
            </div>
            <p className="text-[12.5px] text-muted mt-0.5">
              {d.industry} · {fmtDoors(d.doors)} doors · {fmtMoney(d.carr)} CARR ·{" "}
              {d.methodology} · {d.crm}
            </p>
          </div>
          <div className="text-right">
            <div className="text-[11px] text-muted">Rep forecast</div>
            <div className="text-[13px] text-ink font-semibold">
              {Math.round(d.repForecastProbability * 100)}% · {d.repForecastCloseDate}
            </div>
            {revealed && (
              <div className="mt-1 flash-no rounded px-1">
                <div className="text-[11px] text-muted">DealRipe adjusted</div>
                <div className="text-[13px] text-danger font-semibold">
                  {Math.round(d.adjustedProbability * 100)}% · {d.adjustedCloseDate}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Transcript + Zoom source */}
      <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
        <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">
              Call from {d.call.date} · {d.call.durationMinutes} min
            </h2>
            <p className="text-[12px] text-muted mt-0.5">
              {d.call.participants.join(", ")}
            </p>
          </div>
          <div className="text-right shrink-0">
            <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-muted">
              <span className="w-2 h-2 rounded-full bg-accent" />
              Zoom
            </span>
            <p className="text-[10.5px] text-muted mt-0.5">
              Cloud recording · synced automatically
            </p>
          </div>
        </div>
        <div className="p-5">
          <div className="w-full h-[240px] overflow-y-auto font-mono text-[12px] leading-relaxed text-ink bg-bg border border-line rounded-lg p-3 whitespace-pre-wrap">
            {SECOND_NATURE_TRANSCRIPT}
          </div>
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <button
              onClick={runExtract}
              disabled={phase === "extracting"}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 disabled:opacity-60 disabled:cursor-not-allowed transition"
            >
              {phase === "extracting" ? (
                <>
                  <Spinner />
                  Reading transcript…
                </>
              ) : (
                "Extract NEAT fields"
              )}
            </button>
            <span className="text-[11.5px] text-muted">
              Runs automatically after every call. Rep does nothing.
            </span>
          </div>
        </div>
      </div>

      {/* NEAT control sheet */}
      <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
        <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">Opportunity Control</h2>
            <p className="text-[12px] text-muted mt-0.5">
              NEAT qualification, extracted from calls
            </p>
          </div>
          <div className="text-[12px] text-muted shrink-0">
            <span className="font-semibold text-ink">{yesCount}</span>
            <span> of {NEAT_FIELDS.length} confirmed</span>
          </div>
        </div>
        <div className="divide-y divide-line">
          {CATEGORY_ORDER.map((cat) => {
            const fields = NEAT_FIELDS.filter((f) => f.category === cat);
            const gaps = fields.filter(
              (f) => extraction[f.id]?.status === "No",
            ).length;
            const open = fields.filter(
              (f) => (extraction[f.id]?.status ?? "Unknown") === "Unknown",
            ).length;
            return (
              <div key={cat} className="px-5 py-4">
                <div className="flex items-center gap-2 mb-3">
                  <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
                    {cat}
                  </div>
                  {gaps > 0 ? (
                    <span className="text-[9px] uppercase tracking-wider font-bold text-danger">
                      · {gaps} {gaps === 1 ? "gap" : "gaps"}
                    </span>
                  ) : open > 0 ? (
                    <span className="text-[9px] uppercase tracking-wider font-bold text-warn">
                      · {open} open
                    </span>
                  ) : null}
                </div>
                <div className="space-y-2">
                  {fields.map((f) => (
                    <NeatRow
                      key={f.id}
                      field={f}
                      entry={extraction[f.id]}
                      flashing={flashing.has(f.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Salesforce writeback + Slack briefing appear after extraction */}
      {revealed && (
        <>
          <SalesforceWritebackCard />
          <SlackBriefingCard />
        </>
      )}
    </div>
  );
}

function NeatRow({
  field,
  entry,
  flashing,
}: {
  field: NeatField;
  entry: NeatExtraction[string] | undefined;
  flashing: boolean;
}) {
  const status = entry?.status ?? "Unknown";
  const rowBg =
    status === "No" ? "bg-danger/[0.04]" : "bg-transparent";
  const flashClass = flashing
    ? status === "Yes"
      ? "flash-yes"
      : status === "No"
        ? "flash-no"
        : ""
    : "";

  return (
    <div
      className={`flex gap-3 items-start rounded-md px-2 py-2 -mx-2 ${rowBg} ${flashClass}`}
    >
      <StatusDot status={status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-[10px] text-muted shrink-0 pt-0.5">
            {field.id}
          </span>
          <span className="text-[13px] text-ink font-medium leading-snug">
            {field.question}
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

        {status !== "Yes" && (
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="text-[9px] uppercase tracking-wider font-semibold text-muted shrink-0">
              Ask
            </span>
            <span className="text-[12px] text-muted leading-snug">
              {field.ask}
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

function SalesforceWritebackCard() {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">
            Written back to Salesforce
          </h2>
          <p className="text-[12px] text-muted mt-0.5">
            Fields updated automatically from the Zoom recording, with the quote behind each
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold text-accent px-2 py-1 rounded bg-accent/10 shrink-0">
          Auto · no rep action
        </span>
      </div>
      <div className="divide-y divide-line">
        {SALESFORCE_WRITEBACK.map((row) => (
          <div key={row.sfField} className="px-5 py-3">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-mono text-[11px] text-muted">{row.sfField}</span>
              <span className="text-[13px] text-ink font-medium">{row.value}</span>
            </div>
            <div className="text-[12px] text-muted italic leading-snug mt-1">
              &ldquo;{row.evidence}&rdquo;
            </div>
          </div>
        ))}
      </div>
      <div className="px-5 py-2.5 border-t border-line bg-bg text-[11px] text-muted">
        Pulled from Zoom cloud recording via API. No Gong-to-Salesforce connection required.
      </div>
    </div>
  );
}

function SlackBriefingCard() {
  const b = SLACK_BRIEFING;
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Pre-call briefing</h2>
          <p className="text-[12px] text-muted mt-0.5">{b.channel} · {b.when}</p>
        </div>
        <span className="text-[10px] uppercase tracking-wider font-bold text-muted shrink-0">
          Nothing to log into
        </span>
      </div>
      <div className="p-5">
        {/* Slack-style message */}
        <div className="border border-line rounded-lg overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line bg-bg">
            <span className="w-6 h-6 rounded bg-ink text-white text-[11px] font-bold flex items-center justify-center">
              DR
            </span>
            <span className="text-[13px] font-semibold text-ink">DealRipe</span>
            <span className="text-[11px] text-muted">bot · now</span>
          </div>
          <div className="px-4 py-3.5 space-y-3">
            <div className="text-[12.5px] text-ink">
              <span className="font-semibold">Next up: {b.deal}</span>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider font-semibold text-muted mb-1">
                Objective
              </div>
              <div className="text-[13px] text-ink leading-snug">{b.objective}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider font-semibold text-muted mb-1">
                Ask these (NEAT gaps)
              </div>
              <div className="space-y-1.5">
                {b.questions.map((q, i) => (
                  <div key={i} className="flex gap-2 text-[13px] text-ink leading-snug">
                    <span className="font-mono text-[11px] text-muted shrink-0 pt-0.5">
                      {i + 1}.
                    </span>
                    <span>{q}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-md bg-danger/[0.05] border border-danger/20 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-danger mb-0.5">
                At risk
              </div>
              <div className="text-[12.5px] text-ink leading-snug">{b.risk}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
