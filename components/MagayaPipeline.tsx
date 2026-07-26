import Link from "next/link";
import { MagayaDigest } from "./MagayaDigest";
import type { DigestEntry } from "@/lib/digest";
import type { Framework } from "@/lib/framework";
import {
  frameworkProgress,
  frameworkStages,
  stageGateStatus,
} from "@/lib/framework-stages";
import type { Deal } from "@/lib/seed-data";
import { describeUpcomingCall, type UpcomingCall } from "@/lib/supabase-queries";
import { daysSince, type RolldogSummary } from "@/lib/rolldog-summary";
import { deriveDealState } from "@/lib/deal-state";
import { DEMO_DR_PROB } from "@/lib/forecast-room";
import { repDisplayName } from "@/lib/pilot-config";
import { DEFAULT_TENANT_SLUG, pipelineHref, tenantTitle, withTenant } from "@/lib/tenant-nav";

const STAGE_LABELS: Record<string, string> = {
  SQL0: "Lead",
  SQL1: "Develop Opportunity",
  SQL2: "Solution Finalization",
  SQL3: "Proposal Validation",
  SQL4: "Negotiations",
  SQL5: "Agreement Formalization",
};

type Health = "at_risk" | "stalled" | "healthy";

type Row = {
  deal: Deal;
  confirmed: number;
  total: number;
  currentOpen: number;
  callsCount: number;
  category: "Commit" | "Expect" | "Pipeline";
  mismatch: boolean;
  health: Health;
  /** DealRipe evidence-based risk flags (the "why"), most important first. */
  reasons: string[];
};

function stageRank(key: string): number {
  const m = key.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

// Magaya reps use forecast categories, not percentages. Until the live
// Rolldog read provides the category directly, derive it from the seeded
// number as a bridge.
function deriveCategory(p: number): "Commit" | "Expect" | "Pipeline" {
  if (p >= 0.7) return "Commit";
  if (p >= 0.4) return "Expect";
  return "Pipeline";
}

export function MagayaPipeline({
  deals,
  framework,
  digest = [],
  upcomingByDealId = {},
  summariesByDealId = {},
  repActivityByDealId = {},
  lastCallByDealId = {},
  repFilter = null,
  tenant = DEFAULT_TENANT_SLUG,
}: {
  deals: Deal[];
  framework: Framework | null;
  digest?: DigestEntry[];
  upcomingByDealId?: Record<string, UpcomingCall>;
  summariesByDealId?: Record<string, RolldogSummary>;
  repActivityByDealId?: Record<string, string | null>;
  lastCallByDealId?: Record<string, string | null>;
  /** Lowercased rep login email to filter by, or null for all reps. */
  repFilter?: string | null;
  /** Active tenant slug; drives ?tenant on internal links. Defaults to magaya. */
  tenant?: string;
}) {
  // Exclude non-opportunity meetings (existing customer / internal): they get a
  // recap but are not sales pipeline. A deal is dropped only when every
  // classified call is non-opportunity; unclassified calls keep it (safe).
  const salesDeals = deals.filter((deal) => {
    const classified = deal.calls.map((c) => c.meetingType).filter((t): t is string => !!t);
    return !(classified.length > 0 && classified.every((t) => t !== "new_opportunity"));
  });

  // Reps present in the pipeline, for the filter chips (Eduardo, Juan first).
  const repEmails = Array.from(
    new Set(salesDeals.map((d) => (d.repEmail ?? "").toLowerCase()).filter(Boolean)),
  ).sort((a, b) => (repDisplayName(a) ?? "").localeCompare(repDisplayName(b) ?? ""));

  const visibleDeals = repFilter
    ? salesDeals.filter((d) => (d.repEmail ?? "").toLowerCase() === repFilter)
    : salesDeals;
  const rows: Row[] = framework ? visibleDeals.map((deal) => buildRow(deal, framework)) : [];

  rows.sort((a, b) => {
    const order = { at_risk: 0, stalled: 1, healthy: 2 };
    const d = order[a.health] - order[b.health];
    return d !== 0 ? d : b.deal.arr - a.deal.arr;
  });

  // Pilot scorecard (the success metrics, live-computable).
  const fieldsLogged = rows.reduce((s, r) => s + r.confirmed, 0);
  const openGaps = rows.reduce((s, r) => s + (r.total - r.confirmed), 0);
  const mismatches = rows.filter((r) => r.mismatch).length;
  const callsCaptured = rows.reduce((s, r) => s + r.callsCount, 0);
  const atRisk = rows.filter((r) => r.health === "at_risk").length;
  const stalled = rows.filter((r) => r.health === "stalled").length;

  // Demo tenants (keelson) lead with the forecast rollup and a link into the
  // Forecast Room, matching the clean pipeline view. drProb mirrors the Forecast
  // Room (rep probability tempered by qualification, with the same demo override),
  // so the numbers agree across Deals and Review.
  const isDemo = tenant !== DEFAULT_TENANT_SLUG;
  const pipelineTotalArr = rows.reduce((s, r) => s + r.deal.arr, 0);
  const repWeighted = rows.reduce((s, r) => s + r.deal.arr * (r.deal.repForecastProbability ?? 0), 0);
  const drWeighted = rows.reduce((s, r) => {
    const completion = r.total > 0 ? r.confirmed / r.total : 0;
    // Round exactly as the Forecast Room does, so the totals match to the dollar.
    const drProb = DEMO_DR_PROB[r.deal.account] ?? Math.round((r.deal.repForecastProbability ?? 0) * completion * 100) / 100;
    return s + r.deal.arr * drProb;
  }, 0);
  const overcommit = repWeighted - drWeighted;

  // Only surface digest entries for deals DealRipe has actually captured
  // evidence on (at least one confirmed gate). Before the first calls land,
  // every deal would otherwise show identical "nothing known" flags, which
  // reads as noise rather than insight.
  const signalDigest = digest.filter((e) => e.forecast.confirmed > 0);
  const topSignal = signalDigest[0];

  return (
    <div className="min-h-screen bg-bg">
      <main className="max-w-[1200px] mx-auto px-6 py-7">
        <div className="flex items-baseline justify-between gap-4 mb-5">
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">{isDemo ? "Pipeline" : tenantTitle(tenant)}</h1>
          <div className="text-right">
            <div className="flex items-center justify-end gap-3">
              {isDemo && (
                <Link
                  href={withTenant("/review", tenant)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[12.5px] font-semibold bg-ink text-white hover:bg-ink/90 transition"
                >
                  Open Forecast Room <span aria-hidden>→</span>
                </Link>
              )}
              <span className="text-[12px] text-muted">
                {rows.length} deal{rows.length === 1 ? "" : "s"} · {atRisk} at risk · {stalled} stalled
              </span>
            </div>
            <div className="mt-1 flex items-center justify-end gap-3">
              <Link
                href="/audit"
                className="text-[12px] font-medium text-accent hover:underline"
              >
                Audit →
              </Link>
              <Link
                href="/impact"
                className="text-[12px] font-medium text-accent hover:underline"
              >
                Impact →
              </Link>
              <Link
                href="/digests"
                className="text-[12px] font-medium text-accent hover:underline"
              >
                Sent digests →
              </Link>
            </div>
          </div>
        </div>

        {repEmails.length > 0 && (
          <div className="flex items-center gap-2 mb-4">
            <span className="text-[11px] uppercase tracking-wider font-semibold text-muted mr-1">
              Rep
            </span>
            <RepChip label="All" href={pipelineHref(tenant)} active={!repFilter} />
            {repEmails.map((email) => (
              <RepChip
                key={email}
                label={repDisplayName(email) ?? email}
                href={`${pipelineHref(tenant)}&rep=${encodeURIComponent(email)}`}
                active={repFilter === email}
              />
            ))}
          </div>
        )}

        {isDemo ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-5 bg-white rounded-xl2 shadow-card border border-line p-6">
              <Metric label="Pipeline total ARR" value={money(pipelineTotalArr)} cls="text-ink font-bold" />
              <Metric label="Rep forecast (weighted)" value={money(repWeighted)} cls="text-muted font-bold" />
              <Metric label="DealRipe forecast (weighted)" value={money(drWeighted)} cls="text-ink font-bold" />
              <Metric label="Overcommit" value={money(overcommit)} cls="text-danger font-bold" sub="rep forecast above DealRipe" />
            </div>
            <p className="text-[11px] text-muted mt-2 pl-1">
              DealRipe weights each deal by how much of the framework the calls actually confirm. Open the Forecast Room for the reason behind each move.
            </p>
          </>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-5 bg-white rounded-xl2 shadow-card border border-line p-6">
              <Metric label="Fields auto-logged" value={String(fieldsLogged)} cls="text-ink font-bold" sub="reps didn't enter these" />
              <Metric label="Open gaps flagged" value={String(openGaps)} cls="text-ink font-bold" sub="blindspots surfaced" />
              <Metric label="Commit-reality mismatches" value={String(mismatches)} cls={mismatches > 0 ? "text-danger font-bold" : "text-ink font-bold"} sub="rep ahead of evidence" />
              <Metric label="Calls captured" value={String(callsCaptured)} cls="text-ink font-bold" sub="from Teams" />
            </div>
            <p className="text-[11px] text-muted mt-2 pl-1">
              Field-match accuracy and hours-saved are graded in the operator view.
            </p>
          </>
        )}

        {rows.length === 0 ? (
          <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line p-8 text-center">
            <p className="text-[14px] text-ink font-medium">No pilot deals yet</p>
            <p className="text-[12px] text-muted mt-1">
              Once Mark names the three deals and they are seeded, they appear here.
            </p>
          </div>
        ) : isDemo ? (
          <DemoDealTable rows={rows} tenant={tenant} />
        ) : (
          <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-line">
                  <Th className="pl-5">Account</Th>
                  <Th>Rep</Th>
                  <Th>Status</Th>
                  <Th>Stage</Th>
                  <Th>Rep last activity</Th>
                  <Th>Deal size</Th>
                  <Th>Rep category</Th>
                  <Th>Rolldog score</Th>
                  <Th>Next call</Th>
                  <Th className="pr-5">DealRipe read</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.deal.id} className={i < rows.length - 1 ? "border-b border-line" : undefined}>
                    <td className="pl-5 py-3.5">
                      <Link href={withTenant(`/deals/${row.deal.id}`, tenant)} className="text-[14px] font-semibold text-ink hover:text-accent transition">
                        {row.deal.account}
                      </Link>
                      <div className="text-[11px] text-muted mt-0.5">
                        {row.deal.industry}
                      </div>
                    </td>
                    <td className="py-3.5 text-[12px]">
                      {repDisplayName(row.deal.repEmail) ? (
                        <span className="text-ink font-medium">
                          {repDisplayName(row.deal.repEmail)}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="py-3.5"><StatusBadge health={row.health} /></td>
                    <td className="py-3.5 text-[12px]">
                      <div className="text-ink font-medium">{STAGE_LABELS[row.deal.stageKey] ?? row.deal.stageKey}</div>
                      <div className={`text-[11px] mt-0.5 ${row.deal.daysInStage > 21 ? "text-danger font-semibold" : "text-muted"}`}>
                        {row.deal.daysInStage} days in stage
                      </div>
                      {(() => {
                        const age = daysSince(summariesByDealId[row.deal.id]?.createdAt ?? null);
                        return age == null ? null : (
                          <div className="text-[11px] text-muted mt-0.5">{age}d old</div>
                        );
                      })()}
                    </td>
                    <td className="py-3.5 text-[12px]">
                      {(() => {
                        const repD = daysSince(repActivityByDealId[row.deal.id] ?? null);
                        const callD = daysSince(lastCallByDealId[row.deal.id] ?? null);
                        return (
                          <div>
                            {repD == null ? (
                              <span className="text-muted">—</span>
                            ) : (
                              <span className={repD > 30 ? "text-danger font-semibold" : "text-ink"}>
                                {repD}d ago
                              </span>
                            )}
                            {callD != null && (
                              <div className="text-[11px] text-accent mt-0.5">
                                DealRipe call {callD === 0 ? "today" : `${callD}d ago`}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="py-3.5 text-[12px]">
                      {(() => {
                        const v = summariesByDealId[row.deal.id]?.dealSize ?? row.deal.arr;
                        return v ? (
                          <span className="text-ink font-medium">${v.toLocaleString()}</span>
                        ) : (
                          <span className="text-muted">—</span>
                        );
                      })()}
                    </td>
                    <td className="py-3.5">
                      <span className="text-[12px] font-semibold text-ink">{row.category}</span>
                    </td>
                    <td className="py-3.5 text-[12px]">
                      {(() => {
                        const s = summariesByDealId[row.deal.id];
                        if (!s || s.score == null) return <span className="text-muted">—</span>;
                        return (
                          <>
                            <span className="font-semibold text-ink">{s.score}</span>
                            {s.qRank ? <span className="text-muted"> · rank {s.qRank}</span> : null}
                          </>
                        );
                      })()}
                    </td>
                    <td className="py-3.5 text-[12px]">
                      {(() => {
                        const u = upcomingByDealId[row.deal.id];
                        if (!u) return <span className="text-[12px] text-muted">none scheduled</span>;
                        const d = describeUpcomingCall(u);
                        return (
                          <>
                            <div className="text-ink font-medium">{d.when}</div>
                            <div className={`text-[11px] mt-0.5 ${u.briefingSentAt ? "text-accent font-medium" : "text-muted"}`}>
                              {u.briefingSentAt ? "✓ " : ""}
                              {d.briefing}
                            </div>
                          </>
                        );
                      })()}
                    </td>
                    <td className="py-3.5 pr-5">
                      <div className="text-[13px] font-semibold text-ink">
                        {row.confirmed} of {row.total} gates
                      </div>
                      {row.mismatch ? (
                        <div className="text-[11px] text-danger mt-0.5 font-semibold">
                          Rep says {row.category}, evidence doesn&rsquo;t back it
                        </div>
                      ) : (
                        <div className={`text-[11px] mt-0.5 ${row.currentOpen === 0 ? "text-accent" : "text-muted"}`}>
                          {row.currentOpen === 0
                            ? `${row.deal.stageKey} gate met`
                            : `${row.currentOpen} open for ${row.deal.stageKey}`}
                        </div>
                      )}
                      {row.reasons
                        .filter((r) => r !== "Rep committed above the evidence")
                        .map((r) => (
                          <div key={r} className="text-[11px] text-danger mt-0.5">
                            {r}
                          </div>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* "What needs your attention" demoted to a collapsed panel, and gated
            to deals with real captured signal so it stays quiet until calls land. */}
        <details className="mt-5">
          <summary className="cursor-pointer select-none list-none flex items-baseline justify-between gap-4 bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
            <span className="text-[15px] font-semibold text-ink">What needs your attention</span>
            <span className="text-[12px] text-muted">
              {signalDigest.length > 0
                ? `${signalDigest.length} deal${signalDigest.length === 1 ? "" : "s"} flagged${topSignal ? ` · start with ${topSignal.account}` : ""} ›`
                : "Nothing captured yet ›"}
            </span>
          </summary>
          <div className="mt-3">
            {signalDigest.length > 0 ? (
              <MagayaDigest entries={signalDigest} hideHeader />
            ) : (
              <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[12px] text-muted">
                Insights appear here after DealRipe captures its first calls, from Thursday&rsquo;s
                meetings onward. Nothing to flag yet.
              </div>
            )}
          </div>
        </details>
      </main>
    </div>
  );
}

function buildRow(deal: Deal, framework: Framework): Row {
  const { confirmed, total } = frameworkProgress(framework, deal.extraction);
  const completion = total > 0 ? confirmed / total : 0;
  const category = deriveCategory(deal.repForecastProbability);

  const stages = frameworkStages(framework);
  const current = stages.find((s) => s.key === deal.stageKey);
  const currentGate = current ? stageGateStatus(current, deal.extraction) : null;
  const currentOpen = currentGate ? currentGate.total - currentGate.met : 0;

  // The rep is confident (Commit/Expect) but the calls don't back it.
  const mismatch = category !== "Pipeline" && completion < 0.6;

  // DealRipe evidence-based risk flags, from what the calls actually captured.
  const ds = deriveDealState(framework, deal.extraction, deal.stageKey);
  const reachedRank = ds.reachedStageKey ? stageRank(ds.reachedStageKey) : -1;
  const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled", "placeholder", "capture_failed"]);

  const unengagedEB = deal.contacts.some(
    (c) => c.relationship === "economic_buyer" && !c.lastContactedAt,
  );
  // Only a risk once the deal is advanced (proposal+); an un-engaged buyer on a
  // fresh lead is normal.
  const unengagedEBRisk = unengagedEB && reachedRank >= 3;
  const aheadWithGaps =
    ds.reachedStageKey !== null &&
    reachedRank > stageRank(deal.stageKey) &&
    ds.topGaps.length > 0;
  // A no-show can only be a call that already happened; a future scheduled
  // call is "upcoming", never a no-show.
  const hadNoShow = deal.calls.some((c) => {
    if (!c.outcome || !NO_CONTENT.has(c.outcome)) return false;
    const t = Date.parse(c.date);
    return Number.isFinite(t) && t <= Date.now();
  });

  const reasons: string[] = [];
  if (unengagedEBRisk) reasons.push("Economic buyer never engaged");
  if (mismatch) reasons.push("Rep committed above the evidence");
  if (aheadWithGaps) reasons.push(`Advanced on calls, ${ds.topGaps.length} gaps beneath`);
  if (hadNoShow) reasons.push("A recent call was a no-show");

  const lateStage = stageRank(deal.stageKey) >= 4;
  let health: Health = "healthy";
  if (mismatch || (lateStage && currentOpen > 0) || unengagedEBRisk) health = "at_risk";
  else if (deal.daysInStage > 21) health = "stalled";

  return {
    deal,
    confirmed,
    total,
    currentOpen,
    callsCount: deal.calls.length,
    category,
    mismatch,
    health,
    reasons,
  };
}

function StatusBadge({ health }: { health: Health }) {
  const map = {
    at_risk: { c: "text-danger", d: "bg-danger", t: "At risk" },
    stalled: { c: "text-warn", d: "bg-warn", t: "Stalled" },
    healthy: { c: "text-accent", d: "bg-accent", t: "Healthy" },
  }[health];
  return (
    <span className={`inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider ${map.c}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${map.d}`} />
      {map.t}
    </span>
  );
}

function RepChip({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`text-[12px] font-medium rounded-full px-3 py-1 border transition ${
        active
          ? "bg-ink text-white border-ink"
          : "bg-white text-muted border-line hover:border-ink/30 hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );
}

function Metric({ label, value, cls, sub }: { label: string; value: string; cls: string; sub?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-muted mb-1.5">{label}</div>
      <div className={`text-[24px] tracking-tight leading-none ${cls}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted mt-1">{sub}</div>}
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <th className={`text-[10px] uppercase tracking-wider font-semibold text-muted py-2.5 ${className}`}>{children}</th>;
}

function money(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${Math.round(v)}`;
}

// Nominal close rate per stage, for the "Stage · X%" cell (matches the old view).
const STAGE_PCT: Record<string, number> = { SQL0: 10, SQL1: 20, SQL2: 40, SQL3: 60, SQL4: 80, SQL5: 90 };

function quarterLabel(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
function shortDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// The demo (keelson) deals table: exact columns of the old pipeline view —
// Account, Status, Stage, ARR, Rep forecast, DealRipe forecast, Qualification.
function DemoDealTable({ rows, tenant }: { rows: Row[]; tenant: string }) {
  return (
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
            <Th className="pr-5 text-right">Qualification</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const repProb = row.deal.repForecastProbability ?? 0;
            const completion = row.total > 0 ? row.confirmed / row.total : 0;
            const drProb = DEMO_DR_PROB[row.deal.account] ?? Math.round(repProb * completion * 100) / 100;
            const repPct = Math.round(repProb * 100);
            const drPct = Math.round(drProb * 100);
            const delta = drPct - repPct;
            const repClose = row.deal.repForecastCloseDate || null;
            // DealRipe pushes the close out a quarter when it reads materially softer.
            const drClose = repClose && drProb < repProb - 0.1 ? addDaysIso(repClose, 75) : repClose;
            const stageLabel = STAGE_LABELS[row.deal.stageKey] ?? row.deal.stageKey;
            return (
              <tr key={row.deal.id} className={i < rows.length - 1 ? "border-b border-line" : undefined}>
                <td className="pl-5 py-3.5">
                  <Link href={withTenant(`/deals/${row.deal.id}`, tenant)} className="text-[14px] font-semibold text-ink hover:text-accent transition">
                    {row.deal.account}
                  </Link>
                  <div className="text-[11px] text-muted mt-0.5">{row.deal.industry}</div>
                </td>
                <td className="py-3.5"><StatusBadge health={row.health} /></td>
                <td className="py-3.5 text-[12px]">
                  <div className="text-ink font-medium">{stageLabel} · {STAGE_PCT[row.deal.stageKey] ?? 0}%</div>
                  <div className={`text-[11px] mt-0.5 ${row.deal.daysInStage > 21 ? "text-danger font-semibold" : "text-muted"}`}>
                    {row.deal.daysInStage} days in stage
                  </div>
                </td>
                <td className="py-3.5 text-right text-[13px] font-semibold text-ink whitespace-nowrap">{money(row.deal.arr)}</td>
                <td className="py-3.5 text-[12px] text-muted whitespace-nowrap">
                  {repPct}% · {quarterLabel(repClose)} · {shortDate(repClose)}
                </td>
                <td className="py-3.5 text-[12px]">
                  <div className={`font-semibold whitespace-nowrap ${delta < 0 ? "text-danger" : "text-ink"}`}>
                    {drPct}% · {quarterLabel(drClose)} · {shortDate(drClose)}
                  </div>
                  {delta !== 0 && (
                    <div className={`text-[11px] mt-0.5 ${delta < 0 ? "text-danger" : "text-accent"}`}>
                      {delta < 0 ? `${Math.abs(delta)}pt below rep` : `${delta}pt above rep`}
                    </div>
                  )}
                </td>
                <td className="py-3.5 pr-5 text-right">
                  <div className="text-[13px] font-semibold text-ink">{row.confirmed} of {row.total}</div>
                  {row.currentOpen === 0 ? (
                    <div className="text-[11px] mt-0.5 text-accent">{row.deal.stageKey} gate met</div>
                  ) : (
                    <div className={`text-[11px] mt-0.5 ${row.currentOpen === 1 ? "text-warn" : "text-danger"}`}>
                      {row.currentOpen} missing for {stageLabel}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
