"use client";

import { useEffect, useRef } from "react";

function fmt(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    });
  } catch {
    return "";
  }
}

function parseLine(line: string): { speaker: string | null; text: string } {
  const idx = line.indexOf(": ");
  if (idx > 0 && idx < 40) {
    return { speaker: line.slice(0, idx), text: line.slice(idx + 2) };
  }
  return { speaker: null, text: line };
}

/**
 * Full call transcript, with an optional passage highlighted and scrolled into
 * view, the drill-in from a gate's quote or a timeline entry. Rendered client
 * side only so it can scroll to the highlighted line.
 */
export function TranscriptView({
  body,
  highlight,
  account,
  callDate,
}: {
  body: string;
  highlight?: string;
  account: string;
  callDate: string | null;
}) {
  const markRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    markRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  const hl = (highlight ?? "").trim();
  const lines = body.split("\n").filter((l) => l.trim().length > 0);
  let usedMark = false;

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-6 py-4 border-b border-line">
        <h1 className="text-[16px] font-semibold text-ink">{account} call transcript</h1>
        {callDate && <p className="text-[12px] text-muted mt-0.5">{fmt(callDate)}</p>}
      </div>
      <div className="px-6 py-5 space-y-2.5 max-h-[75vh] overflow-y-auto">
        {lines.map((line, i) => {
          const { speaker, text } = parseLine(line);
          const lower = text.toLowerCase();
          const at = hl ? lower.indexOf(hl.toLowerCase()) : -1;
          let rendered: React.ReactNode = text;
          if (at >= 0) {
            const isFirst = !usedMark;
            usedMark = true;
            rendered = (
              <>
                {text.slice(0, at)}
                <mark
                  ref={isFirst ? markRef : undefined}
                  className="bg-accent/20 text-ink rounded px-0.5"
                >
                  {text.slice(at, at + hl.length)}
                </mark>
                {text.slice(at + hl.length)}
              </>
            );
          }
          return (
            <div key={i} className="text-[13px] leading-relaxed">
              {speaker && (
                <span className="font-semibold text-ink mr-1.5">{speaker}:</span>
              )}
              <span className="text-ink/90">{rendered}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
