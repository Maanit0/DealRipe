import Link from "next/link";
import {
  BOARD_DEALS,
  BOARD_CLOSED_WON,
  BOARD_SUMMARY,
  WEEK_BUCKETS,
  WATERFALL,
  REP_ROLLUP,
  repWeighted,
  ripeWeighted,
  type BoardDeal,
  type WeekMove,
} from "@/lib/demos/second-nature/forecast-board";

export const metadata = { title: "DealRipe · Second Nature · Forecast Board" };

function money(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (a >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${v}`;
}
function signed(v: number): string {
  return `${v >= 0 ? "+" : "−"}${money(Math.abs(v))}`;
}

const MOVE_BADGE: Record<WeekMove, { label: string; cls: string } | null> = {
  new: { label: "New", cls: "bg-accent/10 text-accent" },
  up: { label: "Progressed", cls: "bg-accent/10 text-accent" },
  down: { label: "Downgraded", cls: "bg-danger/10 text-danger" },
  slipped: { label: "Slipped to Q4", cls: "bg-danger/10 text-danger" },
  won: { label: "Won", cls: "bg-accent/10 text-accent" },
  flat: null,
};

export default function ForecastBoardPage() {
  return (
    <div className="min-h-screen bg-bg">
      <TopBar />
      <main className="max-w-[1180px] mx-auto px-6 py-7 space-y-6">
        <Header />
        <SummaryStrip />
        <WeekBridge />
        <LiveSheet />
        <RepCalibration />
        <p className="text-[11px] text-muted pt-1">
          Representative example, not live data. Accounts and reps are fictional; the pipeline shape,
          framework (NEAT), doors, and CARR mirror a Second Nature book.
        </p>
      </main>
    </div>
  );
}

function TopBar() {
  return (
    <header className="border-b border-line bg-white">
      <div className="max-w-[1180px] mx-auto px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-[14px] font-semibold tracking-tight text-ink hover:opacity-80 transition">
            DealRipe
          </Link>
          <nav className="flex items-center gap-4">
            <span className="text-[12px] font-semibold text-ink">Forecast Board</span>
            <Link href="/forecast?tenant=second-nature" className="text-[12px] font-semibold text-muted hover:text-ink transition">
              Forecast Room
            </Link>
            <Link href="/demo/second-nature" className="text-[12px] font-semibold text-muted hover:text-ink transition">
              Deal &amp; closed loop
            </Link>
          </nav>
        </div>
        <div className="text-right text-[11px] text-muted leading-tight">
          <div>Second Nature · {BOARD_SUMMARY.weekOf}</div>
          <div className="flex items-center justify-end gap-1.5 mt-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" aria-hidden />
            <span>Updated automatically from calls, email, and calendar</span>
          </div>
        </div>
      </div>
    </header>
  );
}

function Header() {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider font-semibold text-muted">
        Sales-leader view · {BOARD_SUMMARY.month}
      </div>
      <h1 className="text-[22px] font-semibold text-ink mt-1">Forecast Board</h1>
      <p className="text-[13px] text-muted mt-1 max-w-[760px]">
        The weekly forecast you keep by hand, but live. Same layout you already use, except every number is
        grounded in what the calls actually confirm, what changed since last week is surfaced with the reason, and
        each rep&apos;s commit is adjusted for how they historically forecast. Nothing here needs a rep to log in.
      </p>
    </div>
  );
}

function SummaryStrip() {
  const s = BOARD_SUMMARY;
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-6 py-5">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-5">
        <Metric label="Total open pipeline" value={money(s.totalOpenPipeline)} sub={`${s.openDeals} deals · ${s.doors.toLocaleString()} doors`} />
        <Metric label="Rep commit (weighted)" value={money(s.repCommitWeighted)} sub="What the team is committing" />
        <Metric label="DealRipe forecast" value={money(s.ripeForecastWeighted)} sub="Grounded in the calls" accent />
        <Metric label="Δ vs rep commit" value={signed(s.deltaWeighted)} sub="DealRipe below rep commit" danger />
        <Metric label="Closed won this month" value={money(s.closedWonThisMonth)} sub="1 deal · 228 doors" />
      </div>
      <div className="mt-4 pt-4 border-t border-line text-[12.5px] text-muted">
        If you commit the rep number, you are <span className="text-danger font-semibold">{money(Math.abs(s.deltaWeighted))} light</span> on
        what will actually land. DealRipe&apos;s number is lower because three deals cannot close this quarter without a specific move, and it
        tells you which move on each.
      </div>
    </div>
  );
}

function Metric({ label, value, sub, accent, danger }: { label: string; value: string; sub: string; accent?: boolean; danger?: boolean }) {
  const valueCls = accent ? "text-accent" : danger ? "text-danger" : "text-ink";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">{label}</div>
      <div className={`text-[24px] font-semibold mt-1 ${valueCls}`}>{value}</div>
      <div className="text-[11px] text-muted mt-0.5">{sub}</div>
    </div>
  );
}

function WeekBridge() {
  const w = WATERFALL;
  const steps = [
    { label: "Last week", value: money(w.lastWeekWeighted), tone: "ink" as const },
    { label: "New pipeline", value: signed(w.addedUsd), tone: "accent" as const },
    { label: "Progressed", value: signed(w.progressedUsd), tone: "accent" as const },
    { label: "Downgraded / slipped", value: signed(w.downgradedUsd), tone: "danger" as const },
    { label: "This week", value: money(w.thisWeekWeighted), tone: "ink" as const },
  ];
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-6 py-4 border-b border-line">
        <h2 className="text-[15px] font-semibold text-ink">What changed this week</h2>
        <p className="text-[12px] text-muted mt-0.5">
          Add, move, close, and why, since last Monday. This is the view Salesforce and Gong don&apos;t give you: the delta, not the snapshot.
        </p>
      </div>

      {/* Bridge */}
      <div className="px-6 py-5 border-b border-line">
        <div className="flex items-stretch gap-2 flex-wrap">
          {steps.map((st, i) => (
            <div key={st.label} className="flex items-center gap-2">
              <div className="text-center px-3">
                <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">{st.label}</div>
                <div className={`text-[18px] font-semibold mt-0.5 ${st.tone === "accent" ? "text-accent" : st.tone === "danger" ? "text-danger" : "text-ink"}`}>
                  {st.value}
                </div>
              </div>
              {i < steps.length - 1 && <span className="text-muted text-[16px]">→</span>}
            </div>
          ))}
        </div>
        <div className="mt-3 text-[12px] text-muted">{w.note}</div>
      </div>

      {/* Buckets */}
      <div className="grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-line">
        <Bucket title="Came in" tone="accent" items={WEEK_BUCKETS.added} />
        <Bucket title="Progressed" tone="accent" items={WEEK_BUCKETS.progressed} />
        <Bucket title="Won" tone="accent" items={WEEK_BUCKETS.won} />
      </div>
      <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-line border-t border-line">
        <Bucket title="Downgraded" tone="danger" items={WEEK_BUCKETS.downgraded} />
        <Bucket title="Slipped to Q4" tone="danger" items={WEEK_BUCKETS.slipped} />
      </div>
    </div>
  );
}

function Bucket({ title, tone, items }: { title: string; tone: "accent" | "danger"; items: { account: string; carr: number; detail: string }[] }) {
  return (
    <div className="px-5 py-4">
      <div className={`text-[10px] uppercase tracking-wider font-bold mb-2 ${tone === "accent" ? "text-accent" : "text-danger"}`}>
        {title} · {items.length}
      </div>
      <div className="space-y-2.5">
        {items.map((it, i) => (
          <div key={i}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[12.5px] font-medium text-ink">{it.account}</span>
              <span className="text-[11.5px] text-muted shrink-0">{money(it.carr)}</span>
            </div>
            <div className="text-[11.5px] text-muted leading-snug">{it.detail}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LiveSheet() {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-6 py-4 border-b border-line flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">The book</h2>
          <p className="text-[12px] text-muted mt-0.5">Rep commit vs DealRipe&apos;s grounded read, with the reason on every gap.</p>
        </div>
        <span className="text-[10px] uppercase tracking-wider font-bold text-muted shrink-0">No rep data entry</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left min-w-[1000px]">
          <thead className="bg-bg border-b border-line">
            <tr>
              <Th>Account</Th>
              <Th>Rep</Th>
              <Th>Type</Th>
              <Th>Stage</Th>
              <Th right>Doors</Th>
              <Th right>Net new CARR</Th>
              <Th right>Rep</Th>
              <Th right>DealRipe</Th>
              <Th right>Weighted</Th>
              <Th>Close (rep → DealRipe)</Th>
              <Th right>Δ wk</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {BOARD_DEALS.map((d) => (
              <DealRow key={d.id} d={d} />
            ))}
            <tr className="bg-accentSoft/40">
              <td className="px-4 py-2.5 text-[12.5px] font-semibold text-ink" colSpan={5}>
                Closed won this month · {BOARD_CLOSED_WON.account}
              </td>
              <td className="px-4 py-2.5 text-[12.5px] text-right font-semibold text-ink">{money(BOARD_CLOSED_WON.carr)}</td>
              <td className="px-4 py-2.5 text-right text-[12px] text-muted">100%</td>
              <td className="px-4 py-2.5 text-right text-[12px] text-muted">100%</td>
              <td className="px-4 py-2.5 text-right text-[12.5px] font-semibold text-accent">{money(BOARD_CLOSED_WON.carr)}</td>
              <td className="px-4 py-2.5 text-[12px] text-muted">{BOARD_CLOSED_WON.closeDate}</td>
              <td className="px-4 py-2.5" />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th className={`px-4 py-2.5 text-[10px] uppercase tracking-wider font-semibold text-muted ${right ? "text-right" : "text-left"}`}>
      {children}
    </th>
  );
}

function DealRow({ d }: { d: BoardDeal }) {
  const badge = MOVE_BADGE[d.move];
  const deltaCls = d.deltaPts > 0 ? "text-accent" : d.deltaPts < 0 ? "text-danger" : "text-muted";
  const dateChanged = d.repCloseDate !== d.ripeCloseDate || d.repQuarter !== d.ripeQuarter;
  return (
    <tr className="hover:bg-bg/50 align-top">
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium text-ink">{d.account}</span>
          {badge && (
            <span className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
          )}
        </div>
        {d.deltaPts !== 0 && <div className="text-[11.5px] text-muted leading-snug mt-1 max-w-[340px]">{d.why}</div>}
      </td>
      <td className="px-4 py-3 text-[12px] text-muted whitespace-nowrap">{d.rep}</td>
      <td className="px-4 py-3 text-[12px] text-muted whitespace-nowrap">{d.type}</td>
      <td className="px-4 py-3 text-[12px] text-ink whitespace-nowrap">{d.stage}</td>
      <td className="px-4 py-3 text-[12px] text-muted text-right">{d.doors.toLocaleString()}</td>
      <td className="px-4 py-3 text-[12.5px] text-ink text-right font-medium">{money(d.carr)}</td>
      <td className="px-4 py-3 text-[12px] text-muted text-right">{d.repProb}%</td>
      <td className={`px-4 py-3 text-[12.5px] text-right font-semibold ${d.ripeProb < d.repProb ? "text-danger" : "text-ink"}`}>{d.ripeProb}%</td>
      <td className="px-4 py-3 text-[12.5px] text-ink text-right">{money(ripeWeighted(d))}</td>
      <td className="px-4 py-3 whitespace-nowrap">
        <span className="text-[12px] text-muted">{d.repCloseDate}</span>
        {dateChanged && (
          <>
            <span className="text-muted"> → </span>
            <span className="text-[12px] font-semibold text-danger">{d.ripeCloseDate} · {d.ripeQuarter}</span>
          </>
        )}
      </td>
      <td className={`px-4 py-3 text-[12.5px] text-right font-bold ${deltaCls}`}>
        {d.deltaPts === 0 ? "–" : `${d.deltaPts > 0 ? "+" : ""}${d.deltaPts}`}
      </td>
    </tr>
  );
}

function RepCalibration() {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-6 py-4 border-b border-line">
        <h2 className="text-[15px] font-semibold text-ink">Whose number to trust</h2>
        <p className="text-[12px] text-muted mt-0.5">
          DealRipe learns how each rep historically forecasts and adjusts the roll-up for it, so the team number is not just the sum of everyone&apos;s optimism.
        </p>
      </div>
      <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-line">
        {REP_ROLLUP.map((r) => {
          const over = r.bias === "over-commits";
          const biasCls = over ? "bg-danger/10 text-danger" : r.bias === "under-commits" ? "bg-warn/10 text-warn" : "bg-accent/10 text-accent";
          const lands = Math.min(r.landsPerHundred, 100);
          return (
            <div key={r.rep} className="px-6 py-5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-[14px] font-semibold text-ink">{r.rep}</div>
                <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded ${biasCls}`}>
                  {r.bias}{r.biasPct !== 0 ? ` · ${r.biasPct > 0 ? "+" : ""}${r.biasPct}%` : ""}
                </span>
              </div>
              <div className="text-[11.5px] text-muted mt-0.5">{r.openDeals} open deals · {money(r.openCarr)} in play</div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-line px-3 py-2.5">
                  <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Rep commit</div>
                  <div className="text-[16px] font-semibold text-ink mt-0.5">{money(r.repCommitWeighted)}</div>
                </div>
                <div className="rounded-lg border border-line px-3 py-2.5">
                  <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">DealRipe forecast</div>
                  <div className={`text-[16px] font-semibold mt-0.5 ${over ? "text-danger" : "text-ink"}`}>{money(r.ripeForecastWeighted)}</div>
                </div>
              </div>

              {/* Calibration bar: of every $100 committed, how much lands */}
              <div className="mt-4">
                <div className="flex items-center justify-between text-[11px] text-muted mb-1">
                  <span>Of every $100 committed, historically</span>
                  <span className={`font-semibold ${over ? "text-danger" : "text-accent"}`}>${r.landsPerHundred} lands</span>
                </div>
                <div className="h-2.5 rounded-full bg-bg border border-line overflow-hidden flex">
                  <div className={`${over ? "bg-danger" : "bg-accent"} h-full`} style={{ width: `${lands}%` }} />
                </div>
              </div>

              <div className="text-[12px] text-muted leading-snug mt-3">{r.note}</div>
            </div>
          );
        })}
      </div>
      <div className="px-6 py-3 border-t border-line bg-bg text-[11.5px] text-muted">
        Adjusted for rep bias, the team lands closer to <span className="font-semibold text-ink">{money(BOARD_SUMMARY.ripeForecastWeighted)}</span> than
        the <span className="font-semibold text-ink">{money(BOARD_SUMMARY.repCommitWeighted)}</span> the roll-up shows. This is the calibration Gong doesn&apos;t do, because it takes the rep&apos;s commit at face value.
      </div>
    </div>
  );
}
