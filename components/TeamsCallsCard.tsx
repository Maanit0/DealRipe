import type { CallRecord } from "@/lib/seed-data";

type Props = {
  dealId: string;
  calls: CallRecord[];
};

/**
 * Calls card for the Magaya account. Magaya runs on Microsoft Teams; the
 * DealRipe note-taker joins their Teams meetings (no Gong). Mirrors the
 * GongCallsCard design but Teams-branded and framework-neutral copy.
 */
export function TeamsCallsCard({ dealId, calls }: Props) {
  // "Recent calls" = calls that have already happened. Future meetings live in
  // the Upcoming call card, not here, so a scheduled call never shows as
  // "Processing".
  const todayStr = new Date().toISOString().slice(0, 10);
  const ordered = [...calls]
    .filter((c) => (c.date ?? "").slice(0, 10) <= todayStr)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-5 py-4 border-b border-line flex items-center justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Recent calls</h2>
          <p className="text-[12px] text-muted mt-0.5">Synced from Teams</p>
        </div>
        <span className="text-[10px] uppercase tracking-wider font-bold text-muted">
          Teams
        </span>
      </div>
      <div className="divide-y divide-line">
        {ordered.length === 0 && (
          <div className="px-5 py-4 text-[12px] text-muted">
            No calls synced yet. The DealRipe note-taker joins the pilot
            deal&rsquo;s Teams meetings once the rep connects their calendar.
          </div>
        )}
        {ordered.map((call) => {
          const pending = !call.hasBeenExtracted;
          return (
            <div key={call.id} className="px-5 py-3.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-semibold text-ink leading-snug">
                    {formatDate(call.date)} · {call.durationMinutes} min
                  </div>
                  <div className="text-[12px] text-muted mt-0.5 truncate">
                    {call.participants.join(", ")}
                  </div>
                </div>
                {pending ? (
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
