import Link from "next/link";
import { notFound } from "next/navigation";
import { DuctGateCard } from "@/components/aware/DuctGateCard";
import { HealthyParanoiaScore } from "@/components/aware/HealthyParanoiaScore";
import { SalesforceSyncButton } from "@/components/aware/SalesforceSyncButton";
import {
  DUCT_ORDER,
  formatMoney,
  getDealById,
  paranoiaScore,
  type AwareDeal,
} from "@/lib/aware-data";

export default function AwareDealPage({
  params,
}: {
  params: { dealId: string };
}) {
  const deal = getDealById(params.dealId);
  if (!deal) notFound();

  const score = paranoiaScore(deal);
  const isSlipping = deal.repCloseQuarter !== deal.ripeCloseQuarter;

  return (
    <div className="min-h-screen bg-bg font-sans text-ink antialiased">
      <header className="border-b border-line bg-white">
        <div className="max-w-[1100px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <Link
              href="/demo/aware"
              className="text-[14px] font-bold tracking-tight text-ink hover:opacity-80 transition"
            >
              Blind Spot
            </Link>
            <span className="text-[11px] text-muted">Powered by DealRipe</span>
          </div>
          <Link
            href="/demo/aware"
            className="text-[12px] font-semibold text-muted hover:text-ink transition"
          >
            ← Back to pipeline
          </Link>
        </div>
      </header>

      <main className="max-w-[1100px] mx-auto px-6 py-8 space-y-8">
        {/* Deal header */}
        <DealHeader deal={deal} score={score} isSlipping={isSlipping} />

        {/* Convince me */}
        <ConvinceMe deal={deal} score={score} />

        {/* What you don't know */}
        <WhatYouDontKnow deal={deal} />

        {/* DUCT gates */}
        <section>
          <div className="mb-4">
            <h2 className="text-[18px] font-semibold tracking-tight text-ink">
              DUCT gates
            </h2>
            <p className="text-[12.5px] text-muted mt-1">
              Each gate scored against Brian's framing. Evidence quotes pulled
              verbatim from Gong call transcripts.
            </p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {DUCT_ORDER.map((k) => (
              <DuctGateCard key={k} gateKey={k} gate={deal.gates[k]} />
            ))}
          </div>
        </section>

        {/* Next-step questions */}
        <NextSteps deal={deal} />

        {/* Salesforce sync */}
        <section>
          <div className="mb-3">
            <h2 className="text-[16px] font-semibold tracking-tight text-ink">
              Write back to Salesforce
            </h2>
            <p className="text-[12.5px] text-muted mt-1">
              Push the four DUCT field values to the {deal.account} opportunity
              record. Field names match Aware's existing Salesforce schema.
            </p>
          </div>
          <SalesforceSyncButton deal={deal} />
        </section>
      </main>
    </div>
  );
}

// ===========================================================
// Sections
// ===========================================================
function DealHeader({
  deal,
  score,
  isSlipping,
}: {
  deal: AwareDeal;
  score: number;
  isSlipping: boolean;
}) {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line p-6">
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1">
            {deal.vertical}
          </div>
          <h1 className="text-[28px] font-bold tracking-tight text-ink leading-tight">
            {deal.account}
          </h1>
          <p className="text-[13px] text-muted leading-relaxed mt-2 max-w-[640px]">
            {deal.headline}
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[28px] font-bold tracking-tight text-ink leading-none">
            {formatMoney(deal.arr)}
          </div>
          <div className="text-[11px] text-muted mt-1">ACV</div>
        </div>
      </div>

      <div className="mt-6 pt-5 border-t border-line grid grid-cols-1 md:grid-cols-3 gap-5">
        <ForecastBlock
          label="Rep forecast"
          quarter={deal.repCloseQuarter}
          date={deal.repCloseDate}
          extra={`Rep: ${deal.repName}`}
          muted
        />
        <ForecastBlock
          label="Blind Spot forecast"
          quarter={deal.ripeCloseQuarter}
          date={deal.ripeCloseDate}
          extra={isSlipping ? deal.forecastDeltaLabel : "On track"}
          danger={isSlipping}
        />
        <div>
          <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1">
            Champion
          </div>
          <div className="text-[14px] font-semibold text-ink leading-snug">
            {deal.champion}
          </div>
          <div className="text-[12px] text-muted mt-0.5">
            {deal.championRole}
          </div>
          <div className="text-[11.5px] text-muted mt-1.5 leading-snug">
            {deal.championAuthorityNote}
          </div>
        </div>
      </div>

      {deal.forecastDiscrepancyNote && (
        <div className="mt-4 bg-warnSoft border border-warn/30 rounded-lg px-4 py-3">
          <div className="text-[10px] uppercase tracking-wider font-bold text-warn mb-1">
            Forecast discrepancy
          </div>
          <p className="text-[13px] text-ink leading-snug">
            {deal.forecastDiscrepancyNote}
          </p>
        </div>
      )}
    </div>
  );
}

function ForecastBlock({
  label,
  quarter,
  date,
  extra,
  muted,
  danger,
}: {
  label: string;
  quarter: string;
  date: string;
  extra: string;
  muted?: boolean;
  danger?: boolean;
}) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1">
        {label}
      </div>
      <div
        className={`text-[14px] leading-snug font-semibold ${
          muted ? "text-muted" : "text-ink"
        }`}
      >
        {quarter}
      </div>
      <div className={`text-[12.5px] ${muted ? "text-muted" : "text-ink"}`}>
        {date}
      </div>
      <div
        className={`text-[11.5px] mt-1 ${
          danger ? "text-danger font-semibold" : "text-muted"
        }`}
      >
        {extra}
      </div>
    </div>
  );
}

function ConvinceMe({ deal, score }: { deal: AwareDeal; score: number }) {
  const scoreText =
    deal.scoreInterpretation ??
    (score >= 75
      ? "Most gates evidenced. Read the discrepancy note."
      : score >= 50
        ? "Half the story is missing or contradicted by evidence."
        : "Most gates open or contradicted. Stop forecasting this deal until you close gaps.");

  return (
    <section className="bg-white rounded-xl2 shadow-card border border-line p-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1">
            Convince me this deal will close
          </div>
          <h2 className="text-[20px] font-semibold tracking-tight text-ink">
            Healthy paranoia score
          </h2>
          <p className="text-[12.5px] text-muted mt-2 max-w-[520px] leading-snug">
            Share of DUCT gates that are green AND backed by at least one
            customer evidence quote. Not just gates checked.
          </p>
          <p className="text-[13px] text-ink mt-3 leading-snug max-w-[560px]">
            {scoreText}
          </p>
        </div>
        <div className="text-right shrink-0">
          <HealthyParanoiaScore score={score} />
        </div>
      </div>
    </section>
  );
}

function WhatYouDontKnow({ deal }: { deal: AwareDeal }) {
  return (
    <section className="bg-white rounded-xl2 shadow-card border border-line p-6">
      <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1">
        Run this exercise with the rep
      </div>
      <h2 className="text-[20px] font-semibold tracking-tight text-ink">
        What don't you know about this deal?
      </h2>
      <ul className="mt-4 space-y-2.5">
        {deal.whatYouDontKnow.map((q, i) => (
          <li key={i} className="flex gap-3 items-start">
            <span className="w-5 h-5 rounded-full bg-dangerSoft flex items-center justify-center shrink-0 mt-0.5">
              <span className="text-[11px] font-bold text-danger">?</span>
            </span>
            <span className="text-[14px] text-ink leading-snug">{q}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NextSteps({ deal }: { deal: AwareDeal }) {
  return (
    <section className="bg-white rounded-xl2 shadow-card border border-line p-6">
      <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-1">
        Closed-loop briefing
      </div>
      <h2 className="text-[20px] font-semibold tracking-tight text-ink">
        Questions to ask on the next call
      </h2>
      <p className="text-[12.5px] text-muted mt-2 max-w-[600px] leading-snug">
        Generated from the open DUCT gates above. Drop these into your rep's
        next call agenda.
      </p>
      <ol className="mt-5 space-y-3.5">
        {deal.nextStepQuestions.map((q, i) => (
          <li key={i} className="flex gap-3 items-start">
            <span className="w-6 h-6 rounded-full bg-ink text-white flex items-center justify-center text-[11px] font-bold shrink-0 mt-0.5">
              {i + 1}
            </span>
            <span className="text-[14px] text-ink leading-relaxed flex-1 min-w-0">
              {q}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
