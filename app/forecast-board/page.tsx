import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { BOARD_META, CLOSED_WON_ACCOUNTS, CLOSED_WON_BAND, REP_CALIBRATION } from "@/lib/demos/second-nature/board-meta";
import { getForecastRoom, type ForecastRoom, type ForecastRoomDeal } from "@/lib/forecast-room";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";
import { DEFAULT_TENANT_SLUG, withTenant } from "@/lib/tenant-nav";

export const dynamic = "force-dynamic";

type SP = { tenant?: string; rep?: string };

// NEAT / property-management stage labels, keyed by the underlying SQL stage key.
const NEAT_STAGE: Record<string, string> = {
  SQL1: "Discovery",
  SQL2: "Evaluation",
  SQL3: "Vendor of Choice",
  SQL4: "Contract Out",
  SQL5: "Signed",
};
const STAGE_ORDER = ["SQL1", "SQL2", "SQL3", "SQL4", "SQL5"];
function stageRank(k: string): number {
  const i = STAGE_ORDER.indexOf(k);
  return i === -1 ? STAGE_ORDER.length : i;
}

function money(v: number): string {
  return `$${Math.round(v).toLocaleString("en-US")}`;
}
function moneyK(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (a >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${Math.round(v)}`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
  } catch {
    return "—";
  }
}
function drW(d: ForecastRoomDeal): number {
  return Math.round((d.arr * d.drProbPct) / 100);
}
function repW(d: ForecastRoomDeal): number {
  return Math.round((d.arr * d.repProbPct) / 100);
}

export default async function ForecastBoardPage({ searchParams }: { searchParams: SP }) {
  const tenant = searchParams.tenant ?? DEFAULT_TENANT_SLUG;
  const repFilter = searchParams.rep ?? null;
  let room: ForecastRoom | null = null;
  try {
    const tenantId = await resolveTenantId(tenant);
    room = await getForecastRoom(tenantId, { quarterTargetUsd: 1_500_000 });
  } catch (err) {
    console.error("[forecast-board] load failed:", err);
  }

  return (
    <AppShell active="forecastBoard" tenant={tenant}>
      {room ? (
        <Board room={room} tenant={tenant} repFilter={repFilter} />
      ) : (
        <div className="max-w-[1220px] mx-auto px-6 py-7 text-[13px] text-muted">Forecast Board could not load for this tenant.</div>
      )}
    </AppShell>
  );
}

function Board({ room, tenant, repFilter }: { room: ForecastRoom; tenant: string; repFilter: string | null }) {
  const open = room.deals.filter((d) => !CLOSED_WON_ACCOUNTS.has(d.account));
  const reps = Array.from(new Set(open.map((d) => d.repName))).sort();
  const activeRep = repFilter && reps.includes(repFilter) ? repFilter : null;
  const deals = (activeRep ? open.filter((d) => d.repName === activeRep) : open)
    .slice()
    .sort((a, b) => stageRank(a.stageKey) - stageRank(b.stageKey) || b.arr - a.arr);

  // Header math (over the visible set).
  const totalPipeline = deals.reduce((s, d) => s + d.arr, 0);
  const weightedFcst = deals.reduce((s, d) => s + drW(d), 0);
  const totalDoors = deals.reduce((s, d) => s + (BOARD_META[d.account]?.doors ?? 0), 0);
  const repCommitUsd = deals.filter((d) => d.repProbPct >= 70).reduce((s, d) => s + d.arr, 0);
  const drCommitUsd = deals.filter((d) => d.drProbPct >= 70).reduce((s, d) => s + d.arr, 0);
  const bestCaseUsd = deals.filter((d) => stageRank(d.stageKey) >= 2).reduce((s, d) => s + d.arr, 0);
  const buckets = STAGE_ORDER.map((k) => ({
    key: k,
    label: NEAT_STAGE[k] ?? k,
    usd: deals.filter((d) => d.stageKey === k).reduce((s, d) => s + drW(d), 0),
    count: deals.filter((d) => d.stageKey === k).length,
  })).filter((b) => b.count > 0);

  const monthLabel = new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "America/Chicago" });
  const cal = activeRep ? REP_CALIBRATION[activeRep] : null;
  const repCommitW = deals.reduce((s, d) => s + repW(d), 0);

  return (
    <div className="max-w-[1220px] mx-auto px-6 py-7 space-y-5">
      {/* Title band, her sheet's header bar */}
      <div className="bg-navy text-white rounded-xl2 px-5 py-3.5 flex items-center justify-between gap-4 flex-wrap">
        <div className="text-[15px] font-bold">
          {monthLabel} Forecast · {activeRep ?? "All reps"} · <span className="font-medium opacity-80">updated automatically from calls, email, and calendar</span>
        </div>
        <div className="text-[11px] opacity-70">No rep data entry · every number traces to a customer quote</div>
      </div>

      {/* Rep tabs, like her sheet tabs */}
      <div className="flex items-center gap-1 flex-wrap">
        <RepTab label="Summary" href={withTenant("/forecast-board", tenant)} active={!activeRep} />
        {reps.map((r) => (
          <RepTab key={r} label={r} href={withTenant(`/forecast-board?rep=${encodeURIComponent(r)}`, tenant)} active={activeRep === r} />
        ))}
      </div>

      {/* Summary strip: totals + stage buckets + commit columns */}
      <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 divide-x divide-line border-b border-line">
          <Tile label="Total Pipeline" value={money(totalPipeline)} />
          <Tile label="Weighted Fcst" value={money(weightedFcst)} accent />
          <Tile label="# Deals" value={String(deals.length)} />
          <Tile label="Doors" value={totalDoors.toLocaleString()} />
          <Tile label="Rep Commit" value={moneyK(repCommitUsd)} />
          <Tile label="DealRipe Commit" value={moneyK(drCommitUsd)} accent />
          <Tile label="Best Case" value={moneyK(bestCaseUsd)} />
        </div>
        <div className="px-5 py-2.5 flex flex-wrap gap-x-6 gap-y-1.5 bg-bg/60">
          {buckets.map((b) => (
            <div key={b.key} className="text-[12px]">
              <span className="text-muted">{b.label}: </span>
              <span className="font-semibold text-ink">{moneyK(b.usd)}</span>
              <span className="text-muted"> ({b.count})</span>
            </div>
          ))}
        </div>
      </div>

      {/* Per-rep calibration card */}
      {activeRep && cal && (
        <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 flex items-start gap-5 flex-wrap">
          <div>
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Whose number to trust · {activeRep}</div>
            <div className="mt-1.5 flex items-center gap-3">
              <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded ${cal.landsPerHundred < 95 ? "bg-danger/10 text-danger" : cal.landsPerHundred > 100 ? "bg-accent/10 text-accent" : "bg-accent/10 text-accent"}`}>
                {cal.landsPerHundred < 95 ? "over-commits" : cal.landsPerHundred > 100 ? "under-commits" : "calibrated"}
              </span>
              <span className="text-[13px] text-ink font-semibold">${cal.landsPerHundred} of every $100 committed lands</span>
            </div>
            <p className="text-[12.5px] text-muted mt-2 max-w-[560px] leading-relaxed">{cal.note}</p>
          </div>
          <div className="flex gap-3 ml-auto">
            <div className="rounded-lg border border-line px-4 py-2.5">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Rep weighted</div>
              <div className="text-[17px] font-semibold text-ink mt-0.5">{moneyK(repCommitW)}</div>
            </div>
            <div className="rounded-lg border border-line px-4 py-2.5">
              <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">DealRipe weighted</div>
              <div className={`text-[17px] font-semibold mt-0.5 ${weightedFcst < repCommitW ? "text-danger" : "text-accent"}`}>{moneyK(weightedFcst)}</div>
            </div>
          </div>
        </div>
      )}

      {/* The book, her exact columns */}
      <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[1180px]">
            <thead className="bg-navy">
              <tr>
                {["#", "Account / Deal Name", "Type", "Stage", "Prob %", "Conf %", "Net New CARR", "Adj Weighted", "Doors", "Close Date", "Notes / Next Steps", "Rep Commit", "DR Commit", "Best Case"].map((h, i) => (
                  <th key={h} className={`px-3 py-2.5 text-[10px] uppercase tracking-wider font-bold text-white/90 whitespace-nowrap ${i >= 4 && i <= 8 ? "text-right" : "text-left"} ${i >= 11 ? "text-center" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {deals.map((d, i) => {
                const meta = BOARD_META[d.account];
                const softer = d.drProbPct < d.repProbPct;
                const repCommit = d.repProbPct >= 70;
                const dCommit = d.drProbPct >= 70;
                const best = stageRank(d.stageKey) >= 2;
                return (
                  <tr key={d.dealId} className="hover:bg-bg/50 align-top">
                    <td className="px-3 py-3 text-[12px] text-muted">{i + 1}</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <Link href={withTenant(`/deals/${d.dealId}`, tenant)} className="text-[12.5px] font-semibold text-ink hover:text-accent transition">
                        {d.account}
                      </Link>
                      {!activeRep && <div className="text-[11px] text-muted mt-0.5">{d.repName}</div>}
                    </td>
                    <td className="px-3 py-3 text-[12px] text-muted whitespace-nowrap">{meta?.type ?? "—"}</td>
                    <td className="px-3 py-3 text-[12px] text-ink whitespace-nowrap">{NEAT_STAGE[d.stageKey] ?? d.stageLabel}</td>
                    <td className="px-3 py-3 text-[12px] text-muted text-right">{d.repProbPct}%</td>
                    <td className={`px-3 py-3 text-[12.5px] text-right font-semibold ${softer ? "text-danger" : "text-accent"}`}>{d.drProbPct}%</td>
                    <td className="px-3 py-3 text-[12.5px] text-ink text-right font-medium whitespace-nowrap">{money(d.arr)}</td>
                    <td className="px-3 py-3 text-[12.5px] text-ink text-right whitespace-nowrap">{money(drW(d))}</td>
                    <td className="px-3 py-3 text-[12px] text-muted text-right">{meta?.doors?.toLocaleString() ?? "—"}</td>
                    <td className="px-3 py-3 text-[12px] text-muted whitespace-nowrap">{fmtDate(d.closeDate)}</td>
                    <td className="px-3 py-3 text-[12px] text-ink/85 leading-snug max-w-[300px]">{d.agreedNextStep ?? d.reason.split(". ")[0] + "."}</td>
                    <td className="px-3 py-3 text-center">{repCommit ? <Check /> : null}</td>
                    <td className="px-3 py-3 text-center">{dCommit ? <Check accent /> : null}</td>
                    <td className="px-3 py-3 text-center">{best ? <Check muted /> : null}</td>
                  </tr>
                );
              })}
              {/* Total row */}
              <tr className="bg-navy">
                <td className="px-3 py-2.5 text-[11px] font-bold text-white uppercase tracking-wider" colSpan={6}>
                  Total open pipeline
                </td>
                <td className="px-3 py-2.5 text-[12.5px] text-right font-bold text-white whitespace-nowrap">{money(totalPipeline)}</td>
                <td className="px-3 py-2.5 text-[12.5px] text-right font-bold text-white whitespace-nowrap">{money(weightedFcst)}</td>
                <td className="px-3 py-2.5 text-[12px] text-right font-bold text-white">{totalDoors.toLocaleString()}</td>
                <td colSpan={5} />
              </tr>
            </tbody>
          </table>
        </div>

        {/* Closed-won band, her green ritual */}
        {!activeRep && (
          <div>
            <div className="px-4 py-2 bg-accent text-white text-[11px] font-bold uppercase tracking-wider">
              🎉 Closed won this month — 1 deal · {moneyK(CLOSED_WON_BAND.carr)} CARR · {CLOSED_WON_BAND.doors} doors
            </div>
            <div className="px-4 py-2.5 bg-accentSoft/50 flex items-center gap-6 text-[12.5px] flex-wrap">
              <span className="font-semibold text-ink">✓ {CLOSED_WON_BAND.account}</span>
              <span className="text-muted">{CLOSED_WON_BAND.type}</span>
              <span className="text-muted">Closed Won · 100%</span>
              <span className="font-medium text-ink">{money(CLOSED_WON_BAND.carr)}</span>
              <span className="text-muted">{CLOSED_WON_BAND.doors} doors</span>
              <span className="text-muted">{CLOSED_WON_BAND.closeDate}</span>
              <span className="text-ink/80">{CLOSED_WON_BAND.note}</span>
            </div>
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted">
        Same layout as the sheet you keep by hand, except nothing here was typed: stages, confidence, notes, and next steps are maintained from
        the calls, and each rep&apos;s commit is weighed against how they historically forecast. Click any account for the full deal, with the
        customer&apos;s exact words behind every field.
      </p>
    </div>
  );
}

function RepTab({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`px-3.5 py-1.5 rounded-t-lg text-[12.5px] font-semibold border border-b-0 transition ${
        active ? "bg-white text-ink border-line shadow-sm" : "bg-bg text-muted border-transparent hover:text-ink"
      }`}
    >
      {label}
    </Link>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="px-4 py-3.5">
      <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">{label}</div>
      <div className={`text-[19px] font-semibold mt-0.5 ${accent ? "text-accent" : "text-ink"}`}>{value}</div>
    </div>
  );
}

function Check({ accent, muted }: { accent?: boolean; muted?: boolean }) {
  return (
    <span className={`inline-block text-[13px] font-bold ${accent ? "text-accent" : muted ? "text-muted" : "text-ink"}`}>✓</span>
  );
}
