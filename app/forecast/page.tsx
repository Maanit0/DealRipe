"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useRef } from "react";
import {
  TENANT_LIST,
  getTenant,
  type ForecastTenant,
  type Leverage,
  type Movement,
} from "@/lib/forecast-tenants";

// ============================================================
// Page entry. Suspense wrapper required for useSearchParams.
// ============================================================
export default function ForecastRoomPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg" />}>
      <ForecastRoomInner />
    </Suspense>
  );
}

function ForecastRoomInner() {
  const router = useRouter();
  const params = useSearchParams();
  const tenant = getTenant(params.get("tenant"));
  const leverageRef = useRef<HTMLDivElement | null>(null);

  function scrollToLeverage() {
    leverageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function startReview() {
    router.push(`/forecast/review?tenant=${tenant.slug}`);
  }

  return (
    <div className="min-h-screen bg-bg font-sans text-ink antialiased">
      <TopBar tenant={tenant} />

      <main className="max-w-[1180px] mx-auto px-6 py-8 pb-32">
        <PageTitle tenant={tenant} />

        <TheNumber tenant={tenant} onGapClick={scrollToLeverage} />

        <WeekOverWeek tenant={tenant} />

        <div ref={leverageRef}>
          <LeveragePanel tenant={tenant} />
        </div>

        <CalibrationPanel tenant={tenant} />
      </main>

      <StartReviewButton onClick={startReview} />
    </div>
  );
}

// ============================================================
// Top bar with tenant switcher
// ============================================================
function TopBar({ tenant }: { tenant: ForecastTenant }) {
  return (
    <header className="border-b border-line bg-white">
      <div className="max-w-[1180px] mx-auto px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="text-[14px] font-semibold tracking-tight text-ink hover:opacity-80 transition"
          >
            DealRipe
          </Link>
          <nav className="flex items-center gap-4">
            <span className="text-[12px] font-semibold text-ink">
              Forecast Room
            </span>
            <Link
              href="/pipeline"
              className="text-[12px] font-semibold text-muted hover:text-ink transition"
            >
              Pipeline
            </Link>
            <Link
              href="/onboarding"
              className="text-[12px] font-semibold text-muted hover:text-ink transition"
            >
              Setup
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-4">
          <TenantSwitcher active={tenant.slug} />
          <div className="text-right text-[11px] text-muted leading-tight">
            <div>Last updated {tenant.lastUpdatedAgo}</div>
            <div className="flex items-center justify-end gap-1.5 mt-0.5">
              <span className="w-1.5 h-1.5 rounded-full bg-accent" aria-hidden />
              <span>
                {tenant.changedCount} deals changed in the last 24 hours
              </span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function TenantSwitcher({ active }: { active: string }) {
  return (
    <div className="flex items-center bg-bg rounded-lg border border-line p-0.5">
      {TENANT_LIST.map((t) => {
        const isActive = t.slug === active;
        return (
          <Link
            key={t.slug}
            href={`/forecast?tenant=${t.slug}`}
            className={`px-3 py-1.5 rounded-md text-[12px] font-semibold transition ${
              isActive
                ? "bg-white text-ink shadow-sm"
                : "text-muted hover:text-ink"
            }`}
          >
            {t.name}
          </Link>
        );
      })}
    </div>
  );
}

// ============================================================
// Page title
// ============================================================
function PageTitle({ tenant }: { tenant: ForecastTenant }) {
  return (
    <div className="mb-10">
      <h1 className="text-[36px] sm:text-[40px] font-semibold tracking-tight text-ink leading-none">
        Forecast Room
      </h1>
      <p className="mt-3 text-[14px] text-muted">
        Pipeline review for week of {tenant.weekOf}.{" "}
        <span className="text-ink font-semibold">{tenant.name}</span>{" "}
        <span className="text-muted">
          ({tenant.product}, {tenant.framework} framework)
        </span>
      </p>
    </div>
  );
}

// ============================================================
// Section: The Number
// ============================================================
function TheNumber({
  tenant,
  onGapClick,
}: {
  tenant: ForecastTenant;
  onGapClick: () => void;
}) {
  const { quarterTargetUsd, quarterLabel, ripeForecastUsd, repCommitUsd } =
    tenant.numbers;
  const gap = quarterTargetUsd - ripeForecastUsd;
  const overcommit = repCommitUsd - ripeForecastUsd;
  const dealsAtRisk = tenant.movements.filter((m) => m.delta < 0).length;

  return (
    <section className="bg-white rounded-xl2 shadow-card border border-line p-8 mb-12">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-6">
        <MetricCell
          label="Quarter target"
          value={formatMoney(quarterTargetUsd)}
          subline={quarterLabel}
          tone="muted"
        />
        <MetricCell
          label="DealRipe forecast"
          value={formatMoney(ripeForecastUsd)}
          subline="Weighted by close probability"
          tone="ink"
          size="hero"
        />
        <button
          onClick={onGapClick}
          className="text-left group"
          aria-label="Scroll to leverage actions"
        >
          <MetricCell
            label="Gap to target"
            value={formatMoney(gap)}
            valuePrefix={<span className="text-danger">−</span>}
            subline={`${dealsAtRisk} deals can close it`}
            sublineClickable
            tone="danger"
            size="large"
          />
        </button>
        <MetricCell
          label="Rep commit"
          value={formatMoney(repCommitUsd)}
          subline={`Likely overcommit by ${formatMoney(overcommit)}`}
          sublineTone="danger"
          tone="muted"
          size="small"
        />
      </div>

      <div className="mt-8 pt-6 border-t border-line">
        <p className="text-[14px] italic text-muted leading-relaxed max-w-[820px]">
          If you commit the rep number to your board, you will miss by{" "}
          {formatMoney(overcommit)}. If you commit DealRipe&rsquo;s number, you
          have a plan to close to target.
        </p>
      </div>
    </section>
  );
}

function MetricCell({
  label,
  value,
  valuePrefix,
  subline,
  sublineClickable,
  sublineTone,
  tone,
  size = "default",
}: {
  label: string;
  value: string;
  valuePrefix?: React.ReactNode;
  subline: string;
  sublineClickable?: boolean;
  sublineTone?: "danger";
  tone: "ink" | "muted" | "danger";
  size?: "hero" | "large" | "default" | "small";
}) {
  const valueColor =
    tone === "danger"
      ? "text-danger"
      : tone === "muted"
        ? "text-muted"
        : "text-ink";
  const valueSize =
    size === "hero"
      ? "text-[56px] sm:text-[64px]"
      : size === "large"
        ? "text-[44px] sm:text-[48px]"
        : size === "small"
          ? "text-[28px]"
          : "text-[36px]";
  const valueWeight =
    size === "hero" || size === "large" ? "font-bold" : "font-semibold";
  const sublineColor = sublineTone === "danger" ? "text-danger" : "text-muted";

  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-2">
        {label}
      </div>
      <div
        className={`${valueSize} ${valueWeight} ${valueColor} tracking-tight leading-none flex items-baseline`}
      >
        {valuePrefix}
        {value}
      </div>
      <div
        className={`mt-2 text-[12px] leading-snug ${sublineColor} ${
          sublineClickable ? "group-hover:text-ink group-hover:underline" : ""
        }`}
      >
        {subline}
      </div>
    </div>
  );
}

// ============================================================
// Section: Week over week
// ============================================================
function WeekOverWeek({ tenant }: { tenant: ForecastTenant }) {
  const totalDelta = tenant.movements.reduce(
    (sum, m) => sum + (m.thisProb - m.lastProb) * (m.arr / 100),
    0,
  );
  const out = tenant.movements.filter((m) => m.delta < 0).length;
  const inn = tenant.movements.filter((m) => m.delta > 0).length;

  return (
    <section className="mb-12">
      <div className="mb-5">
        <h2 className="text-[18px] font-semibold tracking-tight text-ink">
          What changed this week
        </h2>
        <p className="text-[13px] text-muted mt-1">
          DealRipe forecast deltas with reasons
        </p>
      </div>

      <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
        <table className="w-full text-left">
          <thead className="bg-bg border-b border-line">
            <tr>
              <Th className="pl-5 w-[220px]">Deal</Th>
              <Th className="w-[80px]">ARR</Th>
              <Th className="w-[150px]">Last week</Th>
              <Th className="w-[150px]">This week</Th>
              <Th className="w-[70px] text-right">Delta</Th>
              <Th className="pr-5">Why DealRipe changed</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {tenant.movements.map((m) => (
              <MovementRow key={m.id} m={m} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-3 text-[12.5px] text-muted leading-snug">
        DealRipe net change this week:{" "}
        <span
          className={`font-semibold ${totalDelta < 0 ? "text-danger" : "text-accent"}`}
        >
          {formatSignedMoney(totalDelta)} weighted forecast
        </span>
        . {out} deals moved out, {inn} moved in.
      </div>
    </section>
  );
}

function Th({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`px-3 py-3 text-[10px] uppercase tracking-wider font-bold text-muted ${className ?? ""}`}
    >
      {children}
    </th>
  );
}

function MovementRow({ m }: { m: Movement }) {
  const positive = m.delta > 0;
  const deltaCls = positive
    ? "text-accent"
    : m.delta < 0
      ? "text-danger"
      : "text-muted";
  return (
    <tr>
      <td className="pl-5 px-3 py-3.5">
        <div className="text-[13.5px] font-semibold text-ink leading-snug">
          {m.account}
        </div>
        {m.industry && (
          <div className="text-[11px] text-muted mt-0.5 leading-snug">
            {m.industry}
          </div>
        )}
      </td>
      <td className="px-3 py-3.5">
        <span className="text-[13px] text-ink font-semibold">
          {formatMoney(m.arr)}
        </span>
      </td>
      <td className="px-3 py-3.5">
        <div className="text-[12.5px] text-muted leading-snug">
          {m.lastProb}% &middot; {m.lastQuarter}
          <div className="text-[11px] text-muted">{m.lastDate}</div>
        </div>
      </td>
      <td className="px-3 py-3.5">
        <div className="text-[12.5px] text-ink leading-snug font-semibold">
          {m.thisProb}% &middot; {m.thisQuarter}
          <div className="text-[11px] text-muted font-normal">{m.thisDate}</div>
        </div>
      </td>
      <td className="px-3 py-3.5 text-right">
        <span className={`text-[13.5px] font-bold ${deltaCls}`}>
          {positive ? "+" : ""}
          {m.delta}pt
        </span>
      </td>
      <td className="pr-5 px-3 py-3.5">
        {m.productContext && (
          <p className="text-[11px] uppercase tracking-wider font-semibold text-muted mb-1">
            {m.productContext}
          </p>
        )}
        <p className="text-[12.5px] text-ink leading-snug">{m.reason}</p>
      </td>
    </tr>
  );
}

// ============================================================
// Section: Leverage
// ============================================================
function LeveragePanel({ tenant }: { tenant: ForecastTenant }) {
  const gap = tenant.numbers.quarterTargetUsd - tenant.numbers.ripeForecastUsd;
  return (
    <section className="mb-12">
      <div className="mb-5">
        <h2 className="text-[18px] font-semibold tracking-tight text-ink">
          What closes your {formatMoney(gap)} gap to target
        </h2>
        <p className="text-[13px] text-muted mt-1">
          Five actions ranked by predicted forecast impact
        </p>
      </div>

      <div className="space-y-4">
        {tenant.leverage.map((l, i) => (
          <LeverageCard key={i} index={i + 1} leverage={l} />
        ))}
      </div>

      <div className="mt-5 bg-white rounded-xl2 border border-line p-5">
        <p className="text-[13px] text-ink leading-relaxed">
          {tenant.leverageSummary}
        </p>
      </div>
    </section>
  );
}

function LeverageCard({
  index,
  leverage,
}: {
  index: number;
  leverage: Leverage;
}) {
  const confColor =
    leverage.confidence === "High" ? "text-accent" : "text-warn";

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_260px] gap-0">
        <div className="p-5">
          <div className="flex items-baseline gap-2 mb-2">
            <span className="font-mono text-[11px] font-bold text-muted">
              {String(index).padStart(2, "0")}
            </span>
            <span className="text-[15px] font-semibold text-ink">
              {leverage.account}
            </span>
          </div>
          <p className="text-[13.5px] text-ink leading-relaxed">
            {leverage.action}
          </p>
        </div>

        <div className="border-t md:border-t-0 md:border-l border-line bg-bg p-5 space-y-3">
          {leverage.impacts.map((imp, i) => (
            <div key={i}>
              <div className="text-[10px] uppercase tracking-wider font-bold text-muted">
                {imp.label}
              </div>
              <div
                className={`text-[14px] mt-0.5 text-ink ${imp.bold ? "font-bold" : "font-semibold"}`}
              >
                {imp.value}
              </div>
            </div>
          ))}
          <div className="pt-2 border-t border-line">
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">
              Confidence
            </div>
            <div className={`text-[13px] font-semibold ${confColor}`}>
              {leverage.confidence}
            </div>
            <p className="text-[11px] text-muted leading-snug mt-1">
              {leverage.confidenceNote}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Section: Calibration
// ============================================================
function CalibrationPanel({ tenant }: { tenant: ForecastTenant }) {
  const c = tenant.calibration;
  return (
    <section className="mb-12">
      <div className="mb-5">
        <h2 className="text-[18px] font-semibold tracking-tight text-ink">
          Why trust the DealRipe forecast
        </h2>
        <p className="text-[13px] text-muted mt-1">
          Forecast accuracy over the last 8 quarters
        </p>
      </div>

      <div className="bg-white rounded-xl2 shadow-card border border-line p-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
          <div>
            <div className="text-[56px] font-bold text-accent tracking-tight leading-none">
              {c.ripeAccuracyPct}%
            </div>
            <div className="text-[14px] font-semibold text-ink mt-2">
              DealRipe forecast accuracy
            </div>
            <p className="text-[12px] text-muted mt-1 leading-snug">
              Average deviation from actual close: {formatMoney(c.ripeDeviationUsd)} on deals over {formatMoney(c.ripeDeviationFloorUsd)}.
            </p>
          </div>
          <div>
            <div className="text-[40px] font-semibold text-muted tracking-tight leading-none">
              {c.repAccuracyPct}%
            </div>
            <div className="text-[13px] font-semibold text-muted mt-2">
              Rep commit accuracy
            </div>
            <p className="text-[12px] text-muted mt-1 leading-snug">
              Average overcommit: {formatMoney(c.repOvercommitUsd)} per quarter.
            </p>
          </div>
        </div>

        <div className="mt-6 pt-5 border-t border-line">
          <p className="text-[12.5px] text-muted leading-relaxed">
            DealRipe learned from{" "}
            <span className="font-semibold text-ink">
              {c.dealsTrainedOn} deals
            </span>{" "}
            across your team in the last 8 quarters. Every deal that closes or
            slips makes the next forecast sharper.
          </p>
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Sticky review button
// ============================================================
function StartReviewButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="fixed bottom-6 right-6 inline-flex items-center gap-2 px-5 py-3.5 rounded-xl2 bg-ink text-white text-[14px] font-semibold shadow-cardHover hover:bg-ink/90 transition z-10"
    >
      Start Pipeline Review
      <span aria-hidden>→</span>
    </button>
  );
}

// ============================================================
// Formatters
// ============================================================
function formatMoney(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${v}`;
}

function formatSignedMoney(v: number): string {
  const sign = v >= 0 ? "+" : "−";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1000) return `${sign}$${Math.round(abs / 1000)}K`;
  return `${sign}$${abs}`;
}
