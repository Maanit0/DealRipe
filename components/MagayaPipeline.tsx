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
}: {
  deals: Deal[];
  framework: Framework | null;
  digest?: DigestEntry[];
}) {
  const rows: Row[] = framework ? deals.map((deal) => buildRow(deal, framework)) : [];

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

  return (
    <div className="min-h-screen bg-bg">
      <main className="max-w-[1200px] mx-auto px-6 py-7">
        <div className="flex items-baseline justify-between gap-4 mb-5">
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">Magaya</h1>
          <div className="text-[12px] text-muted">
            {rows.length} deal{rows.length === 1 ? "" : "s"} · {atRisk} at risk · {stalled} stalled
          </div>
        </div>

        {digest.length > 0 && (
          <div className="mb-5">
            <MagayaDigest entries={digest} />
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-5 bg-white rounded-xl2 shadow-card border border-line p-6">
          <Metric label="Fields auto-logged" value={String(fieldsLogged)} cls="text-ink font-bold" sub="reps didn't enter these" />
          <Metric label="Open gaps flagged" value={String(openGaps)} cls="text-ink font-bold" sub="blindspots surfaced" />
          <Metric label="Commit-reality mismatches" value={String(mismatches)} cls={mismatches > 0 ? "text-danger font-bold" : "text-ink font-bold"} sub="rep ahead of evidence" />
          <Metric label="Calls captured" value={String(callsCaptured)} cls="text-ink font-bold" sub="from Teams" />
        </div>
        <p className="text-[11px] text-muted mt-2 pl-1">
          Field-match accuracy and hours-saved are graded in the operator view.
        </p>

        {rows.length === 0 ? (
          <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line p-8 text-center">
            <p className="text-[14px] text-ink font-medium">No pilot deals yet</p>
            <p className="text-[12px] text-muted mt-1">
              Once Mark names the three deals and they are seeded, they appear here.
            </p>
          </div>
        ) : (
          <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-line">
                  <Th className="pl-5">Account</Th>
                  <Th>Status</Th>
                  <Th>Stage</Th>
                  <Th>Rep category</Th>
                  <Th className="pr-5">DealRipe read</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={row.deal.id} className={i < rows.length - 1 ? "border-b border-line" : undefined}>
                    <td className="pl-5 py-3.5">
                      <Link href={`/deals/${row.deal.id}`} className="text-[14px] font-semibold text-ink hover:text-accent transition">
                        {row.deal.account}
                      </Link>
                      <div className="text-[11px] text-muted mt-0.5">
                        {row.deal.industry} · {money(row.deal.arr)}
                      </div>
                    </td>
                    <td className="py-3.5"><StatusBadge health={row.health} /></td>
                    <td className="py-3.5 text-[12px]">
                      <div className="text-ink font-medium">{STAGE_LABELS[row.deal.stageKey] ?? row.deal.stageKey}</div>
                      <div className={`text-[11px] mt-0.5 ${row.deal.daysInStage > 21 ? "text-danger font-semibold" : "text-muted"}`}>
                        {row.deal.daysInStage} days in stage
                      </div>
                    </td>
                    <td className="py-3.5">
                      <span className="text-[12px] font-semibold text-ink">{row.category}</span>
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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

  const lateStage = stageRank(deal.stageKey) >= 4;
  let health: Health = "healthy";
  if (mismatch || (lateStage && currentOpen > 0)) health = "at_risk";
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
