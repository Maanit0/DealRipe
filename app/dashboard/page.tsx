import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { getWatcherDataset } from "@/lib/watcher/datasets";
import type { DealForecast, WaterfallWeek } from "@/lib/watcher/types";
import { DEFAULT_TENANT_SLUG, withTenant } from "@/lib/tenant-nav";

export const dynamic = "force-dynamic";

type SP = { tenant?: string; week?: string; rep?: string };

function moneyK(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (a >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${Math.round(v)}`;
}
function signedK(v: number): string {
  return `${v >= 0 ? "+" : "−"}${moneyK(Math.abs(v))}`;
}
function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  } catch {
    return iso;
  }
}

const MOVE_LABEL: Record<string, { label: string; cls: string }> = {
  added: { label: "New", cls: "bg-accent/10 text-accent" },
  moved_up: { label: "Moved up", cls: "bg-accent/10 text-accent" },
  moved_down: { label: "Moved down", cls: "bg-danger/10 text-danger" },
  slipped_out: { label: "Slipped out", cls: "bg-danger/10 text-danger" },
  closed_won: { label: "Closed won", cls: "bg-accent/10 text-accent" },
  closed_lost: { label: "Closed lost", cls: "bg-ink/10 text-muted" },
};

const BUCKET: Record<DealForecast["bucket"], { label: string; cls: string }> = {
  needs_you: { label: "Needs you", cls: "bg-danger/10 text-danger" },
  being_handled: { label: "Being handled", cls: "bg-warn/10 text-warn" },
  watched: { label: "Watched", cls: "bg-accent/10 text-accent" },
};

export default function DashboardPage({ searchParams }: { searchParams: SP }) {
  const tenant = searchParams.tenant ?? DEFAULT_TENANT_SLUG;
  const ds = getWatcherDataset(tenant);
  return (
    <AppShell active="dashboard" tenant={tenant}>
      {ds ? (
        <Dashboard tenant={tenant} weekParam={searchParams.week ?? null} repParam={searchParams.rep ?? null} />
      ) : (
        <div className="max-w-[1180px] mx-auto px-6 py-7 text-[14px] text-muted">
          No watcher dataset for this tenant. The classic Forecast Room lives at{" "}
          <Link href={withTenant("/review", tenant)} className="text-accent hover:underline">/review</Link>.
        </div>
      )}
    </AppShell>
  );
}

function Dashboard({ tenant, weekParam, repParam }: { tenant: string; weekParam: string | null; repParam: string | null }) {
  const ds = getWatcherDataset(tenant)!;
  const week: WaterfallWeek = ds.waterfall.find((w) => w.weekOf === weekParam) ?? ds.waterfall[0];
  const isCurrentWeek = week.weekOf === ds.waterfall[0].weekOf;

  // Rep filter: scopes the headline, the table, and the movement list.
  const repNames = Array.from(new Set(ds.forecasts.map((f) => f.rep))).sort();
  const repFilter = repParam && repNames.includes(repParam) ? repParam : null;
  const scoped = repFilter ? ds.forecasts.filter((f) => f.rep === repFilter) : ds.forecasts;
  const weekMovements = repFilter ? week.movements.filter((m) => m.rep === repFilter) : week.movements;

  const pipeline = scoped.reduce((s, f) => s + f.amountUsd, 0);
  const repCommit = scoped.reduce((s, f) => s + (f.amountUsd * f.repProbPct) / 100, 0);
  const drW = scoped.reduce((s, f) => s + (f.amountUsd * f.drProbPct) / 100, 0);
  const recoverable = scoped.reduce((s, f) => s + f.recoverableUsd, 0);
  // Doors only render for tenants that sell on units (property management).
  const hasDoors = scoped.some((f) => typeof f.doors === "number" && f.doors > 0);
  const totalDoors = scoped.reduce((s, f) => s + (f.doors ?? 0), 0);

  // Deal table: ranked by recoverable dollars; healthy/zero-recoverable sink.
  const ranked = [...scoped].sort((a, b) => b.recoverableUsd - a.recoverableUsd || b.amountUsd - a.amountUsd);
  const top = ranked.slice(0, 14);
  const restCount = ranked.length - top.length;
  const atRiskCount = scoped.filter((f) => f.recoverableUsd > 0).length;
  // Status chips deep-link to the deal's alert on Today.
  const alertByDeal = new Map<string, string>();
  for (const a of ds.alerts) if (!alertByDeal.has(a.dealId)) alertByDeal.set(a.dealId, a.id);
  const weekQS = weekParam ? `week=${weekParam}&` : "";

  return (
    <div className="max-w-[1180px] mx-auto px-6 py-7 space-y-6" style={{ zoom: 1.15 }}>
      <div>
        <div className="text-[11px] uppercase tracking-wider font-semibold text-muted">{ds.companyName} · {ds.frameworkName}</div>
        <h1 className="text-[22px] font-semibold text-ink mt-1">Forecast</h1>
        <p className="text-[14px] text-muted mt-1 max-w-[760px]">
          Every number rolls up from the watchers: click any probability for the ledger behind it. Ranked by what is
          winnable but at risk, not just what is risky.
        </p>
      </div>

      {/* Rep filter */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[12px] uppercase tracking-wider font-semibold text-muted mr-1">Rep</span>
        <Link
          href={withTenant(`/dashboard?${weekQS.replace(/&$/, "")}`, tenant)}
          className={`px-3 py-1.5 rounded-full text-[13px] font-semibold transition ${!repFilter ? "bg-ink text-white" : "bg-white border border-line text-muted hover:text-ink"}`}
        >
          All
        </Link>
        {repNames.map((r) => (
          <Link
            key={r}
            href={withTenant(`/dashboard?${weekQS}rep=${encodeURIComponent(r)}`, tenant)}
            className={`px-3 py-1.5 rounded-full text-[13px] font-semibold transition ${repFilter === r ? "bg-ink text-white" : "bg-white border border-line text-muted hover:text-ink"}`}
          >
            {r.split(" ")[0]}
          </Link>
        ))}
      </div>

      {/* Headline */}
      <div className="bg-white rounded-xl2 shadow-card border border-line px-6 py-5">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
          {/* Doors ride along in the pipeline tile rather than taking a fifth
              column: Alisha's sheet totals both, but dollars stay the headline. */}
          <Metric
            label={repFilter ? `${repFilter.split(" ")[0]}'s pipeline` : "Open pipeline"}
            value={moneyK(pipeline)}
            sub={hasDoors ? `${scoped.length} opportunities · ${totalDoors.toLocaleString()} doors` : `${scoped.length} opportunities`}
          />
          <Metric label="Rep commit (weighted)" value={moneyK(Math.round(repCommit))} sub={repFilter ? `What ${repFilter.split(" ")[0]} is committing` : "What the team is committing"} />
          <Metric label="DealRipe forecast" value={moneyK(Math.round(drW))} sub="Grounded in the calls" accent />
          <Metric label="Upside if fixed (weighted)" value={`+${moneyK(recoverable)}`} sub={`across ${atRiskCount} deals · drafts ready`} danger />
        </div>
        <div className="mt-4 pt-4 border-t border-line text-[13.5px] text-muted space-y-1">
          <div>
            <span className="font-semibold text-ink">Rep %</span> is the probability the rep filed (the Prob % from your
            sheet). <span className="font-semibold text-ink">DealRipe %</span> is what the calls, emails, and calendar
            actually support, click any number for the ledger behind it.
          </div>
          <div>
            <span className="font-semibold text-ink">Upside if fixed</span> is the same weighted math as your Adj
            Weighted column, applied to risk: resolve a deal&apos;s open flags and its probability moves back up, adding
            that much weighted forecast. Take the largest one on this book: closing its open flags is worth{" "}
            {moneyK(Math.max(...scoped.map((f) => f.recoverableUsd), 0))} weighted on that deal alone. Not
            cash in hand on one deal, but across {atRiskCount} deals it&apos;s +{moneyK(recoverable)}, roughly{" "}
            {Math.max(1, Math.round(recoverable / 110_000))} extra closed deals a quarter at your sizes. Interventions
            queued in <Link href={withTenant("/today", tenant)} className="text-accent hover:underline">Today</Link>.
          </div>
        </div>
      </div>

      {/* Waterfall */}
      <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
        <div className="px-6 py-4 border-b border-line flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-[15px] font-semibold text-ink">What changed · {week.label}</h2>
            <p className="text-[13px] text-muted mt-0.5">Add, move, slip, close, with the reason on every movement. It was this; now it&apos;s this; here&apos;s why.</p>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <Sparkline weeks={ds.waterfall} selected={week.weekOf} />
            <div className="flex items-center gap-1 flex-wrap">
              {ds.waterfall.slice(0, 6).map((w) => (
                <Link
                  key={w.weekOf}
                  href={withTenant(`/dashboard?week=${w.weekOf}`, tenant)}
                  className={`px-2.5 py-1 rounded-md text-[12.5px] font-semibold transition ${w.weekOf === week.weekOf ? "bg-ink text-white" : "bg-bg text-muted hover:text-ink"}`}
                >
                  {w.label.replace("Week of ", "")}
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* Bridge: full segments when the week has movements; start → end otherwise. */}
        <div className="px-6 py-4 border-b border-line flex items-center gap-2 flex-wrap">
          <Bridge label={week.label.replace("Week of", "Start")} value={moneyK(week.startWeightedUsd)} tone="ink" />
          {!repFilter && weekMovements.length > 0 && (
            <>
              <Arrow />
              <Bridge label="Adds & moves up" value={signedK(weekMovements.filter((m) => m.deltaWeightedUsd > 0 && m.kind !== "closed_won").reduce((s, m) => s + m.deltaWeightedUsd, 0))} tone="accent" />
              <Arrow />
              <Bridge label="Down & slipped" value={signedK(weekMovements.filter((m) => m.deltaWeightedUsd < 0 && m.kind !== "closed_won" && m.kind !== "closed_lost").reduce((s, m) => s + m.deltaWeightedUsd, 0))} tone="danger" />
              <Arrow />
              <Bridge label="Closed, out of pipeline" value={signedK(weekMovements.filter((m) => m.kind === "closed_won" || m.kind === "closed_lost").reduce((s, m) => s + m.deltaWeightedUsd, 0))} tone="ink" />
            </>
          )}
          <Arrow />
          <Bridge label="End of week" value={moneyK(week.endWeightedUsd)} tone="ink" bold />
          {(() => {
            const won = weekMovements.filter((m) => m.kind === "closed_won");
            const bookedUsd = won.reduce((s, m) => s + m.amountUsd, 0);
            const weightedOut = Math.abs(won.reduce((s, m) => s + m.deltaWeightedUsd, 0));
            return bookedUsd > 0 ? (
              <span className="ml-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-accent/10 text-accent text-[14px] font-bold">
                🎉 Booked: {moneyK(bookedUsd)} contract
                <span className="font-medium text-[12px] opacity-80">· {moneyK(weightedOut)} weighted left open pipeline</span>
              </span>
            ) : null;
          })()}
          {weekMovements.length === 0 && (
            <span className="text-[13px] text-muted ml-2">
              Net {signedK(week.endWeightedUsd - week.startWeightedUsd)} · movement detail retained for recent weeks
            </span>
          )}
        </div>
        <div className="px-6 py-2 border-b border-line bg-bg/50 text-[12.5px] text-muted">
          All figures are changes to the weighted open-pipeline forecast (deal size × DealRipe probability). A closed-won
          deal leaves open pipeline and lands in booked revenue, so wins show here as an outflow, and in green above as
          booked.
        </div>

        {weekMovements.length > 0 ? (
          <div className="divide-y divide-line">
            {weekMovements.map((m, i) => {
              const mv = MOVE_LABEL[m.kind];
              return (
                <div key={i} className="px-6 py-3.5 flex items-start gap-3">
                  <span className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded mt-0.5 shrink-0 ${mv.cls}`}>{mv.label}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-[14px] font-semibold text-ink">{m.account}</span>
                      <span className="text-[12.5px] text-muted">{moneyK(m.amountUsd)} · {m.rep}</span>
                      <span className={`text-[13px] font-bold ml-auto ${m.deltaWeightedUsd >= 0 ? "text-accent" : "text-danger"}`}>{signedK(m.deltaWeightedUsd)}</span>
                    </div>
                    <p className="text-[13.5px] text-ink/80 leading-snug mt-1">{m.reason}</p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="px-6 py-4 text-[13.5px] text-muted">
            Summary week: {moneyK(week.startWeightedUsd)} → {moneyK(week.endWeightedUsd)} ({signedK(week.endWeightedUsd - week.startWeightedUsd)}). Open the current week for movement-level reasons.
          </div>
        )}
      </div>

      {/* The book, ranked by recoverable dollars */}
      <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
        <div className="px-6 py-4 border-b border-line">
          <h2 className="text-[15px] font-semibold text-ink">The book today, ranked by upside if fixed</h2>
          <p className="text-[13px] text-muted mt-0.5">
            Always today&apos;s state{!isCurrentWeek ? " (you're viewing a prior week's change-log above; history lives there, not here)" : " (the week tabs above change the change-log, not this table)"}. Winnable-but-at-risk first; click a
            probability for the ledger, click a status for the action.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[1040px]">
            <thead className="bg-bg border-b border-line">
              <tr>
                <Th>Account</Th>
                <Th>Rep</Th>
                <Th>Stage</Th>
                <Th right>Amount</Th>
                {/* Property management forecasts on doors as well as dollars.
                    Rendered only when the tenant's deals carry it. */}
                {hasDoors ? <Th right>Doors</Th> : null}
                <Th right>Rep</Th>
                <Th right>DealRipe</Th>
                <Th right>Upside if fixed</Th>
                <Th>Close (rep → DR)</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {top.map((f) => (
                <Row key={f.dealId} f={f} tenant={tenant} alertId={alertByDeal.get(f.dealId) ?? null} stageLabels={ds.stageLabels} showDoors={hasDoors} />
              ))}
            </tbody>
          </table>
        </div>
        <div className="px-6 py-2.5 border-t border-line bg-bg text-[12.5px] text-muted">
          + {restCount} more opportunities, watched. Nothing due on them; they surface here the moment that changes.
        </div>
      </div>

      {/* Rep calibration strip */}
      <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
        <div className="px-6 py-4 border-b border-line">
          <h2 className="text-[15px] font-semibold text-ink">Whose number to trust</h2>
          <p className="text-[13px] text-muted mt-0.5">The roll-up is adjusted for how each rep historically forecasts. Full coaching view in 1-on-1s.</p>
        </div>
        <div className="grid md:grid-cols-3 lg:grid-cols-5 divide-x divide-line">
          {ds.reps.filter((r) => r.archetype !== "departed").map((r) => {
            const over = r.landsPerHundred < 95;
            const under = r.landsPerHundred > 100;
            return (
              <div key={r.name} className="px-4 py-3.5">
                <div className="text-[14px] font-semibold text-ink">{r.name}</div>
                <div className={`text-[11px] font-bold uppercase tracking-wider mt-0.5 ${over ? "text-danger" : under ? "text-accent" : "text-accent"}`}>
                  ${r.landsPerHundred} / $100 lands
                </div>
                <div className="text-[12.5px] text-muted mt-1 leading-snug">{r.calibrationNote}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Row({ f, tenant, alertId, stageLabels, showDoors }: { f: DealForecast; tenant: string; alertId: string | null; stageLabels: Record<string, string>; showDoors?: boolean }) {
  const b = BUCKET[f.bucket];
  const softer = f.drProbPct < f.repProbPct;
  return (
    <tr className="align-top hover:bg-bg/40">
      <td className="px-4 py-3 text-[13.5px] font-semibold text-ink whitespace-nowrap">{f.account}</td>
      <td className="px-4 py-3 text-[13px] text-muted whitespace-nowrap">{f.rep}</td>
      <td className="px-4 py-3 text-[13px] text-ink whitespace-nowrap">{stageLabels[f.stageKey] ?? f.stageKey}</td>
      <td className="px-4 py-3 text-[13.5px] text-ink text-right font-medium">{moneyK(f.amountUsd)}</td>
      {showDoors ? (
        <td className="px-4 py-3 text-[13.5px] text-ink text-right font-medium">
          {typeof f.doors === "number" ? f.doors.toLocaleString() : "—"}
        </td>
      ) : null}
      <td className="px-4 py-3 text-[13px] text-muted text-right">{f.repProbPct}%</td>
      <td className="px-4 py-3 text-right">
        <details className="inline-block text-left">
          <summary className={`cursor-pointer list-none text-[13.5px] font-bold ${softer ? "text-danger" : "text-accent"} underline decoration-dotted underline-offset-2`}>
            {f.drProbPct}%
          </summary>
          <div className="mt-2 mb-1 rounded-lg border border-line bg-bg/70 px-3 py-2.5 w-[340px] text-left">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted mb-1.5">Why {f.drProbPct}% · the ledger</div>
            <div className="text-[13px] text-ink flex justify-between"><span>{f.baselineLabel}</span><span className="font-semibold">{f.baselinePct}%</span></div>
            {f.adjustments.map((a, i) => (
              <div key={i} className="mt-1.5">
                <div className="text-[13px] text-ink flex justify-between gap-2">
                  <span>{a.label}</span>
                  <span className={`font-semibold shrink-0 ${a.pts >= 0 ? "text-accent" : "text-danger"}`}>{a.pts >= 0 ? "+" : ""}{a.pts}</span>
                </div>
                {a.evidence && <div className="text-[11px] text-muted italic leading-snug">{a.evidence}</div>}
              </div>
            ))}
            <div className="mt-2 pt-1.5 border-t border-line text-[13px] font-bold text-ink flex justify-between">
              <span>DealRipe</span>
              <span>{f.drProbPct}% · closes {fmtDate(f.drCloseDate)}</span>
            </div>
            {f.recoverableUsd > 0 && (
              <div className="text-[12.5px] text-accent mt-1">Resolves to {f.resolvedProbPct}% if the open flags close → +{moneyK(f.recoverableUsd)} weighted upside.</div>
            )}
          </div>
        </details>
      </td>
      <td className={`px-4 py-3 text-[13.5px] text-right font-bold ${f.recoverableUsd > 0 ? "text-danger" : "text-muted"}`}>
        {f.recoverableUsd > 0 ? `+${moneyK(f.recoverableUsd)}` : "—"}
      </td>
      <td className="px-4 py-3 text-[13px] whitespace-nowrap">
        <span className="text-muted">{fmtDate(f.repCloseDate)}</span>
        {f.drCloseDate !== f.repCloseDate && (
          <>
            <span className="text-muted"> → </span>
            <span className="font-semibold text-danger">{fmtDate(f.drCloseDate)}</span>
          </>
        )}
      </td>
      <td className="px-4 py-3">
        {alertId ? (
          <Link
            href={withTenant(`/today#${alertId}`, tenant)}
            title={f.bucket === "needs_you" ? "Open what needs you on Today" : "See what's in flight on Today"}
            className={`text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded hover:opacity-80 transition underline decoration-dotted underline-offset-2 ${b.cls}`}
          >
            {b.label} →
          </Link>
        ) : (
          <span
            title="Monitored continuously; nothing due. The moment a watcher fires, this deal surfaces in Today."
            className={`text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${b.cls}`}
          >
            {b.label}
          </span>
        )}
      </td>
    </tr>
  );
}

function Metric({ label, value, sub, accent, danger }: { label: string; value: string; sub: string; accent?: boolean; danger?: boolean }) {
  const cls = accent ? "text-accent" : danger ? "text-danger" : "text-ink";
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider font-semibold text-muted">{label}</div>
      <div className={`text-[30px] font-bold mt-1 ${cls}`}>{value}</div>
      <div className="text-[12px] text-muted mt-0.5">{sub}</div>
    </div>
  );
}

function Bridge({ label, value, tone, bold }: { label: string; value: string; tone: "ink" | "accent" | "danger"; bold?: boolean }) {
  const cls = tone === "accent" ? "text-accent" : tone === "danger" ? "text-danger" : "text-ink";
  return (
    <div className="text-center px-2">
      <div className="text-[11px] uppercase tracking-wider font-semibold text-muted">{label}</div>
      <div className={`${bold ? "text-[23px]" : "text-[19px]"} font-bold mt-0.5 ${cls}`}>{value}</div>
    </div>
  );
}
function Arrow() {
  return <span className="text-muted text-[15px]">→</span>;
}

/** 8-week forecast trend: end-of-week DealRipe weighted, oldest → newest, with
 *  the selected week highlighted so the chart answers to the tabs. */
function Sparkline({ weeks, selected }: { weeks: WaterfallWeek[]; selected: string }) {
  const chron = [...weeks].reverse();
  const pts = chron.map((w) => w.endWeightedUsd);
  if (pts.length < 2) return null;
  const selIdx = chron.findIndex((w) => w.weekOf === selected);
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const W = 320;
  const H = 72;
  const pad = 8;
  const x = (i: number) => pad + (i * (W - 2 * pad)) / (pts.length - 1);
  const y = (v: number) => (max === min ? H / 2 : pad + (1 - (v - min) / (max - min)) * (H - 2 * pad));
  const path = pts.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const first = pts[0];
  const up = last >= first;
  const color = up ? "#22c55e" : "#ef4444";
  return (
    <div className="flex items-center gap-3">
      <svg width={W} height={H} className="shrink-0" aria-label="8-week forecast trend">
        <path d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((v, i) => (
          <circle key={i} cx={x(i)} cy={y(v)} r={i === selIdx ? 5.5 : 2.5} fill={i === selIdx ? "#0f172a" : color} stroke={i === selIdx ? "#fff" : "none"} strokeWidth={i === selIdx ? 2 : 0} />
        ))}
      </svg>
      <div className="text-[12px] text-muted leading-tight">
        <div className="font-semibold text-ink">8-week trend</div>
        <div>{moneyK(first)} → {moneyK(last)}</div>
        {selIdx >= 0 && (
          <div className="mt-0.5">
            <span className="font-semibold text-ink">{chron[selIdx].label.replace("Week of ", "")}:</span> {moneyK(pts[selIdx])}
          </div>
        )}
      </div>
    </div>
  );
}
function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-4 py-2.5 text-[10px] uppercase tracking-wider font-semibold text-muted ${right ? "text-right" : "text-left"}`}>{children}</th>;
}
