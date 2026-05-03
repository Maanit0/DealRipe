import Link from "next/link";
import type { CallRecord } from "@/lib/seed-data";

type Props = {
  dealId: string;
  calls: CallRecord[];
};

export function GongCallsCard({ dealId, calls }: Props) {
  const ordered = [...calls].sort((a, b) => (a.date < b.date ? 1 : -1));

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-5 py-4 border-b border-line flex items-center justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Recent calls from Gong</h2>
          <p className="text-[12px] text-muted mt-0.5">
            Synced 2 minutes ago
          </p>
        </div>
        <GongMark />
      </div>
      <div className="divide-y divide-line">
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
                  <span className="shrink-0 inline-block text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full bg-warnSoft text-warn">
                    Not extracted
                  </span>
                ) : (
                  <span className="shrink-0 inline-block text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded-full bg-accentSoft text-accent">
                    Extracted
                  </span>
                )}
              </div>
              {pending && (
                <div className="mt-2.5">
                  <Link
                    href={`/deals/${dealId}/extract?callId=${call.id}`}
                    className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-accent hover:text-accent/80 transition"
                  >
                    Extract Scotsman fields from this call
                    <span aria-hidden>→</span>
                  </Link>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GongMark() {
  return (
    <span className="text-[10px] uppercase tracking-wider font-bold text-muted">
      Gong
    </span>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
