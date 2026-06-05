import Link from "next/link";
import {
  DEALS,
  DUCT,
  DUCT_ORDER,
  REPS,
  formatMoney,
  formatPct,
  paranoiaScore,
  type AwareDeal,
  type DuctKey,
  type Rep,
} from "@/lib/aware-data";
import { DuctLetterChip } from "@/components/aware/DuctStatusPill";

export default function AwarePipelinePage() {
  const repTotal = DEALS.reduce((s, d) => s + d.arr, 0);
  const ripeAdjusted = DEALS.reduce((s, d) => {
    // Quick proxy: full ARR if both rep and Blind Spot agree on quarter; else discount.
    const sameQ = d.repCloseQuarter === d.ripeCloseQuarter;
    return s + (sameQ ? d.arr : d.arr * 0.5);
  }, 0);
  const slipping = DEALS.filter(
    (d) => d.repCloseQuarter !== d.ripeCloseQuarter,
  ).length;

  return (
    <div className="min-h-screen bg-bg font-sans text-ink antialiased">
      <Header />
      <main className="max-w-[1200px] mx-auto px-6 py-8">
        <ForecastTotalsBar
          repTotal={repTotal}
          ripeTotal={ripeAdjusted}
          slipping={slipping}
        />

        <div className="mt-8">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-[18px] font-semibold tracking-tight text-ink">
              Active deals
            </h2>
            <span className="text-[12px] text-muted">
              {DEALS.length} deals &middot; click any deal to drill in
            </span>
          </div>

          <div className="space-y-4">
            {DEALS.map((d) => (
              <DealCard key={d.id} deal={d} />
            ))}
          </div>
        </div>

        <div className="mt-12">
          <div className="mb-4">
            <h2 className="text-[18px] font-semibold tracking-tight text-ink">
              Rep performance
            </h2>
            <p className="text-[12.5px] text-muted mt-1">
              Share of deals where each DUCT gate is filled with evidence quotes
              from the customer, not just gates checked. Win rate over the last
              eight quarters.
            </p>
          </div>
          <RepTable />
        </div>
      </main>
      <Footer />
    </div>
  );
}

// ===========================================================
// Header / Footer
// ===========================================================
function Header() {
  return (
    <header className="border-b border-line bg-white">
      <div className="max-w-[1200px] mx-auto px-6 py-5 flex items-center justify-between">
        <div>
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-0.5">
            Aware, Inc.
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-[20px] font-bold tracking-tight text-ink">
              Blind Spot
            </span>
            <span className="text-[11px] text-muted">Powered by DealRipe</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-muted">Sales methodology</div>
          <div className="text-[14px] font-bold text-ink mt-0.5">
            DUCT &middot; configured for Brian Krause
          </div>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line bg-white mt-16">
      <div className="max-w-[1200px] mx-auto px-6 py-5 flex items-center justify-between">
        <span className="text-[11px] text-muted">
          Demo build for Aware, Inc. Configured by DealRipe.
        </span>
        <Link
          href="/pipeline"
          className="text-[11px] font-semibold text-muted hover:text-ink transition"
        >
          Switch to TopSort demo
        </Link>
      </div>
    </footer>
  );
}

// ===========================================================
// Forecast totals bar
// ===========================================================
function ForecastTotalsBar({
  repTotal,
  ripeTotal,
  slipping,
}: {
  repTotal: number;
  ripeTotal: number;
  slipping: number;
}) {
  const gap = repTotal - ripeTotal;
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line p-6">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-6">
        <Metric label="Rep total" value={formatMoney(repTotal)} note="Q2 commit" muted />
        <Metric
          label="Blind Spot total"
          value={formatMoney(ripeTotal)}
          note={`${slipping} of ${DEALS.length} deals slipping`}
          accent
        />
        <Metric
          label="Gap"
          value={formatMoney(gap)}
          note="Rep above Blind Spot"
          danger
        />
        <Metric label="Pipeline" value={formatMoney(repTotal)} note="3 active deals" />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  note,
  muted,
  accent,
  danger,
}: {
  label: string;
  value: string;
  note: string;
  muted?: boolean;
  accent?: boolean;
  danger?: boolean;
}) {
  const valueCls = danger
    ? "text-danger"
    : accent
      ? "text-ink"
      : muted
        ? "text-muted"
        : "text-ink";
  const weight = accent || danger ? "font-bold" : "font-semibold";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">
        {label}
      </div>
      <div className={`text-[28px] tracking-tight leading-none ${weight} ${valueCls}`}>
        {value}
      </div>
      <div className="text-[11px] text-muted mt-1.5">{note}</div>
    </div>
  );
}

// ===========================================================
// Deal card
// ===========================================================
function DealCard({ deal }: { deal: AwareDeal }) {
  const score = paranoiaScore(deal);
  const isSlipping = deal.repCloseQuarter !== deal.ripeCloseQuarter;
  const scoreTone =
    score >= 75 ? "text-accent" : score >= 50 ? "text-warn" : "text-danger";

  return (
    <Link
      href={`/demo/aware/${deal.id}`}
      className="block bg-white rounded-xl2 shadow-card border border-line hover:border-ink/40 transition p-6"
    >
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1">
            <h3 className="text-[18px] font-semibold tracking-tight text-ink">
              {deal.account}
            </h3>
            <span className="text-[11px] text-muted">{deal.vertical}</span>
          </div>
          <p className="text-[13px] text-muted leading-snug max-w-[640px]">
            {deal.headline}
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {DUCT_ORDER.map((k) => (
              <DuctLetterChip
                key={k}
                letter={DUCT[k].letter}
                status={deal.gates[k].status}
              />
            ))}
          </div>
        </div>

        <div className="text-right shrink-0">
          <div className="text-[24px] font-bold text-ink tracking-tight leading-none">
            {formatMoney(deal.arr)}
          </div>
          <div className="text-[11px] text-muted mt-1">ACV</div>
          <div className="mt-3">
            <div className={`text-[28px] font-bold ${scoreTone} leading-none`}>
              {score}
            </div>
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted mt-1">
              Convince me
            </div>
          </div>
        </div>
      </div>

      <div className="mt-5 pt-4 border-t border-line grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ForecastRow
          label="Rep forecast"
          quarter={deal.repCloseQuarter}
          date={deal.repCloseDate}
          rep={deal.repName}
          muted
        />
        <ForecastRow
          label="Blind Spot forecast"
          quarter={deal.ripeCloseQuarter}
          date={deal.ripeCloseDate}
          delta={isSlipping ? deal.forecastDeltaLabel : null}
        />
      </div>
    </Link>
  );
}

function ForecastRow({
  label,
  quarter,
  date,
  rep,
  delta,
  muted,
}: {
  label: string;
  quarter: string;
  date: string;
  rep?: string;
  delta?: string | null;
  muted?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">
        {label}
      </div>
      <div
        className={`text-[14px] leading-snug ${
          muted ? "text-muted" : "text-ink font-semibold"
        }`}
      >
        {quarter} &middot; {date}
        {rep && <span className="text-muted"> &middot; {rep}</span>}
      </div>
      {delta && (
        <div className="text-[12px] text-danger font-semibold mt-0.5">
          {delta}
        </div>
      )}
    </div>
  );
}

// ===========================================================
// Rep table
// ===========================================================
function RepTable() {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <table className="w-full text-left">
        <thead className="border-b border-line bg-bg">
          <tr>
            <th className="px-5 py-3 text-[10px] uppercase tracking-wider font-bold text-muted">
              Rep
            </th>
            {DUCT_ORDER.map((k) => (
              <th
                key={k}
                className="px-3 py-3 text-[10px] uppercase tracking-wider font-bold text-muted text-center"
                title={DUCT[k].name}
              >
                {DUCT[k].letter} &middot; {DUCT[k].name}
              </th>
            ))}
            <th className="px-5 py-3 text-[10px] uppercase tracking-wider font-bold text-muted text-right">
              Win rate
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {REPS.map((r) => (
            <RepRow key={r.id} rep={r} />
          ))}
        </tbody>
      </table>
      {REPS.map((r) => (
        <div key={`note-${r.id}`} className="px-5 py-3 border-t border-line text-[12px] text-muted leading-snug">
          <span className="font-semibold text-ink">{r.name}: </span>
          {r.weaknessNote}
        </div>
      ))}
    </div>
  );
}

function RepRow({ rep }: { rep: Rep }) {
  return (
    <tr>
      <td className="px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="w-8 h-8 rounded-full bg-ink text-white flex items-center justify-center text-[11px] font-bold shrink-0">
            {rep.initials}
          </span>
          <div>
            <div className="text-[13.5px] font-semibold text-ink">
              {rep.name}
            </div>
          </div>
        </div>
      </td>
      {DUCT_ORDER.map((k) => {
        const v = rep.scores[k];
        const isWeak = k === rep.weakness && v < 0.6;
        return (
          <td key={k} className="px-3 py-4 text-center">
            <span
              className={`inline-block text-[13px] font-bold ${
                isWeak ? "text-danger" : v >= 0.8 ? "text-accent" : "text-ink"
              }`}
            >
              {formatPct(v)}
            </span>
          </td>
        );
      })}
      <td className="px-5 py-4 text-right">
        <span className="text-[13px] font-bold text-ink">
          {formatPct(rep.winRate)}
        </span>
      </td>
    </tr>
  );
}
