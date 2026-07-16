"use client";

import { useState, useTransition } from "react";
import { classifyCall } from "@/lib/call-outcome-action";
import type { CallRecord } from "@/lib/seed-data";

type Props = {
  dealId: string;
  calls: CallRecord[];
};

// Outcomes where the bot joined but captured no substantive conversation.
const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled", "placeholder"]);
const LABEL: Record<string, string> = {
  no_conversation: "No conversation captured",
  no_show: "No-show",
  rescheduled: "Rescheduled",
  placeholder: "Placeholder",
};
const CLASSIFY: Array<{ key: string; label: string }> = [
  { key: "no_show", label: "No-show" },
  { key: "rescheduled", label: "Rescheduled" },
  { key: "placeholder", label: "Placeholder" },
];

/**
 * Recent calls for the Magaya account (Teams, no Gong). A call the bot joined
 * but where nobody had a real conversation (no-show or placeholder) is shown as
 * such, not blank and not a misleading "Extracted", and the rep can classify
 * why in one click so it becomes a clean forecasting signal.
 */
export function TeamsCallsCard({ dealId, calls }: Props) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [reopen, setReopen] = useState<Record<string, boolean>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const todayStr = new Date().toISOString().slice(0, 10);
  const ordered = [...calls]
    .filter((c) => (c.date ?? "").slice(0, 10) <= todayStr)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  function classify(callId: string, outcome: string) {
    setOverrides((o) => ({ ...o, [callId]: outcome })); // optimistic
    setReopen((r) => ({ ...r, [callId]: false }));
    setBusyId(callId);
    startTransition(async () => {
      await classifyCall(callId, outcome, dealId);
      setBusyId(null);
    });
  }

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-5 py-4 border-b border-line flex items-center justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Recent calls</h2>
          <p className="text-[12px] text-muted mt-0.5">Synced from Teams</p>
        </div>
        <span className="text-[10px] uppercase tracking-wider font-bold text-muted">Teams</span>
      </div>
      <div className="divide-y divide-line">
        {ordered.length === 0 && (
          <div className="px-5 py-4 text-[12px] text-muted">
            No calls synced yet. The DealRipe note-taker joins the pilot
            deal&rsquo;s Teams meetings once the rep connects their calendar.
          </div>
        )}
        {ordered.map((call) => {
          const outcome = overrides[call.id] ?? call.outcome ?? null;
          const noContent = outcome !== null && NO_CONTENT.has(outcome);
          const pending = !call.hasBeenExtracted && !noContent;
          const unclassified = outcome === "no_conversation";

          return (
            <div key={call.id} className="px-5 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ink leading-snug">
                    {formatDate(call.date)}
                    {noContent ? (
                      <span className="text-muted font-normal"> · bot joined, no conversation</span>
                    ) : (
                      <span> · {call.durationMinutes} min</span>
                    )}
                  </div>
                  {call.participants.length > 0 && (
                    <div className="text-[12px] text-muted mt-0.5 truncate">
                      {call.participants.join(", ")}
                    </div>
                  )}
                </div>
                {noContent ? (
                  <span className="shrink-0 inline-block text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full bg-warnSoft text-warn">
                    {LABEL[outcome] ?? "No conversation"}
                  </span>
                ) : pending ? (
                  <span className="shrink-0 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full bg-warnSoft text-warn">
                    <span className="w-1.5 h-1.5 rounded-full bg-warn animate-pulse" />
                    Processing
                  </span>
                ) : (
                  <span className="shrink-0 inline-block text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full bg-accentSoft text-accent">
                    Extracted
                  </span>
                )}
              </div>

              {noContent && (unclassified || reopen[call.id]) && (
                <div className="mt-2.5 flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] text-muted mr-0.5">What happened?</span>
                  {CLASSIFY.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      disabled={busyId === call.id}
                      onClick={() => classify(call.id, c.key)}
                      className={`text-[11px] font-semibold px-2 py-1 rounded-md border transition disabled:opacity-50 ${
                        outcome === c.key
                          ? "border-ink bg-ink text-white"
                          : "border-line bg-white text-ink hover:border-ink/30"
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                  {!unclassified && (
                    <button
                      type="button"
                      disabled={busyId === call.id}
                      onClick={() => classify(call.id, "no_conversation")}
                      className="text-[11px] font-semibold px-2 py-1 rounded-md border border-line bg-white text-muted hover:border-ink/30 transition disabled:opacity-50"
                    >
                      Not sure yet
                    </button>
                  )}
                </div>
              )}
              {noContent && !unclassified && !reopen[call.id] && (
                <div className="mt-1.5">
                  <button
                    type="button"
                    onClick={() => setReopen((r) => ({ ...r, [call.id]: true }))}
                    className="text-[11px] text-muted underline underline-offset-2 hover:text-ink transition"
                  >
                    Change
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
