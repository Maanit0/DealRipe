import Link from "next/link";
import type { DigestEntry } from "@/lib/digest";

const STAGE_LABELS: Record<string, string> = {
  SQL0: "Lead",
  SQL1: "Develop Opportunity",
  SQL2: "Solution Finalization",
  SQL3: "Proposal Validation",
  SQL4: "Negotiations",
  SQL5: "Agreement Formalization",
};

/**
 * "What needs your attention" — Mark's decision-first home. Leads with the
 * one deal to start on, then per deal: what changed, the live risks, and the
 * single coaching question to take into the rep conversation.
 */
export function MagayaDigest({
  entries,
  hideHeader = false,
}: {
  entries: DigestEntry[];
  hideHeader?: boolean;
}) {
  if (entries.length === 0) return null;
  const top = entries[0];

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      {!hideHeader && (
        <div className="px-5 py-4 border-b border-line">
          <h2 className="text-[15px] font-semibold text-ink">What needs your attention</h2>
          <p className="text-[12px] text-muted mt-0.5">
            {top.attention > 0
              ? `Start with ${top.account}. ${top.coaching}`
              : "All pilot deals are on track this week."}
          </p>
        </div>
      )}
      <div className="divide-y divide-line">
        {entries.map((e) => (
          <div key={e.dealId} className="px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <Link
                  href={`/deals/${e.dealId}`}
                  className="text-[14px] font-semibold text-ink hover:text-accent transition"
                >
                  {e.account}
                </Link>
                <div className="text-[12px] text-muted mt-0.5">
                  {STAGE_LABELS[e.stage] ?? e.stage} · {e.forecast.confirmed} of{" "}
                  {e.forecast.total} gates confirmed
                </div>
              </div>
              {e.risks.length > 0 && (
                <div className="flex flex-wrap gap-1 justify-end shrink-0">
                  {e.risks.map((r, i) => (
                    <span
                      key={i}
                      className="text-[10px] uppercase tracking-wide font-semibold text-danger bg-danger/[0.06] border border-danger/20 rounded px-1.5 py-0.5"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-2 space-y-0.5">
              {e.changed.map((c, i) => (
                <div key={i} className="text-[12px] text-muted">
                  · {c}
                </div>
              ))}
            </div>

            <div className="mt-2.5 bg-accent/[0.05] border border-accent/20 rounded-lg px-3 py-2">
              <span className="text-[9px] uppercase tracking-wider font-bold text-accent mr-1.5">
                Coach
              </span>
              <span className="text-[12.5px] text-ink leading-snug">{e.coaching}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
