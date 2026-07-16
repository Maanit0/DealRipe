import type { TimelineEntry } from "@/lib/deal-history";

function fmt(iso: string | null): string {
  if (!iso) return "unknown date";
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

/**
 * How the deal progressed across meetings: one entry per call, newest first,
 * with the gates that call moved forward. Turns deal inspection from a snapshot
 * into a story, and compounds as more calls land.
 */
export function DealHistoryCard({ timeline }: { timeline: TimelineEntry[] }) {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-6 py-5">
      <h2 className="text-[15px] font-semibold text-ink">Deal progression</h2>
      <p className="text-[12px] text-muted mt-0.5">What each captured call moved forward</p>

      {timeline.length === 0 ? (
        <div className="text-[13px] text-muted mt-3">
          No captured calls have confirmed gates yet.
        </div>
      ) : (
        <ol className="mt-4 space-y-4">
          {timeline.map((entry, i) => (
            <li key={entry.callId} className="relative pl-5">
              <span
                className={`absolute left-0 top-1.5 w-2 h-2 rounded-full ${
                  i === 0 ? "bg-accent" : "bg-line"
                }`}
              />
              {i < timeline.length - 1 && (
                <span className="absolute left-[3px] top-3.5 bottom-[-16px] w-px bg-line" />
              )}
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-[13px] font-semibold text-ink">{fmt(entry.callDate)} call</div>
                <div className="text-[11px] text-muted">
                  {entry.confirmed.length} gate{entry.confirmed.length === 1 ? "" : "s"} confirmed
                </div>
              </div>
              <div className="text-[12px] text-muted mt-1 leading-relaxed">
                {entry.confirmed.map((c) => c.label).join(", ")}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
