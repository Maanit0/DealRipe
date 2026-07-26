"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

/**
 * The full-page extraction experience (demo tenants): the call transcript on top,
 * and when the rep clicks "Extract with DealRipe," the qualification fills in below
 * step by step — the Opportunity Control updates, the stakeholder and CRM writes
 * land, the still-open gaps and flags surface, and the prescribed action appears.
 * This is the old "extract from this call" page, wired to live tenant data.
 */

const STEP_DELAYS = [1000, 800, 800, 700, 700, 700];

export function TenantExtractView({
  dealName,
  metaLine,
  arr,
  repForecast,
  drForecast,
  drSofter,
  callLabel,
  transcript,
  confirmed,
  total,
  stakeholder,
  crmFields,
  openGates,
  flags,
  signals,
  nextAction,
  actionHref,
  backHref,
  control,
  controlExtracted,
}: {
  dealName: string;
  metaLine: string;
  arr: number;
  repForecast: string;
  drForecast: string;
  drSofter: boolean;
  callLabel: string;
  transcript: string;
  confirmed: number;
  total: number;
  stakeholder: { name: string; role: string } | null;
  crmFields: string[];
  openGates: { label: string }[];
  flags: string[];
  signals: { label: string; text: string }[];
  nextAction: string;
  actionHref: string;
  backHref: string;
  control: ReactNode;
  controlExtracted: ReactNode;
}) {
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(-1);
  const done = step >= STEP_DELAYS.length;

  useEffect(() => {
    if (!started || step < 0 || step >= STEP_DELAYS.length) return;
    const t = setTimeout(() => setStep((s) => s + 1), STEP_DELAYS[step]);
    return () => clearTimeout(t);
  }, [started, step]);

  const showStakeholder = step >= 3;
  const showCrm = step >= 4;
  const showOpen = step >= 5;
  const showAction = step >= 6;
  const hasOpen = openGates.length > 0 || flags.length > 0;

  return (
    <div className="space-y-5">
      {/* Header: name, ARR, rep vs DealRipe forecast. */}
      <div className="bg-white rounded-xl2 shadow-card border border-line px-6 py-5">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div>
            <h1 className="text-[22px] font-semibold text-ink">{dealName}</h1>
            <p className="text-[13px] text-muted mt-0.5">{metaLine}</p>
          </div>
          <div className="text-[22px] font-semibold text-ink">${arr.toLocaleString()}</div>
        </div>
        <div className="mt-4 pt-4 border-t border-line grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Rep forecast</div>
            <div className="text-[13px] text-ink mt-1">{repForecast}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">DealRipe forecast</div>
            <div className={`text-[13px] font-semibold mt-1 ${drSofter ? "text-danger" : "text-ink"}`}>{drForecast}</div>
          </div>
        </div>
      </div>

      {/* Transcript + the extract trigger. */}
      <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
        <div className="px-5 py-3.5 border-b border-line flex items-center justify-between">
          <div className="text-[14px] font-semibold text-ink">Transcript from {callLabel}</div>
          <span className="text-[10px] uppercase tracking-wider font-semibold text-muted">Teams</span>
        </div>
        <pre className="px-5 py-4 text-[12px] text-ink/80 whitespace-pre-wrap max-h-[260px] overflow-auto font-mono leading-relaxed">
          {transcript}
        </pre>
        <div className="px-5 py-3 border-t border-line flex items-center gap-3">
          <button
            onClick={() => {
              setStarted(true);
              setStep(0);
            }}
            disabled={started}
            className="px-4 py-2.5 rounded-xl2 bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 transition disabled:opacity-60"
          >
            {started ? (done ? "Extracted ✓" : "Extracting…") : "Extract with DealRipe →"}
          </button>
          {started && !done && <span className="text-[12px] text-muted">DealRipe is reading the call and updating the CRM…</span>}
        </div>
      </div>

      {/* The extraction summary, revealed step by step on click. */}
      {started && (
        <div className="space-y-4">
          <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 space-y-2.5">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-accent">Updated from the {callLabel} call</div>
            <StepRow active={step >= 0} done={step >= 1} label="Read the transcript" />
            <StepRow active={step >= 1} done={step >= 2} label={`Captured ${confirmed} of ${total} qualification gates`} />
            <StepRow active={step >= 2} done={step >= 3} label="Updated Opportunity Control" />
            {showStakeholder && stakeholder && (
              <div className="flex items-start gap-2 text-[13px] text-ink">
                <span className="text-accent font-bold">✓</span>
                <span>
                  Identified stakeholder: <span className="font-semibold">{stakeholder.name}</span> ({stakeholder.role}) as the economic buyer
                </span>
              </div>
            )}
            {showCrm && (
              <div className="flex items-start gap-2 text-[13px] text-ink">
                <span className="text-accent font-bold">✓</span>
                <span>
                  Wrote {crmFields.length} field{crmFields.length === 1 ? "" : "s"} back to the CRM
                  {crmFields.length > 0 && <span className="text-muted"> — {crmFields.join(", ")}</span>}
                </span>
              </div>
            )}
          </div>

          {showCrm && signals.length > 0 && (
            <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-accent mb-2">What DealRipe caught on this call</div>
              <ul className="space-y-2">
                {signals.map((s, i) => (
                  <li key={i} className="text-[13px] leading-snug">
                    <span className="font-semibold text-ink">{s.label}:</span> <span className="text-ink/85">{s.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {showOpen && hasOpen && (
            <div className="border border-danger/25 bg-danger/[0.03] rounded-xl2 px-5 py-4">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-danger mb-2">
                Still open — {openGates.length + flags.length} gap{openGates.length + flags.length === 1 ? "" : "s"} &amp; flags
              </div>
              <ul className="space-y-1.5">
                {flags.map((f, i) => (
                  <li key={`f${i}`} className="flex items-start gap-2 text-[12.5px] leading-snug">
                    <span className="text-danger font-bold mt-[1px]">!</span>
                    <span className="text-ink">{f}</span>
                  </li>
                ))}
                {openGates.map((g, i) => (
                  <li key={`g${i}`} className="flex items-start gap-2 text-[12.5px] leading-snug">
                    <span className="text-danger mt-[2px]">•</span>
                    <span className="text-ink">
                      <span className="font-medium">{g.label}</span> <span className="text-muted">not yet confirmed on a call</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {showAction && (
            <div className="bg-accent/5 border border-accent/25 rounded-xl2 px-5 py-4">
              <div className="text-[10px] uppercase tracking-wider font-bold text-accent mb-1">Next action DealRipe prescribes</div>
              <div className="text-[14px] text-ink leading-relaxed">{nextAction}</div>
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                <a href={actionHref} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 transition">
                  Take this action →
                </a>
                <Link href={backHref} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-line text-ink text-[13px] font-semibold hover:bg-bg transition">
                  Back to the deal →
                </Link>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Opportunity Control: always visible below the transcript. It stays the
          current state while the extraction runs, then — once DealRipe reaches the
          "Updated Opportunity Control" step — swaps to the version where the fields
          this call added are badged NEW (green) and the gaps it surfaced NEW GAP (red). */}
      <div>{step >= 3 ? controlExtracted : control}</div>
    </div>
  );
}

function StepRow({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  if (!active) return null;
  return (
    <div className="flex items-center gap-2 text-[13px]">
      {done ? (
        <span className="text-accent font-bold">✓</span>
      ) : (
        <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
      )}
      <span className={done ? "text-ink" : "text-muted"}>{label}</span>
    </div>
  );
}
