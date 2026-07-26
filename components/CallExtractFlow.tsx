"use client";

import { useEffect, useState } from "react";

/**
 * The "watch DealRipe process a call" flow for the demo deal page.
 *
 * The latest call starts UNEXTRACTED. The rep clicks "Extract with DealRipe" and a
 * modal animates the whole pipeline step by step: read the transcript, capture the
 * qualification gates, update Opportunity Control, identify a new stakeholder, write
 * the fields back to the CRM, and finally surface the next action for the rep. This
 * makes the before → during → after flow visible instead of everything already done.
 */

export type ExtractGate = { label: string; answer: string };

const STEP_DELAYS = [1100, 850, 800, 800, 800, 800, 700];

export function CallExtractFlow({
  callLabel,
  participants,
  gates,
  openGates,
  flags,
  stakeholder,
  crmFields,
  nextAction,
  actionHref,
  extractHref,
}: {
  callLabel: string;
  participants: string;
  gates: ExtractGate[];
  openGates: { label: string }[];
  flags: string[];
  stakeholder: { name: string; role: string } | null;
  crmFields: string[];
  nextAction: string;
  actionHref: string;
  /** When set, "Extract" navigates to the full extraction page instead of opening
   *  the inline modal. */
  extractHref?: string;
}) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [step, setStep] = useState(-1); // -1 idle; 0..5 running; 6 complete

  // Drive the staged reveal once the modal is open.
  useEffect(() => {
    if (!open || step < 0 || step >= STEP_DELAYS.length) return;
    const t = setTimeout(() => setStep((s) => s + 1), STEP_DELAYS[step]);
    return () => clearTimeout(t);
  }, [open, step]);

  useEffect(() => {
    if (step >= STEP_DELAYS.length) setDone(true);
  }, [step]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  function start() {
    setOpen(true);
    if (!done) setStep(0);
    else setStep(STEP_DELAYS.length);
  }

  const reading = step >= 0;
  const showGates = step >= 1;
  const showControl = step >= 2;
  const showStakeholder = step >= 3;
  const showCrm = step >= 4;
  const showOpen = step >= 5;
  const showAction = step >= 6;
  const hasOpen = openGates.length > 0 || flags.length > 0;

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Latest call</div>
          <div className="text-[15px] font-semibold text-ink mt-1">{callLabel}</div>
          <div className="text-[12px] text-muted mt-0.5">{participants}</div>
        </div>
        <div className="text-right">
          {done ? (
            <span className="text-[11px] uppercase tracking-wider font-semibold text-accent">Extracted ✓</span>
          ) : (
            <span className="text-[11px] uppercase tracking-wider font-semibold text-warn">Not extracted</span>
          )}
        </div>
      </div>
      {extractHref ? (
        <a
          href={extractHref}
          className="mt-3 block w-full text-center px-4 py-2.5 rounded-xl2 bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 transition"
        >
          Extract with DealRipe →
        </a>
      ) : (
        <button
          onClick={start}
          className="mt-3 w-full text-center px-4 py-2.5 rounded-xl2 bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 transition"
        >
          {done ? "Replay extraction" : "Extract with DealRipe →"}
        </button>
      )}

      {open && (
        <div onClick={() => setOpen(false)} className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl2 shadow-lg w-full max-w-[900px] h-[88vh] flex flex-col overflow-hidden">
            <div className="px-5 py-3.5 border-b border-line flex items-start justify-between gap-3 shrink-0">
              <div>
                <div className="text-[10px] uppercase tracking-wider font-bold text-accent">DealRipe</div>
                <div className="text-[15px] font-semibold text-ink mt-0.5">Processing the {callLabel} call</div>
              </div>
              <button onClick={() => setOpen(false)} aria-label="Close" className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-bg transition text-[15px]">✕</button>
            </div>

            <div className="px-5 py-4 overflow-auto space-y-3">
              <StepRow active={reading} done={step >= 1} label="Reading the transcript" />

              <div className={`transition-opacity duration-500 ${showGates ? "opacity-100" : "opacity-0"}`}>
                {showGates && (
                  <div className="border border-line rounded-lg p-3.5">
                    <div className="text-[10px] uppercase tracking-wider font-semibold text-accent mb-2">
                      Captured {gates.length} qualification gates
                    </div>
                    <ul className="space-y-1.5">
                      {gates.map((g, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-2 text-[12.5px] leading-snug transition-opacity duration-500"
                          style={{ transitionDelay: `${i * 90}ms` }}
                        >
                          <span className="text-accent font-bold mt-[1px]">✓</span>
                          <span className="text-ink">
                            <span className="font-medium">{g.label}:</span> <span className="text-muted">{g.answer}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <StepRow active={showControl} done={step >= 3} label="Updated Opportunity Control" />

              {showStakeholder && stakeholder && (
                <div className="transition-opacity duration-500 opacity-100 border border-line rounded-lg px-3.5 py-2.5">
                  <div className="text-[12.5px] text-ink">
                    <span className="text-accent font-bold mr-1.5">✓</span>
                    Identified stakeholder: <span className="font-semibold">{stakeholder.name}</span> ({stakeholder.role}) as the economic buyer
                  </div>
                </div>
              )}

              {showCrm && (
                <div className="transition-opacity duration-500 opacity-100 border border-line rounded-lg px-3.5 py-2.5">
                  <div className="text-[12.5px] text-ink">
                    <span className="text-accent font-bold mr-1.5">✓</span>
                    Wrote {crmFields.length} field{crmFields.length === 1 ? "" : "s"} back to the CRM
                    {crmFields.length > 0 && <span className="text-muted"> — {crmFields.join(", ")}</span>}
                  </div>
                </div>
              )}

              {showOpen && hasOpen && (
                <div className="transition-opacity duration-500 opacity-100 border border-danger/25 bg-danger/[0.03] rounded-lg p-3.5">
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
                <div className="transition-opacity duration-500 opacity-100 bg-accent/5 border border-accent/25 rounded-lg p-4">
                  <div className="text-[10px] uppercase tracking-wider font-bold text-accent mb-1">Next action DealRipe prescribes</div>
                  <div className="text-[14px] text-ink leading-relaxed">{nextAction}</div>
                  <div className="mt-3 flex items-center gap-2 flex-wrap">
                    <a
                      href={actionHref}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 transition"
                    >
                      Take this action →
                    </a>
                    <button
                      onClick={() => setOpen(false)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-line text-ink text-[13px] font-semibold hover:bg-bg transition"
                    >
                      See the full updated deal →
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-line flex items-center justify-between gap-3 shrink-0">
              <span className="text-[11.5px] text-muted">
                {done ? "Extraction complete. Everything above was written automatically." : "DealRipe is extracting from the call…"}
              </span>
              <button onClick={() => setOpen(false)} className="text-[13px] font-semibold text-muted hover:text-ink transition px-2">
                {done ? "Close" : "Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StepRow({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  if (!active) return null;
  return (
    <div className="flex items-center gap-2 text-[13px] text-ink">
      {done ? (
        <span className="text-accent font-bold">✓</span>
      ) : (
        <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-accent border-t-transparent animate-spin" />
      )}
      <span className={done ? "text-ink" : "text-muted"}>{label}</span>
    </div>
  );
}
