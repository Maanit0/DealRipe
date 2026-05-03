import { assessDeal, type Deal } from "@/lib/seed-data";
import type { ExtractionResult, Stage } from "@/lib/scotsman";

type Props = {
  deal: Deal;
  stage: Stage;
  extractionOverride?: ExtractionResult;
  animateForecast?: boolean;
};

export function DealHeaderCard({
  deal,
  stage,
  extractionOverride,
  animateForecast,
}: Props) {
  const effectiveDeal = extractionOverride
    ? { ...deal, extraction: extractionOverride }
    : deal;
  const assessment = assessDeal(effectiveDeal);
  const stuckInStage = deal.daysInStage > 21;
  const forecastAnimClass = animateForecast ? "flash-yes" : "";

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line p-6">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">
            {deal.account}
          </h1>
          <div className="text-[13px] text-muted mt-1">{deal.industry}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[32px] font-bold tracking-tight text-ink leading-none">
            {formatMoney(deal.arr)}
          </div>
          <div className="text-[13px] font-semibold text-ink mt-2">
            {stage.label} · {stage.pct}
          </div>
          <div className="text-[12px] mt-0.5">
            <span
              className={
                stuckInStage ? "text-warn font-semibold" : "text-muted"
              }
            >
              {deal.daysInStage} days in stage
            </span>
          </div>
        </div>
      </div>

      <div className="mt-5 pt-4 border-t border-line grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted mb-1">
            Rep forecast
          </div>
          <div className="text-[13px] text-muted">
            {formatPct(deal.repForecastProbability)} probability ·{" "}
            {quarterOf(deal.repForecastCloseDate)} close ·{" "}
            {formatDate(deal.repForecastCloseDate)}
          </div>
        </div>
        <div className={`rounded-md -mx-2 px-2 py-1 ${forecastAnimClass}`}>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted mb-1">
            DealRipe forecast
          </div>
          <div className="text-[14px] font-semibold text-ink">
            {formatPct(assessment.adjustedProbability)} probability ·{" "}
            {quarterOf(assessment.adjustedCloseDate)} close ·{" "}
            {formatDate(assessment.adjustedCloseDate)}
          </div>
        </div>
      </div>
    </div>
  );
}

function formatMoney(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${v}`;
}

function formatPct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function quarterOf(iso: string): string {
  const d = new Date(iso);
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
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
