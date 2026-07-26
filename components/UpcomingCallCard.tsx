"use client";

import { useEffect, useState } from "react";

import type { SentMessage } from "@/lib/sent-messages";

/**
 * The deal's next call, with its pre-call briefing one click away. If a briefing
 * has been prepared, the whole card is a button that opens the exact briefing the
 * rep received, in a large modal (sandboxed iframe). This is the "before the call"
 * half of the AE flow on the deal page.
 */
export function UpcomingCallCard({
  when,
  subtitle,
  briefing,
}: {
  when: string;
  subtitle: string;
  briefing: SentMessage | null;
}) {
  const [open, setOpen] = useState(false);

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

  const inner = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Upcoming call</div>
        {briefing && <div className="text-[10px] uppercase tracking-wider font-semibold text-accent">Briefing ready</div>}
      </div>
      <div className="text-[15px] font-semibold text-ink mt-1.5">{when}</div>
      <div className={`text-[12px] mt-1 ${briefing ? "text-accent font-medium" : "text-muted"}`}>{subtitle}</div>
      {briefing && <div className="text-[12px] text-accent font-semibold mt-2">Open pre-call briefing →</div>}
    </>
  );

  return (
    <>
      {briefing ? (
        <button
          onClick={() => setOpen(true)}
          className="w-full text-left bg-white rounded-xl2 shadow-card border border-line px-5 py-4 hover:border-accent/40 hover:bg-bg/40 transition"
        >
          {inner}
        </button>
      ) : (
        <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">{inner}</div>
      )}

      {open && briefing && (
        <div onClick={() => setOpen(false)} className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl2 shadow-lg w-full max-w-[1080px] h-[90vh] flex flex-col overflow-hidden">
            <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-line shrink-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-accent/10 text-accent">Pre-call</span>
                  <span className="text-[14px] font-medium text-ink truncate">{briefing.subject}</span>
                </div>
                <div className="text-[11px] text-muted mt-1">Prepared for {when}</div>
              </div>
              <button onClick={() => setOpen(false)} aria-label="Close" className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-bg transition text-[15px]">✕</button>
            </div>
            <iframe title={briefing.subject} srcDoc={briefing.bodyHtml} sandbox="" className="w-full flex-1 bg-white border-0 block" />
          </div>
        </div>
      )}
    </>
  );
}
