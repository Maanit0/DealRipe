import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { getWatcherDataset } from "@/lib/watcher/datasets";
import type { Commitment } from "@/lib/watcher/types";
import { DEFAULT_TENANT_SLUG, withTenant } from "@/lib/tenant-nav";

export const dynamic = "force-dynamic";

type SP = { tenant?: string };

function moneyK(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (a >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${Math.round(v)}`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  } catch {
    return iso;
  }
}

const STATUS: Record<Commitment["status"], { label: string; cls: string }> = {
  overdue: { label: "Overdue", cls: "bg-danger/10 text-danger" },
  open: { label: "Open", cls: "bg-warn/10 text-warn" },
  kept: { label: "Kept", cls: "bg-accent/10 text-accent" },
  recovered: { label: "Recovered", cls: "bg-accent/10 text-accent" },
};

export default function CommitmentsPage({ searchParams }: { searchParams: SP }) {
  const tenant = searchParams.tenant ?? DEFAULT_TENANT_SLUG;
  const ds = getWatcherDataset(tenant);
  return (
    <AppShell active="today" tenant={tenant}>
      {ds ? (
        <Ledger tenant={tenant} />
      ) : (
        <div className="max-w-[980px] mx-auto px-6 py-7 text-[13px] text-muted">No watcher dataset for this tenant.</div>
      )}
    </AppShell>
  );
}

function Ledger({ tenant }: { tenant: string }) {
  const ds = getWatcherDataset(tenant)!;
  const order: Commitment["status"][] = ["overdue", "open", "kept", "recovered"];
  const sorted = [...ds.commitments].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const accountById = new Map(ds.forecasts.map((f) => [f.dealId, f.account]));
  const overdueCount = ds.commitments.filter((c) => c.status === "overdue").length;
  const audit = ds.inheritedAudit;

  return (
    <div className="max-w-[980px] mx-auto px-6 py-7 space-y-6" style={{ zoom: 1.15 }}>
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-wider font-semibold text-muted">{ds.companyName}</div>
          <h1 className="text-[22px] font-semibold text-ink mt-1">Commitment Ledger</h1>
          <p className="text-[13px] text-muted mt-1 max-w-[700px]">
            Every commitment made on a call or in an email, on both sides of the table, tracked to done. This is the
            mutual action plan enforcing itself: the deal is watched, not the rep, and the rep always sees their own
            flags first.
          </p>
        </div>
        <Link href={withTenant("/today", tenant)} className="text-[12.5px] font-semibold text-accent hover:underline shrink-0">
          ← Back to Today
        </Link>
      </div>

      {/* Ledger */}
      <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
        <div className="px-5 py-3.5 border-b border-line flex items-baseline justify-between gap-3">
          <h2 className="text-[14px] font-semibold text-ink">Active deals · {ds.commitments.length} tracked commitments</h2>
          <span className="text-[12px] text-danger font-semibold">{overdueCount} overdue · recovery drafts queued</span>
        </div>
        <div className="divide-y divide-line">
          {sorted.map((c) => {
            const st = STATUS[c.status];
            return (
              <div key={c.id} className="px-5 py-3.5 flex items-start gap-3">
                <span className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded mt-0.5 shrink-0 ${st.cls}`}>{st.label}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-[13px] font-semibold text-ink">{c.what}</span>
                    <span className="text-[11.5px] text-muted">
                      {accountById.get(c.dealId) ?? c.dealId} · {c.side === "rep" ? "our side" : "customer side"}: {c.who}
                    </span>
                  </div>
                  <div className="text-[12px] text-muted italic leading-snug mt-1">“{c.quote}” — {c.source}</div>
                  <div className="text-[11.5px] mt-1">
                    <span className="text-muted">Due {fmtDate(c.dueBy)}</span>
                    {c.status === "kept" && c.keptAt && <span className="text-accent"> · kept {fmtDate(c.keptAt)}</span>}
                    {c.status === "overdue" && c.side === "rep" && <span className="text-danger"> · recovery draft ready in Today</span>}
                    {c.status === "overdue" && c.side === "customer" && <span className="text-warn"> · gentle nudge drafted, no blame framing</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Inherited-pipeline audit */}
      {audit && (
        <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
          <div className="px-5 py-4 border-b border-line">
            <div className="text-[10px] uppercase tracking-wider font-bold text-danger">Inherited-pipeline audit</div>
            <h2 className="text-[16px] font-semibold text-ink mt-1">
              {audit.departedRep} departed Jul 11. DealRipe audited his book in 90 seconds.
            </h2>
            <p className="text-[12.5px] text-muted mt-1 max-w-[700px]">
              Every promise made on his calls and emails, checked against what was actually sent. This is the audit that
              usually happens months later, one painful account at a time, after the “we chose someone else” replies.
            </p>
          </div>
          <div className="grid grid-cols-3 divide-x divide-line border-b border-line">
            <Stat label="Deals scanned" value={String(audit.dealsScanned)} />
            <Stat label="Open commitments found" value={String(audit.openCommitments)} danger />
            <Stat label="Pipeline at risk" value={moneyK(audit.atRiskUsd)} danger />
          </div>
          <div className="divide-y divide-line">
            {audit.examples.map((e, i) => (
              <div key={i} className="px-5 py-3.5">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-[13px] font-semibold text-ink">{e.account}</span>
                  <span className="text-[11.5px] text-muted">{moneyK(e.amountUsd)} · {e.daysOverdue} days overdue</span>
                </div>
                <div className="text-[12.5px] text-ink/85 mt-1">{e.what}</div>
                <div className="text-[12px] text-muted italic leading-snug mt-0.5">{e.quote}</div>
              </div>
            ))}
          </div>
          <div className="px-5 py-3 border-t border-line bg-accentSoft/40 text-[12.5px] text-ink">
            <span className="font-semibold">{audit.openCommitments} recovery emails drafted and queued</span>, each opening with
            the specific thing that was promised, ready for the inheriting rep to review and send.
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="px-5 py-3.5">
      <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">{label}</div>
      <div className={`text-[22px] font-semibold mt-0.5 ${danger ? "text-danger" : "text-ink"}`}>{value}</div>
    </div>
  );
}
