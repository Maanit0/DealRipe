"use client";

import { useEffect, useState } from "react";
import { Deal } from "@/lib/deals";
import { CallScore } from "@/lib/scoring";
import { getJson, postJson } from "@/lib/fetcher";
import { CallScoreList } from "./RepView";

export default function CroView({
  deal,
  allMissing,
}: {
  deal: Deal;
  allMissing: string[];
}) {
  const [scores, setScores] = useState<CallScore[]>([]);
  const [insight, setInsight] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setInsight(null);
    setError(null);
    (async () => {
      try {
        const sData = await getJson(`/api/scores?dealId=${deal.id}`);
        const s: CallScore[] = sData.scores || [];
        if (cancelled) return;
        setScores(s);
        const cData = await postJson("/api/coaching", { deal, scores: s });
        if (cancelled) return;
        setInsight(cData.insight || null);
      } catch (e: any) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deal.id]);

  const latest = scores[0] || null;

  return (
    <div className="space-y-4 lg:sticky lg:top-5">
      {/* Coaching intervention — the headline */}
      <div className="bg-navy text-white rounded-xl2 shadow-card p-5">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-1.5 h-1.5 rounded-full bg-accent" />
          <div className="text-[10px] uppercase tracking-wider font-semibold text-white/60">
            Coaching intervention
          </div>
        </div>
        {loading && !insight ? (
          <div className="text-[13px] text-white/60">Generating coaching insight…</div>
        ) : error ? (
          <div className="text-[13px] text-danger">{error}</div>
        ) : (
          <div className="text-[15px] font-medium leading-snug">{insight}</div>
        )}
        <div className="mt-3 pt-3 border-t border-white/10 text-[11px] text-white/50">
          Based on {scores.length} scored {scores.length === 1 ? "call" : "calls"} ·{" "}
          {allMissing.length} open SCOTSMAN {allMissing.length === 1 ? "gap" : "gaps"} ·{" "}
          {deal.lastActivityDays}d since activity
        </div>
      </div>

      {/* Latest call rubric */}
      <div className="bg-white rounded-xl2 shadow-card border border-line p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[15px] font-semibold text-ink">Skills of delivery</h2>
          {latest && (
            <span
              className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                latest.cardinalRuleMet
                  ? "bg-accentSoft text-accent"
                  : "bg-dangerSoft text-danger"
              }`}
            >
              {latest.overall}/6
            </span>
          )}
        </div>

        {!latest ? (
          <div className="text-[12px] text-muted">
            No scored calls yet for this deal. Ask {deal.ae} to log notes from the next call.
          </div>
        ) : (
          <>
            <div className="text-[11px] text-muted mb-3">
              Last call: {new Date(latest.loggedAt).toLocaleString()} · {deal.ae}
            </div>
            <CallScoreList score={latest} />
            {latest.summary && (
              <div className="mt-3 pt-3 border-t border-line text-[12px] text-ink/80 italic">
                "{latest.summary}"
              </div>
            )}
          </>
        )}
      </div>

      {/* Score history */}
      {scores.length > 1 && (
        <div className="bg-white rounded-xl2 shadow-card border border-line p-5">
          <h2 className="text-[15px] font-semibold text-ink mb-3">Call history</h2>
          <div className="space-y-2">
            {scores.slice(1).map(s => (
              <div
                key={s.id}
                className="flex items-center justify-between text-[12px] py-2 border-t border-line first:border-t-0"
              >
                <div>
                  <div className="text-ink">{new Date(s.loggedAt).toLocaleDateString()}</div>
                  <div className="text-muted text-[11px]">{s.summary}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      s.cardinalRuleMet
                        ? "bg-accentSoft text-accent"
                        : "bg-dangerSoft text-danger"
                    }`}
                  >
                    {s.overall}/6
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Open gaps reminder */}
      <div className="bg-white rounded-xl2 shadow-card border border-line p-5">
        <h2 className="text-[15px] font-semibold text-ink mb-2">Open gaps</h2>
        {allMissing.length === 0 ? (
          <div className="text-[12px] text-muted">All 18 SCOTSMAN fields confirmed.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {allMissing.map(id => (
              <span
                key={id}
                className="text-[11px] font-mono font-semibold text-danger bg-dangerSoft px-2 py-0.5 rounded"
              >
                {id}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
