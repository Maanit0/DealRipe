"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The closed-loop "deal saved" arc for the hero at-risk deal.
 *
 * DealRipe caught a deal about to slip (the signer never engaged) and prescribes
 * the move your best reps make on deals of this shape. Taking the action opens the
 * real drafted email (to the champion, with proposed times, in the rep's voice) to
 * send. Crucially, the forecast does NOT move because an email went out — it moves
 * only when the OUTCOME lands (the buyer joins the call). That's the honest,
 * credible version: DealRipe re-rates on evidence, not on activity.
 */
export function DealSavedArc({
  repPct,
  drBeforePct,
  drAfterPct,
  gapAtRiskUsd,
  stakeholderName,
  stakeholderRole,
  championName,
  actionTitle,
  bestRepNote,
  motionNote,
  draft,
}: {
  repPct: number;
  drBeforePct: number;
  drAfterPct: number;
  gapAtRiskUsd: number;
  stakeholderName: string;
  stakeholderRole: string;
  championName: string;
  actionTitle: string;
  bestRepNote: string;
  motionNote: string;
  draft: { to: string; subject: string; body: string } | null;
}) {
  const [phase, setPhase] = useState<"flagged" | "sent" | "saved">("flagged");
  const [modalOpen, setModalOpen] = useState(false);
  const [shownPct, setShownPct] = useState(drBeforePct);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setModalOpen(false);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [modalOpen]);

  useEffect(() => () => {
    if (raf.current) cancelAnimationFrame(raf.current);
  }, []);

  function sendEmail() {
    setModalOpen(false);
    setPhase("sent");
  }
  function logOutcome() {
    setPhase("saved");
    const start = performance.now();
    const from = drBeforePct;
    const to = drAfterPct;
    const dur = 900;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / dur);
      const eased = 1 - Math.pow(1 - k, 3);
      setShownPct(Math.round(from + (to - from) * eased));
      if (k < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }

  const saved = phase === "saved";
  const money = (v: number) => (Math.abs(v) >= 1000 ? `$${Math.round(v / 1000)}K` : `$${v}`);

  const eyebrow = saved
    ? "DealRipe saved this deal"
    : phase === "sent"
      ? "Action taken · awaiting the outcome"
      : "DealRipe caught a deal about to slip";
  const title = saved ? "Back on track" : phase === "sent" ? "The read holds until the outcome lands" : "The forecast is ahead of the evidence";

  return (
    <div className={`rounded-xl2 shadow-card border overflow-hidden transition-colors ${saved ? "border-accent/40 bg-accent/[0.03]" : "border-danger/30 bg-danger/[0.02]"}`}>
      <div className="px-6 py-4 border-b border-line flex items-center justify-between gap-4">
        <div>
          <div className={`text-[10px] uppercase tracking-wider font-bold ${saved ? "text-accent" : "text-danger"}`}>{eyebrow}</div>
          <div className="text-[15px] font-semibold text-ink mt-0.5">{title}</div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">DealRipe read</div>
          <div className={`text-[26px] font-bold leading-none tracking-tight ${saved ? "text-accent" : "text-danger"}`}>{shownPct}%</div>
          <div className="text-[11px] text-muted mt-0.5">rep has {repPct}%</div>
        </div>
      </div>

      <div className="px-6 py-5 space-y-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted mb-1">What DealRipe caught</div>
          <p className="text-[13.5px] text-ink leading-relaxed">
            {stakeholderName}, the {stakeholderRole} who signs a purchase this size, has never been on a call. Your champion{" "}
            {championName} did the internal work, but the signer has not been in the room. {motionNote}
          </p>
        </div>

        <div className="rounded-lg border border-line bg-white px-4 py-3.5">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-accent mb-1">What your best reps do here</div>
          <p className="text-[13.5px] text-ink leading-relaxed">{actionTitle}</p>
          <p className="text-[12px] text-muted mt-1.5">{bestRepNote}</p>
        </div>

        {phase === "flagged" && (
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => setModalOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl2 bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 transition"
            >
              Take the prescribed action →
            </button>
            <span className="text-[12px] text-muted">{money(gapAtRiskUsd)} of this deal is at risk on the current read.</span>
          </div>
        )}

        {phase === "sent" && (
          <div className="space-y-3">
            <div className="rounded-lg border border-line bg-white px-4 py-3.5 text-[13px] text-ink flex items-start gap-2">
              <span className="text-accent font-bold mt-[1px]">✓</span>
              <span>
                Sent to {championName} — proposed three times for the risk review with {stakeholderName}. DealRipe holds the read at{" "}
                <span className="font-semibold">{drBeforePct}%</span> until the outcome lands; a sent email is activity, not evidence.
              </span>
            </div>
            <button
              onClick={logOutcome}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl2 bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 transition"
            >
              Outcome: {stakeholderName} accepted and joined the call →
            </button>
          </div>
        )}

        {phase === "saved" && (
          <div className="rounded-lg border border-accent/30 bg-accent/[0.06] px-4 py-3.5">
            <div className="flex items-start gap-2 text-[13.5px] text-ink">
              <span className="text-accent font-bold mt-[1px]">✓</span>
              <span>
                {stakeholderName} joined the risk review with {championName}. DealRipe re-rated the deal{" "}
                <span className="font-semibold">{drBeforePct}% → {drAfterPct}%</span> on the new evidence and cleared the at-risk flag.{" "}
                <span className="font-semibold text-accent">{money(gapAtRiskUsd)} that was at risk is now defensible.</span>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* The drafted email, ready to send. */}
      {modalOpen && draft && (
        <div onClick={() => setModalOpen(false)} className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl2 shadow-lg w-full max-w-[600px] max-h-[88vh] flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-4 shrink-0">
              <div>
                <div className="text-[10px] uppercase tracking-wider font-bold text-accent">DealRipe drafted this in {championName.split(" ")[0]}&rsquo;s rep&rsquo;s voice</div>
                <div className="text-[16px] font-semibold text-ink mt-0.5">Follow-up email</div>
              </div>
              <button onClick={() => setModalOpen(false)} aria-label="Close" className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-bg transition text-[15px]">✕</button>
            </div>
            <div className="px-5 py-4 overflow-auto space-y-3">
              <Field label="To" value={draft.to} />
              <Field label="Subject" value={draft.subject} />
              <div>
                <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">Body</div>
                <div className="text-[13px] text-ink leading-relaxed whitespace-pre-wrap bg-bg rounded-lg border border-line p-3.5">{draft.body}</div>
              </div>
            </div>
            <div className="px-5 py-4 border-t border-line flex items-center justify-between gap-3 shrink-0">
              <span className="text-[11.5px] text-muted">Review, then send.</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setModalOpen(false)} className="text-[13px] font-semibold text-muted hover:text-ink transition px-2">Cancel</button>
                <button onClick={sendEmail} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-accent text-white text-[13px] font-semibold hover:bg-accent/90 transition">
                  Send email →
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">{label}</div>
      <div className="text-[13px] text-ink font-medium leading-snug">{value}</div>
    </div>
  );
}
