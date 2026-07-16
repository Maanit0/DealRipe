import type { DealState } from "@/lib/deal-state";

const STAGE_LABELS: Record<string, string> = {
  SQL0: "Lead",
  SQL1: "Develop Opportunity (Qualify)",
  SQL2: "Solution Finalization (Develop)",
  SQL3: "Proposal Validation (Prove)",
  SQL4: "Negotiations",
  SQL5: "Agreement Formalization",
};

function label(key: string): string {
  return STAGE_LABELS[key] ? `${key} · ${STAGE_LABELS[key]}` : key;
}

function rank(key: string): number {
  const m = key.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * The glance layer: where the deal stands before the 27-gate audit. Reads only
 * the derived DealState. Shows confirmed/total, how far the captured signal
 * reaches vs the nominal stage (advanced-but-with-gaps), the top open gaps, and
 * whether a firm next step exists.
 */
export function DealStateCard({ state }: { state: DealState }) {
  const { confirmed, total, stageKey, reachedStageKey, topGaps, nextStepAnswer } = state;
  const aheadOfStage =
    reachedStageKey !== null && rank(reachedStageKey) > rank(stageKey);

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-6 py-5">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <h2 className="text-[15px] font-semibold text-ink">Where this deal stands</h2>
        <span className="text-[12px] text-muted">
          {confirmed} of {total} gates confirmed
        </span>
      </div>

      <p className="text-[13px] leading-relaxed text-ink mt-2">
        {reachedStageKey ? (
          <>
            Captured signal reaches <span className="font-semibold">{label(reachedStageKey)}</span>
            {aheadOfStage ? (
              <>
                , ahead of the deal&rsquo;s {label(stageKey)} stage, so the story is running
                faster than the gates beneath it are filled.
              </>
            ) : (
              <>.</>
            )}
          </>
        ) : (
          <>No gates confirmed yet.</>
        )}
      </p>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
            Top gaps to close
          </div>
          {topGaps.length === 0 ? (
            <div className="text-[13px] text-muted mt-1.5">
              No open gaps beneath the current signal.
            </div>
          ) : (
            <ul className="mt-1.5 space-y-1">
              {topGaps.map((g) => (
                <li key={g.fieldKey} className="text-[13px] text-ink flex items-start gap-2">
                  <span className="text-danger mt-[3px] text-[9px]">&#9679;</span>
                  <span>
                    {g.label}
                    <span className="text-muted"> &middot; {g.stageKey}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
            Next step
          </div>
          {nextStepAnswer ? (
            <div className="text-[13px] text-ink mt-1.5">{nextStepAnswer}</div>
          ) : (
            <div className="text-[13px] text-warn font-medium mt-1.5">
              No firm next step captured, a mutual action plan with a date is the gap.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
