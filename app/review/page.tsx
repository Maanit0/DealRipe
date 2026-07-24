import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { ReviewFilterBar } from "@/components/ReviewFilterBar";
import { attachDoThis } from "@/lib/digest-synthesis";
import { resolveRange, RANGE_LABELS, type RangeKey } from "@/lib/date-range";
import { getPipelineChanges, type DealChangeRecord, type ChangeEvent } from "@/lib/pipeline-changes";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const dynamic = "force-dynamic";

const TZ = "America/Chicago";
function money(n: number | null): string {
  if (n == null) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: TZ });
  } catch {
    return "—";
  }
}
function fmtShortDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });
  } catch {
    return "—";
  }
}
function inDays(days: number | null): string {
  if (days == null) return "";
  if (days === 0) return "today";
  if (days > 0) return `in ${days} day${days === 1 ? "" : "s"}`;
  return `${-days} day${days === -1 ? "" : "s"} ago`;
}

const HEALTH: Record<DealChangeRecord["dealHealth"], { label: string; chip: string }> = {
  at_risk: { label: "At Risk", chip: "bg-danger/10 text-danger" },
  stalled: { label: "Stalled", chip: "bg-warn/10 text-warn" },
  healthy: { label: "Healthy", chip: "bg-accent/10 text-accent" },
  no_data: { label: "No calls yet", chip: "bg-ink/[0.06] text-muted" },
};
// Mark's triage order: at-risk first, then stalled, then healthy, then untracked;
// within each tier the biggest deals lead, tiny risks sink to the bottom.
const TIER: Record<DealChangeRecord["dealHealth"], number> = { at_risk: 0, stalled: 1, healthy: 2, no_data: 3 };

function ageDays(iso: string | null): string {
  if (!iso) return "—";
  const d = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  return Number.isFinite(d) ? `${d}d` : "—";
}

const CHANGE_SECTIONS: Array<{ kind: ChangeEvent["kind"]; title: string }> = [
  { kind: "stage", title: "Stage moves" },
  { kind: "forecast", title: "Forecast shifts" },
  { kind: "close_date", title: "Close-date moves" },
  { kind: "amount", title: "Amount changes" },
  { kind: "new", title: "New opportunities" },
  { kind: "won", title: "Closed won" },
  { kind: "lost", title: "Closed lost" },
];

type SP = { range?: string; from?: string; to?: string; netnew?: string; noshow?: string; rep?: string; tracked?: string };

function nextStep(d: DealChangeRecord): string {
  if (d.dealHealth === "no_data") return "—";
  if (d.doThis) return d.doThis;
  if (d.verdict.kind === "confirmed") return "Keep momentum and lock the next step.";
  if (d.verdict.kind === "lags") return "Update the forecast to match, and book the next step.";
  return d.blockers[0] ?? "Confirm the next step on the next call.";
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(" ", max);
  return s.slice(0, cut > 20 ? cut : max).replace(/[.,;]$/, "") + "…";
}

// Cut a long answer to one clean clause: a full sentence if short, else the first
// natural break (comma / and / which), else a word boundary. Avoids dangling "…".
function clause(s: string, max = 120): string {
  const t = s.trim();
  const dot = t.search(/[.!?](\s|$)/);
  if (dot >= 0 && dot <= max) return t.slice(0, dot + 1);
  const comma = t.indexOf(", ", 35);
  if (comma >= 0 && comma <= max) return t.slice(0, comma);
  const conj = t.search(/\s(and|which|but|so|because)\s/i);
  if (conj >= 35 && conj <= max) return t.slice(0, conj);
  return clip(t, max);
}

// The up-to-date read for the master table: DealRipe's full captured picture on
// the deal (competitor, budget, buyer, driver, timeline), not just this week's
// delta, plus the single biggest blocker. Kept to a glance.
function readText(d: DealChangeRecord): string {
  if (d.dealHealth === "no_data") return "No tracked calls yet.";
  const captured = d.captured.slice(0, 2).map((c) => `${c.label}: ${clause(c.value)}`);
  const bits: string[] = [];
  if (captured.length) bits.push(captured.join(" · "));
  if (d.blockers.length) bits.push(`Blocking: ${d.blockers[0]}`);
  return bits.length ? bits.join(" · ") : d.verdict.text || "—";
}

export default async function ReviewPage({ searchParams }: { searchParams: SP }) {
  const range = resolveRange(searchParams.range ?? "this_week", searchParams.from, searchParams.to);
  const rangeLabel = range.key === "custom" ? `${searchParams.from} to ${searchParams.to}` : RANGE_LABELS[range.key as RangeKey];

  let deals: DealChangeRecord[] = [];
  let headline = { totalPipelineAnnual: 0, forecastMix: [], closedWon: 0, closedLost: 0, dealsChanged: 0, dealsNeedingAttention: 0, newOpportunities: 0 } as Awaited<ReturnType<typeof getPipelineChanges>>["headline"];
  try {
    const tenantId = await resolveTenantId("magaya");
    const pc = await getPipelineChanges(tenantId, { sinceIso: range.sinceIso ?? new Date(Date.now() - 7 * 864e5).toISOString(), untilIso: range.untilIso ?? new Date().toISOString() });
    await attachDoThis(pc.deals);
    deals = pc.deals;
    headline = pc.headline;
  } catch (err) {
    console.error("[review] load failed:", err);
  }

  const reps = Array.from(new Map(deals.filter((d) => d.repEmail).map((d) => [d.repEmail as string, d.repName])).entries()).map(([email, name]) => ({ email, name }));
  const filtered = deals.filter((d) => {
    if (searchParams.netnew === "1" && d.isRenewal) return false;
    if (searchParams.noshow === "1" && !d.isNoShow) return false;
    if (searchParams.tracked === "1" && d.dealHealth === "no_data") return false;
    if (searchParams.rep && d.repEmail !== searchParams.rep) return false;
    return true;
  });

  // Master: every substantive deal. Mark's triage order: status tier first (at
  // risk, then stalled, then healthy, then untracked), biggest deals within each.
  const master = filtered
    .filter((d) => d.inRolldog || d.blockers.length > 0 || d.whatChanged.length > 0 || d.isNoShow)
    .sort((a, b) => TIER[a.dealHealth] - TIER[b.dealHealth] || (b.dealSizeMonthly ?? 0) - (a.dealSizeMonthly ?? 0));

  // Factual scan: CRM changes flattened, grouped by dimension, each sorted by amount.
  // Only genuine from->to diffs count as "moves". A bare stage entry with no known
  // prior stage (Rolldog's current-stage-date, no snapshot history yet) is not a
  // move, so it's excluded rather than shown with an empty From.
  const recordById = new Map(filtered.map((d) => [d.dealId, d] as const));
  const isRealChange = (ev: ChangeEvent) => {
    if (ev.kind === "new" || ev.kind === "won" || ev.kind === "lost" || ev.kind === "removed") return true;
    return ev.from != null && ev.to != null; // stage/forecast/amount/close need both ends
  };
  const flatChanges = filtered.flatMap((d) => d.changes.filter(isRealChange).map((ev) => ({ account: d.account, dealId: d.dealId, ev })));

  // --- KPIs ---
  const sum = (arr: DealChangeRecord[]) => arr.reduce((n, d) => n + (d.dealSizeMonthly ?? 0), 0);
  const isClosed = (d: DealChangeRecord) => /won|lost/i.test(d.status ?? "");
  const openDeals = master.filter((d) => !d.archived && !isClosed(d));
  const cat = (re: RegExp) => {
    const ds = openDeals.filter((d) => re.test(d.forecastCategory ?? ""));
    return { n: ds.length, m: sum(ds) };
  };
  const kpiTotal = { n: openDeals.length, m: sum(openDeals) };
  const kpiCommit = cat(/commit/i);
  const kpiExpect = cat(/expect/i);
  const kpiPipeline = cat(/pipeline/i);
  const kpiOmitted = cat(/omit/i);
  const wonDeals = filtered.filter((d) => d.changes.some((c) => c.kind === "won"));
  const kpiWon = { n: wonDeals.length, m: sum(wonDeals) };

  const health = (k: DealChangeRecord["dealHealth"]) => {
    const ds = master.filter((d) => d.dealHealth === k);
    return { n: ds.length, m: sum(ds) };
  };
  const kpiAtRisk = health("at_risk");
  const kpiStalled = health("stalled");
  const kpiHealthy = health("healthy");
  const kpiNoData = health("no_data");

  const changeCount = (kind: ChangeEvent["kind"]) => flatChanges.filter((c) => c.ev.kind === kind).length;
  const caughtCount = (re: RegExp) => master.filter((d) => d.whatChanged.some((w) => re.test(w.label ?? ""))).length;
  const kpiNoShows = master.filter((d) => d.isNoShow).length;

  return (
    <AppShell active="review">
      <div className="max-w-[1320px] mx-auto px-6 py-7">
        <div className="flex items-center justify-between">
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">Pipeline changes</h1>
          <div className="flex items-center gap-3 text-[12px]">
            <Link href="/forecast" className="text-accent hover:underline">Forecast room</Link>
            <Link href="/digests" className="text-accent hover:underline">Weekly digest</Link>
            <Link href="/impact" className="text-accent hover:underline">Impact</Link>
          </div>
        </div>
        <p className="text-[13px] text-muted mt-1">
          Every deal ranked by amount, with the rep&apos;s forecast next to DealRipe&apos;s and the read on each.
        </p>

        <ReviewFilterBar reps={reps} />
        <div className="mt-2 text-[11px] text-muted">Showing {rangeLabel.toLowerCase()}. Amounts are monthly, as in RollDog.</div>

        {/* Top KPIs: total + forecast categories + closed won (Kent parity) */}
        <div className="mt-4 grid grid-cols-3 sm:grid-cols-6 gap-3">
          <Metric label="Total Pipeline" value={money(kpiTotal.m)} sub={`${kpiTotal.n} deals`} />
          <Metric label="Commit" value={money(kpiCommit.m)} sub={`${kpiCommit.n} deals`} />
          <Metric label="Expect" value={money(kpiExpect.m)} sub={`${kpiExpect.n} deals`} />
          <Metric label="Pipeline" value={money(kpiPipeline.m)} sub={`${kpiPipeline.n} deals`} />
          <Metric label="Omitted" value={money(kpiOmitted.m)} sub={`${kpiOmitted.n} deals`} />
          <Metric label="Closed Won" value={money(kpiWon.m)} sub={`${kpiWon.n} deals`} success />
        </div>

        {/* Health band: DealRipe's triage at a glance */}
        <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Metric label="At Risk" value={String(kpiAtRisk.n)} sub={`${money(kpiAtRisk.m)}/mo`} danger={kpiAtRisk.n > 0} />
          <Metric label="Stalled" value={String(kpiStalled.n)} sub={`${money(kpiStalled.m)}/mo`} warn={kpiStalled.n > 0} />
          <Metric label="Healthy" value={String(kpiHealthy.n)} sub={`${money(kpiHealthy.m)}/mo`} success />
          <Metric label="No calls yet" value={String(kpiNoData.n)} sub="untracked" />
        </div>

        {/* Master table */}
        <section className="mt-7">
          <h2 className="text-[17px] font-semibold text-ink mb-3">All deals</h2>
          {master.length === 0 ? (
            <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[14px] text-muted">No deals in this window.</div>
          ) : (
            <div className="bg-white rounded-xl2 shadow-card border border-line overflow-x-auto">
              <table className="w-full text-[13px] min-w-[1180px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider font-semibold text-muted border-b border-line bg-bg/40">
                    <th className="px-4 py-3">Account</th>
                    <th className="px-2 py-3">Stage</th>
                    <th className="px-2 py-3 text-right">Amount</th>
                    <th className="px-2 py-3">Close Date</th>
                    <th className="px-2 py-3">Rep Category</th>
                    <th className="px-2 py-3">DealRipe Category</th>
                    <th className="px-2 py-3">Status</th>
                    <th className="px-2 py-3">Score</th>
                    <th className="px-2 py-3">Last Update</th>
                    <th className="px-2 py-3">DealRipe Read</th>
                    <th className="px-2 py-3">DealRipe Next Step</th>
                    <th className="px-4 py-3">Rep</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {master.map((d) => {
                    const h = HEALTH[d.dealHealth];
                    return (
                      <tr key={d.dealId} className="align-top hover:bg-bg/40">
                        <td className="px-4 py-3.5">
                          <Link href={`/deals/${d.dealId}`} className="font-medium text-ink hover:underline">{d.account}</Link>
                        </td>
                        <td className="px-2 py-3.5 text-ink">{d.stageName ?? "—"}</td>
                        <td className="px-2 py-3.5 text-right font-medium text-ink whitespace-nowrap">{money(d.dealSizeMonthly)}</td>
                        <td className="px-2 py-3.5 whitespace-nowrap">
                          <div className="text-ink">{fmtDate(d.closeDate)}</div>
                          {d.daysToClose != null && <div className="text-[11px] text-muted">{inDays(d.daysToClose)}</div>}
                        </td>
                        <td className="px-2 py-3.5 text-ink">{d.forecastCategory ?? "—"}</td>
                        <td className="px-2 py-3.5 text-ink font-medium">{d.dealRipeCategory ?? "—"}</td>
                        <td className="px-2 py-3.5"><span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded ${h.chip} whitespace-nowrap`}>{h.label}</span></td>
                        <td className="px-2 py-3.5 text-ink">{d.score ?? "—"}</td>
                        <td className="px-2 py-3.5 text-muted whitespace-nowrap">{fmtShortDate(d.lastUpdatedAt)}</td>
                        <td className="px-2 py-3.5 text-ink leading-relaxed min-w-[280px]">{readText(d)}</td>
                        <td className="px-2 py-3.5 leading-relaxed min-w-[220px]">
                          {d.dealHealth === "no_data" ? (
                            <span className="text-muted">—</span>
                          ) : (
                            <Link href={`/actions?deal=${d.dealId}`} className="text-ink hover:text-accent hover:underline">
                              {clause(nextStep(d), 200)}
                            </Link>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-ink whitespace-nowrap">{d.repName}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
            <span><span className="inline-block w-2 h-2 rounded-sm bg-danger align-[1px]" /> At Risk — DealRipe below the rep, or a blocker</span>
            <span><span className="inline-block w-2 h-2 rounded-sm bg-warn align-[1px]" /> Stalled — sitting too long or no next step</span>
            <span><span className="inline-block w-2 h-2 rounded-sm bg-accent align-[1px]" /> Healthy — aligned and progressing</span>
            <span><span className="inline-block w-2 h-2 rounded-sm bg-ink/30 align-[1px]" /> No calls yet — DealRipe hasn&apos;t joined a call</span>
          </div>
        </section>

        {/* Factual scan: per-change-type tables (Kent style) */}
        <section className="mt-10">
          <h2 className="text-[17px] font-semibold text-ink">What changed</h2>
          <p className="text-[13px] text-muted mt-0.5 mb-4">Per dimension, sorted by amount. From = value at the start of the window, to = now.</p>

          {/* CRM change counts (Kent parity), 4 per row */}
          <div className="text-[11px] uppercase tracking-wider text-muted mb-2">Logged in RollDog</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <CountCard label="Closed Won" value={kpiWon.n} sub="won" color="text-accent" />
            <CountCard label="Closed Lost" value={headline.closedLost} sub="lost" color="text-danger" />
            <CountCard label="Stage Changes" value={changeCount("stage")} sub="moved stage" />
            <CountCard label="Forecast Changes" value={changeCount("forecast")} sub="category shifts" />
            <CountCard label="Amount Changes" value={changeCount("amount")} sub="re-valued" />
            <CountCard label="Date Changes" value={changeCount("close_date")} sub="close moved" />
            <CountCard label="New Opportunities" value={changeCount("new")} sub="new pipeline" />
            <CountCard label="Removed" value={changeCount("removed")} sub="dropped" />
          </div>

          {/* DealRipe-caught counts (the edge) */}
          <div className="text-[11px] uppercase tracking-wider text-muted mb-2">Caught by DealRipe on calls</div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
            <CountCard label="Competitor" value={caughtCount(/compet/i)} sub="identified" color="text-accent" />
            <CountCard label="Budget" value={caughtCount(/budget/i)} sub="surfaced" color="text-accent" />
            <CountCard label="Economic Buyer" value={caughtCount(/buyer|economic|authority|decision/i)} sub="named" color="text-accent" />
            <CountCard label="Drivers" value={caughtCount(/why|driver|situation/i)} sub="captured" color="text-accent" />
            <CountCard label="No-shows" value={kpiNoShows} sub="missed" color="text-danger" />
          </div>

          {flatChanges.length === 0 ? (
            <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[14px] text-muted">No field changes in this window yet. Rolldog deltas fill in as daily snapshots accrue.</div>
          ) : (
            <div className="space-y-5">
              {CHANGE_SECTIONS.map(({ kind, title }) => {
                const rows = flatChanges
                  .filter((c) => c.ev.kind === kind)
                  .sort((a, b) => (recordById.get(b.dealId)?.dealSizeMonthly ?? 0) - (recordById.get(a.dealId)?.dealSizeMonthly ?? 0));
                if (rows.length === 0) return null;
                return (
                  <div key={kind}>
                    <div className="text-[14px] font-semibold text-ink mb-1.5">{title} ({rows.length})</div>
                    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-x-auto">
                      <table className="w-full text-[13px] min-w-[980px]">
                        <thead>
                          <tr className="text-left text-[11px] uppercase tracking-wider font-semibold text-muted border-b border-line bg-bg/40">
                            <th className="px-4 py-2.5">Changed</th>
                            <th className="px-2 py-2.5">Account</th>
                            <th className="px-2 py-2.5">Stage</th>
                            <th className="px-2 py-2.5">From</th>
                            <th className="px-2 py-2.5">To</th>
                            <th className="px-2 py-2.5 text-right">Amount</th>
                            <th className="px-2 py-2.5">Close Date</th>
                            <th className="px-2 py-2.5">Category</th>
                            <th className="px-2 py-2.5">Age</th>
                            <th className="px-4 py-2.5">Rep</th>
                            <th className="px-4 py-2.5">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {rows.map((c, i) => {
                            const d = recordById.get(c.dealId);
                            const h = d ? HEALTH[d.dealHealth] : null;
                            return (
                              <tr key={i} className="align-top hover:bg-bg/40">
                                <td className="px-4 py-3 text-muted whitespace-nowrap">{fmtDate(c.ev.at)}</td>
                                <td className="px-2 py-3"><Link href={`/deals/${c.dealId}`} className="font-medium text-ink hover:underline">{c.account}</Link></td>
                                <td className="px-2 py-3 text-ink">{d?.stageName ?? "—"}</td>
                                <td className="px-2 py-3 text-muted whitespace-nowrap">{c.ev.from ?? "—"}</td>
                                <td className="px-2 py-3 text-ink font-medium whitespace-nowrap">{c.ev.to ?? "—"}</td>
                                <td className="px-2 py-3 text-right text-ink whitespace-nowrap">{money(d?.dealSizeMonthly ?? null)}</td>
                                <td className="px-2 py-3 text-ink whitespace-nowrap">{fmtShortDate(d?.closeDate ?? null)}</td>
                                <td className="px-2 py-3 text-ink">{d?.forecastCategory ?? "—"}</td>
                                <td className="px-2 py-3 text-muted whitespace-nowrap">{ageDays(d?.createdAt ?? null)}</td>
                                <td className="px-4 py-3 text-ink whitespace-nowrap">{d?.repName ?? "—"}</td>
                                <td className="px-4 py-3">{h && <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${h.chip} whitespace-nowrap`}>{h.label}</span>}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function Metric({ label, value, sub, danger, warn, success }: { label: string; value: string; sub?: string; danger?: boolean; warn?: boolean; success?: boolean }) {
  const color = danger ? "text-danger" : warn ? "text-warn" : success ? "text-accent" : "text-ink";
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={`text-[28px] font-semibold leading-tight mt-0.5 ${color}`}>{value}</div>
      {sub && <div className="text-[12px] text-muted mt-0.5">{sub}</div>}
    </div>
  );
}

function CountCard({ label, value, sub, color }: { label: string; value: number; sub: string; color?: string }) {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={`text-[30px] font-semibold leading-tight mt-0.5 ${color ?? "text-ink"}`}>{value}</div>
      <div className="text-[12px] text-muted mt-0.5">{sub}</div>
    </div>
  );
}
