"use client";

import { useEffect, useState } from "react";
import { LocalTime } from "./LocalTime";
import type { SentMessage } from "@/lib/sent-messages";

function kindLabel(kind: string): string {
  return kind === "briefing" ? "Pre-call" : kind === "no_show_draft" ? "No-show draft" : "Recap";
}
function kindCls(kind: string): string {
  return kind === "briefing"
    ? "bg-accent/10 text-accent"
    : kind === "no_show_draft"
      ? "bg-warn/10 text-warn"
      : "bg-ink/[0.06] text-ink";
}

/**
 * The exact briefings and recaps DealRipe emailed the rep for this deal, newest
 * first. Clicking a row opens the real HTML body in a modal (a sandboxed iframe),
 * so what you see is byte-for-byte what was sent.
 */
export function SentCommsCard({ messages }: { messages: SentMessage[] }) {
  const [open, setOpen] = useState<SentMessage | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
      <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Sent communications</div>

      {messages.length === 0 ? (
        <div className="text-[13px] text-muted mt-1.5">
          No briefings or recaps sent yet. They appear here the moment DealRipe emails the rep.
        </div>
      ) : (
        <div className="mt-2.5 space-y-2">
          {messages.map((m) => (
            <button
              key={m.id}
              onClick={() => setOpen(m)}
              className="w-full text-left border border-line rounded-lg px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-bg/60 hover:border-line transition"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className={`text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${kindCls(m.kind)}`}>
                  {kindLabel(m.kind)}
                </span>
                <span className="text-[13px] text-ink truncate">{m.subject}</span>
              </span>
              <span className="text-[11px] text-muted whitespace-nowrap flex items-center gap-2">
                <LocalTime iso={m.sentAt} />
                <span className="text-accent">Open</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {open && (
        <div
          onClick={() => setOpen(null)}
          className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-xl2 shadow-lg w-full max-w-[1080px] h-[90vh] flex flex-col overflow-hidden"
          >
            <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-line shrink-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded ${kindCls(open.kind)}`}>
                    {kindLabel(open.kind)}
                  </span>
                  <span className="text-[14px] font-medium text-ink truncate">{open.subject}</span>
                </div>
                <div className="text-[11px] text-muted mt-1">
                  To: {open.toEmail} · <LocalTime iso={open.sentAt} />
                </div>
              </div>
              <button
                onClick={() => setOpen(null)}
                aria-label="Close"
                className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-bg transition text-[15px]"
              >
                ✕
              </button>
            </div>
            <iframe title={open.subject} srcDoc={open.bodyHtml} sandbox="" className="w-full flex-1 bg-white border-0 block" />
          </div>
        </div>
      )}
    </div>
  );
}
