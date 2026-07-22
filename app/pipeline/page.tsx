import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { MagayaPipeline } from "@/components/MagayaPipeline";
import { getPilotDigest } from "@/lib/digest";
import { getFrameworkForDeal } from "@/lib/framework";
import { SCOTSMAN_FIELDS, type Stage } from "@/lib/scotsman";
import {
  ALL_DEALS,
  assessDeal,
  getStageForDeal,
  type Deal,
  type DealRipeAssessment,
} from "@/lib/seed-data";
import { rolldogOppIdForDeal } from "@/lib/pilot-config";
import { prewarmRolldogToken } from "@/lib/rolldog";
import { getCrmBaseline } from "@/lib/crm-baseline";
import {
  daysSince,
  getRolldogSummary,
  repLastActivityIso,
  stageKeyFromSummary,
  type RolldogSummary,
} from "@/lib/rolldog-summary";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getDealsForTenant,
  getUpcomingCallsForTenant,
} from "@/lib/supabase-queries";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

async function loadMagayaPipeline() {
  try {
    const tenantId = await resolveTenantId("magaya");
    const deals = await getDealsForTenant(tenantId);
    const framework = deals.length > 0 ? await getFrameworkForDeal(deals[0].id) : null;
    // A digest failure must not knock the whole pipeline back to the demo.
    const digest = await getPilotDigest(tenantId).catch((e) => {
      console.error("[magaya pipeline] digest failed:", e);
      return [];
    });
    const upcoming = await getUpcomingCallsForTenant(tenantId).catch((e) => {
      console.error("[magaya pipeline] upcoming calls failed:", e);
      return {};
    });

    // Live Rolldog signals per deal, best-effort, parallel: deal size, score,
    // and CRM process dates (stage entry, created, updated). We also derive the
    // rep's true last-activity by attributing updated-at away from DealRipe's
    // own write-backs, using the write-back stamp and the day-0 baseline.
    const summaries: Record<string, RolldogSummary> = {};
    const repActivity: Record<string, string | null> = {};
    try {
      const idRows = await supabaseAdmin()
        .from("deals")
        .select("id, external_id, rolldog_opportunity_id, dealripe_last_writeback_at")
        .eq("tenant_id", tenantId);
      // Warm the Rolldog token once so the parallel reads below share it,
      // instead of racing to fetch a token at the same instant on a cold load
      // (which gets throttled and leaves deals blank). Best-effort.
      await prewarmRolldogToken().catch(() => {});
      await Promise.all(
        (idRows.data ?? []).map(async (r) => {
          // Resolve the opp the same way write-back does: the pilot-config map
          // for seeded deals, else the rolldog_opportunity_id column that
          // link-deal writes for auto-linked deals (Aeronet, Core Logistics).
          const opp =
            (r.external_id ? rolldogOppIdForDeal(r.external_id) : null) ??
            r.rolldog_opportunity_id ??
            null;
          if (!opp) return;
          const [live, baseline] = await Promise.all([
            getRolldogSummary(opp),
            getCrmBaseline(r.id).catch(() => null),
          ]);
          // Live read preferred; fall back to the frozen day-0 baseline so a
          // throttled read shows the CRM's captured value, not a blank "—".
          const s = live ?? baseline?.summary ?? null;
          if (s) summaries[r.id] = s;
          repActivity[r.id] = repLastActivityIso({
            liveUpdatedAt: s?.updatedAt ?? null,
            dealripeLastWriteback: r.dealripe_last_writeback_at,
            baselineUpdatedAt: baseline?.summary.updatedAt ?? null,
          });
        }),
      );
      for (const d of deals) {
        const s = summaries[d.id];
        if (s?.dealSize != null) d.arr = s.dealSize;
        // Stage live from Rolldog (matches the deal page), so a deal's stage
        // and its days-in-stage come from the same source and the seed
        // placeholder never shows.
        const sk = stageKeyFromSummary(s ?? null);
        if (sk) d.stageKey = sk;
        // Days in stage, live from Rolldog's stage-entry date (stage is
        // rep-owned; DealRipe never writes it, so this stays a clean signal
        // and it feeds the at-risk / stalled health logic below).
        const d2 = daysSince(s?.currentStageDate ?? null);
        if (d2 != null) d.daysInStage = d2;
      }
    } catch (e) {
      console.error("[magaya pipeline] rolldog summaries failed:", e);
    }

    // DealRipe's own last-activity: the most recent call it actually captured
    // per deal. This is real activity Rolldog often can't see (deals with no
    // opportunity, or a rep who never logged the meeting), so it's shown next
    // to the rep's CRM staleness rather than merged into it.
    const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled", "placeholder", "capture_failed"]);
    const lastCall: Record<string, string | null> = {};
    try {
      const nowIso = new Date().toISOString();
      const callRows = await supabaseAdmin()
        .from("calls")
        .select("deal_id, scheduled_start, call_date, outcome")
        .eq("tenant_id", tenantId)
        .lte("scheduled_start", nowIso);
      for (const c of callRows.data ?? []) {
        if (c.outcome && NO_CONTENT.has(c.outcome)) continue; // skip no-shows/placeholders
        const when = c.scheduled_start ?? c.call_date;
        if (!when) continue;
        const cur = lastCall[c.deal_id];
        if (!cur || new Date(when).getTime() > new Date(cur).getTime()) {
          lastCall[c.deal_id] = when;
        }
      }
    } catch (e) {
      console.error("[magaya pipeline] last-call read failed:", e);
    }

    return { deals, framework, digest, upcoming, summaries, repActivity, lastCall };
  } catch (err) {
    console.error("[magaya pipeline] load failed:", err);
    return null;
  }
}

type HealthStatus = "at_risk" | "stalled" | "healthy";

type Row = {
  deal: Deal;
  stage: Stage;
  assessment: DealRipeAssessment;
  yesCount: number;
  status: HealthStatus;
};

const LATE_STAGES = new Set(["proposal", "negotiation", "signing", "closed"]);
const AT_RISK_MISSING_THRESHOLD = 2;
const AT_RISK_DIVERGENCE_THRESHOLD = 20;
const AT_RISK_COMPLETION_THRESHOLD = 30;
const STALLED_DAYS_THRESHOLD = 21;
const STALLED_DIVERGENCE_THRESHOLD = 20;

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: { tenant?: string; rep?: string };
}) {
  // Magaya account: live, framework-driven pipeline. JWT tenant will replace
  // the ?tenant param once auth is wired; the TopSort demo path is unchanged.
  if (searchParams.tenant === "magaya") {
    const live = await loadMagayaPipeline();
    if (live)
      return (
        <AppShell active="deals">
          <MagayaPipeline
            deals={live.deals}
            framework={live.framework}
            digest={live.digest}
            upcomingByDealId={live.upcoming}
            summariesByDealId={live.summaries}
            repActivityByDealId={live.repActivity}
            lastCallByDealId={live.lastCall}
            repFilter={searchParams.rep ? searchParams.rep.toLowerCase() : null}
          />
        </AppShell>
      );
    // Do NOT fall back to the demo for the Magaya tenant; show the failure
    // so it is obvious something threw (see the dev server terminal).
    return (
      <div className="min-h-screen bg-bg">
        <main className="max-w-[1200px] mx-auto px-6 py-7">
          <div className="bg-white rounded-xl2 shadow-card border border-line p-8">
            <p className="text-[14px] text-ink font-medium">Magaya pipeline failed to load</p>
            <p className="text-[12px] text-muted mt-1">
              Check the dev server terminal for a line starting
              &ldquo;[magaya pipeline] load failed&rdquo;.
            </p>
          </div>
        </main>
      </div>
    );
  }

  const rows: Row[] = ALL_DEALS.map((deal) => {
    const stage = getStageForDeal(deal);
    if (!stage) throw new Error(`Stage not found for ${deal.id}`);
    const assessment = assessDeal(deal);
    const yesCount = SCOTSMAN_FIELDS.filter(
      (f) => deal.extraction[f.id]?.status === "Yes",
    ).length;
    const status = classifyDeal(deal, stage, assessment, yesCount);
    return { deal, stage, assessment, yesCount, status };
  });

  rows.sort((a, b) => {
    const statusOrder = { at_risk: 0, stalled: 1, healthy: 2 };
    const diff = statusOrder[a.status] - statusOrder[b.status];
    if (diff !== 0) return diff;
    return b.deal.arr - a.deal.arr;
  });

  const totalArr = rows.reduce((s, r) => s + r.deal.arr, 0);
  const repWeighted = rows.reduce(
    (s, r) => s + r.deal.arr * r.deal.repForecastProbability,
    0,
  );
  const drWeighted = rows.reduce(
    (s, r) => s + r.deal.arr * r.assessment.adjustedProbability,
    0,
  );
  const gap = repWeighted - drWeighted;

  const atRiskCount = rows.filter((r) => r.status === "at_risk").length;
  const stalledCount = rows.filter((r) => r.status === "stalled").length;

  return (
    <div className="min-h-screen bg-bg">
      <main className="max-w-[1200px] mx-auto px-6 py-7">
        <div className="flex items-baseline justify-between gap-4 mb-5">
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">
            Pipeline
          </h1>
          <div className="flex items-center gap-4">
            <Link
              href="/forecast"
              className="text-[12px] font-semibold text-ink bg-bg border border-line hover:border-ink/30 rounded-md px-2.5 py-1 transition"
            >
              Open Forecast Room →
            </Link>
            <Link
              href="/onboarding"
              className="text-[12px] font-semibold text-muted hover:text-ink transition"
            >
              Setup
            </Link>
            <div className="text-[12px] text-muted">
              {rows.length} deals · {atRiskCount} at risk · {stalledCount} stalled
            </div>
          </div>
        </div>

        <SummaryBar
          totalArr={totalArr}
          repWeighted={repWeighted}
          drWeighted={drWeighted}
          gap={gap}
        />

        <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-line">
                <Th className="pl-5">Account</Th>
                <Th>Status</Th>
                <Th>Stage</Th>
                <Th className="text-right">ARR</Th>
                <Th>Rep forecast</Th>
                <Th>DealRipe forecast</Th>
                <Th className="text-right pr-5">Qualification</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={row.deal.id}
                  className={
                    i < rows.length - 1 ? "border-b border-line" : undefined
                  }
                >
                  <td className="pl-5 py-3.5">
                    <AccountCell row={row} />
                  </td>
                  <td className="py-3.5">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="py-3.5">
                    <StageCell row={row} />
                  </td>
                  <td className="py-3.5 text-right pr-3 font-semibold text-ink text-[13px]">
                    {formatMoney(row.deal.arr)}
                  </td>
                  <td className="py-3.5 text-[12px] text-muted">
                    <div>
                      {formatPct(row.deal.repForecastProbability)} ·{" "}
                      {quarterOf(row.deal.repForecastCloseDate)} ·{" "}
                      {formatDate(row.deal.repForecastCloseDate)}
                    </div>
                  </td>
                  <td className="py-3.5 text-[12px]">
                    <ForecastCompareCell row={row} />
                  </td>
                  <td className="py-3.5 text-right pr-5">
                    <QualCell row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-muted mt-3 pl-1">
          Only Lumora Marketplace is wired to a live deal page in this
          build. The other rows reflect static pipeline context.
        </p>
      </main>
    </div>
  );
}

function SummaryBar({
  totalArr,
  repWeighted,
  drWeighted,
  gap,
}: {
  totalArr: number;
  repWeighted: number;
  drWeighted: number;
  gap: number;
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-4 gap-5 bg-white rounded-xl2 shadow-card border border-line p-6">
      <MetricBlock label="Pipeline total ARR" value={formatMoney(totalArr)} tone="neutral" />
      <MetricBlock
        label="Rep forecast (weighted)"
        value={formatMoney(repWeighted)}
        tone="muted"
      />
      <MetricBlock
        label="DealRipe forecast (weighted)"
        value={formatMoney(drWeighted)}
        tone="ink"
      />
      <MetricBlock
        label="Gap"
        value={formatMoney(gap)}
        tone="danger"
        sub="Rep forecast above DealRipe"
      />
    </div>
  );
}

function MetricBlock({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: "neutral" | "muted" | "ink" | "danger";
  sub?: string;
}) {
  const valueClass =
    tone === "danger"
      ? "text-danger"
      : tone === "ink"
        ? "text-ink"
        : tone === "muted"
          ? "text-muted"
          : "text-ink";
  const weight = tone === "ink" || tone === "danger" ? "font-bold" : "font-semibold";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-muted mb-1.5">
        {label}
      </div>
      <div className={`text-[24px] ${weight} tracking-tight ${valueClass} leading-none`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-muted mt-1">{sub}</div>}
    </div>
  );
}

function Th({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th
      className={`text-[10px] uppercase tracking-wider font-semibold text-muted py-2.5 ${className}`}
    >
      {children}
    </th>
  );
}

function AccountCell({ row }: { row: Row }) {
  const isClickable = row.deal.id === "lumora-2026-q2";
  return (
    <div>
      {isClickable ? (
        <Link
          href={`/deals/${row.deal.id}`}
          className="text-[14px] font-semibold text-ink hover:text-accent transition"
        >
          {row.deal.account}
        </Link>
      ) : (
        <span
          className="text-[14px] font-semibold text-ink cursor-default"
          title="Demo data. Not wired to a live deal page."
        >
          {row.deal.account}
        </span>
      )}
      <div className="text-[11px] text-muted mt-0.5">{row.deal.industry}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: HealthStatus }) {
  if (status === "at_risk") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-danger">
        <span className="w-1.5 h-1.5 rounded-full bg-danger" />
        At risk
      </span>
    );
  }
  if (status === "stalled") {
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-warn">
        <span className="w-1.5 h-1.5 rounded-full bg-warn" />
        Stalled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-accent">
      <span className="w-1.5 h-1.5 rounded-full bg-accent" />
      Healthy
    </span>
  );
}

function StageCell({ row }: { row: Row }) {
  const stuck = row.deal.daysInStage > 21;
  return (
    <div className="text-[12px]">
      <div className="text-ink font-medium">
        {row.stage.label} · {row.stage.pct}
      </div>
      <div
        className={`text-[11px] mt-0.5 ${stuck ? "text-danger font-semibold" : "text-muted"}`}
      >
        {row.deal.daysInStage} days in stage
      </div>
    </div>
  );
}

function ForecastCompareCell({ row }: { row: Row }) {
  const dr = row.assessment.adjustedProbability;
  const drDiff =
    row.deal.repForecastProbability - row.assessment.adjustedProbability;
  const diverges = Math.abs(drDiff * 100) > 15;
  return (
    <div>
      <div
        className={`font-semibold ${diverges ? "text-danger" : "text-ink"}`}
      >
        {formatPct(dr)} · {quarterOf(row.assessment.adjustedCloseDate)} ·{" "}
        {formatDate(row.assessment.adjustedCloseDate)}
      </div>
      {diverges && (
        <div className="text-[11px] text-danger mt-0.5">
          {drDiff > 0
            ? `${Math.round(drDiff * 100)}pt below rep`
            : `${Math.round(-drDiff * 100)}pt above rep`}
        </div>
      )}
    </div>
  );
}

function QualCell({ row }: { row: Row }) {
  const missing = row.assessment.unfilledFieldIds.length;
  const tone =
    missing === 0
      ? "text-accent"
      : missing > AT_RISK_MISSING_THRESHOLD
        ? "text-danger"
        : "text-warn";
  return (
    <div>
      <div className="text-[13px] font-semibold text-ink">
        {row.yesCount} of 18
      </div>
      <div className={`text-[11px] ${tone} mt-0.5`}>
        {missing === 0
          ? `${row.stage.label} gate met`
          : `${missing} missing for ${row.stage.label}`}
      </div>
    </div>
  );
}

function classifyDeal(
  deal: Deal,
  stage: Stage,
  assessment: DealRipeAssessment,
  yesCount: number,
): HealthStatus {
  const isLateStage = LATE_STAGES.has(stage.key);
  const divergencePts =
    Math.abs(deal.repForecastProbability - assessment.adjustedProbability) *
    100;
  const completionPct = (yesCount / SCOTSMAN_FIELDS.length) * 100;

  if (
    isLateStage &&
    assessment.unfilledFieldIds.length > AT_RISK_MISSING_THRESHOLD
  ) {
    return "at_risk";
  }
  if (
    divergencePts > AT_RISK_DIVERGENCE_THRESHOLD &&
    completionPct < AT_RISK_COMPLETION_THRESHOLD
  ) {
    return "at_risk";
  }
  if (
    deal.daysInStage > STALLED_DAYS_THRESHOLD &&
    divergencePts > STALLED_DIVERGENCE_THRESHOLD
  ) {
    return "stalled";
  }
  return "healthy";
}

function formatMoney(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
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
