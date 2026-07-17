import Link from "next/link";
import type { TimelineEntry } from "@/lib/deal-history";

function fmt(iso: string | null): string {
  if (!iso) return "unknown date";
  try {
    // Force UTC so a 16:30Z timestamp never tips to the previous day when
    // rendered in a behind-UTC timezone.
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

/**
 * How the deal progressed across meetings: one entry per captured call, newest
 * first. Each is expandable to inspect exactly what that call moved, the gates
 * it confirmed with the verbatim quote behind each, so a sales leader can go
 * back and review any single meeting.
 */
export function DealHistoryCard({
  dealId,
  timeline,
}: {
  dealId: string;
  timeline: TimelineEntry[];
}) {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-6 py-5">
      <h2 className="text-[15px] font-semibold text-ink">Deal progression</h2>
      <p className="text-[12px] text-muted mt-0.5">
        What each captured call moved forward. Click a call to inspect it.
      </p>

      {timeline.length === 0 ? (
        <div className="text-[13px] text-muted mt-3">
          No captured calls have confirmed gates yet.
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {timeline.map((entry, i) => (
            <details key={entry.callId} className="group border border-line rounded-lg overflow-hidden">
              <summary className="cursor-pointer list-none px-4 py-3 hover:bg-bg/60 transition">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2.5 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${i === 0 ? "bg-accent" : "bg-line"}`} />
                    <span className="text-[13px] font-semibold text-ink">{fmt(entry.callDate)} call</span>
                  </span>
                  <span className="text-[11px] text-muted whitespace-nowrap flex items-center gap-2">
                    {entry.confirmed.length} gate{entry.confirmed.length === 1 ? "" : "s"} confirmed
                    <span className="text-muted/70 group-open:rotate-180 transition-transform">⌄</span>
                  </span>
                </div>
              </summary>
              <div className="border-t border-line px-4 py-3 space-y-3">
                {entry.confirmed.map((g) => (
                  <div key={g.fieldKey}>
                    <div className="flex items-baseline gap-2">
                      <span className="text-[10px] uppercase tracking-wider font-semibold text-accent shrink-0">
                        {g.label}
                      </span>
                    </div>
                    {g.answer && (
                      <div className="text-[12.5px] text-ink leading-snug mt-0.5">{g.answer}</div>
                    )}
                    {g.evidence && (
                      <Link
                        href={`/deals/${dealId}/calls/${entry.callId}/transcript?q=${encodeURIComponent(g.evidence)}`}
                        className="block text-[12px] text-muted italic leading-snug mt-0.5 hover:text-ink transition"
                        title="Open the transcript at this quote"
                      >
                        &ldquo;{g.evidence}&rdquo;
                      </Link>
                    )}
                  </div>
                ))}
                <Link
                  href={`/deals/${dealId}/calls/${entry.callId}/transcript`}
                  className="inline-block text-[11px] font-semibold text-accent hover:underline mt-1"
                >
                  View full transcript →
                </Link>
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
