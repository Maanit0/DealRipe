"use client";

import { useEffect, useState } from "react";

import { LocalTime } from "./LocalTime";
import type { DigestSend } from "@/lib/sent-messages";

/**
 * The archived weekly digests, newest first. Clicking a row opens the exact HTML
 * that was emailed in a large modal (sandboxed iframe), so the whole digest is
 * visible at once instead of an inline scroll box.
 */
export function DigestList({ sends }: { sends: DigestSend[] }) {
  const [open, setOpen] = useState<DigestSend | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  if (sends.length === 0) {
    return (
      <div className="mt-6 bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
        No digests sent yet. They appear here the moment one goes out, whether you send it or the 6am job does.
      </div>
    );
  }

  return (
    <div className="mt-5 space-y-2">
      {sends.map((s) => (
        <button
          key={s.id}
          onClick={() => setOpen(s)}
          className="w-full text-left bg-white border border-line rounded-xl2 shadow-card px-5 py-3.5 flex items-center justify-between gap-3 hover:bg-bg/50 transition"
        >
          <span className="min-w-0">
            <span className="text-[13px] font-semibold text-ink truncate block">{s.subject}</span>
            <span className="text-[11px] text-muted">to {s.toEmail}</span>
          </span>
          <span className="text-[11px] text-muted whitespace-nowrap flex items-center gap-2">
            <LocalTime iso={s.sentAt} />
            <span className="text-accent">Open</span>
          </span>
        </button>
      ))}

      {open && (
        <div onClick={() => setOpen(null)} className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl2 shadow-lg w-full max-w-[820px] h-[92vh] flex flex-col overflow-hidden">
            <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-line shrink-0">
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-ink truncate">{open.subject}</div>
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
