"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Header from "@/components/Header";
import { getSession, isOnboarded, SessionUser } from "@/lib/auth";
import { dealsForUser, Deal } from "@/lib/deals";
import { SCOTSMAN_FIELDS, STAGES, gateStatus } from "@/lib/scotsman";

export default function Dashboard() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const u = getSession();
    if (!u) { router.replace("/login"); return; }
    if (!isOnboarded()) { router.replace("/onboarding"); return; }
    setUser(u);
    setReady(true);
  }, [router]);

  if (!ready || !user) return <div className="min-h-screen bg-bg" />;

  const deals = dealsForUser(user.role, user.aeName);

  const totalValue = deals.reduce((s, d) => s + d.valueUsd, 0);
  const atRisk = deals.filter(d => isAtRisk(d)).length;
  const blocked = deals.filter(d => !gateOf(d).go).length;

  return (
    <div className="min-h-screen bg-bg">
      <Header user={user} />
      <main className="max-w-[1200px] mx-auto px-6 py-8">
        <div className="mb-7">
          <h1 className="text-[26px] font-semibold tracking-tight text-ink">
            Welcome back, {user.firstName}.
          </h1>
          <p className="text-sm text-muted mt-1">
            Topsort · Q1 2026 · {deals.length} active {deals.length === 1 ? "deal" : "deals"}
          </p>
        </div>

        {/* Metric cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-7">
          <Metric label="Active Deals" value={deals.length.toString()} accent="navy" />
          <Metric label="At Risk" value={atRisk.toString()} accent={atRisk > 0 ? "danger" : "muted"} />
          <Metric label="Blocked" value={blocked.toString()} accent={blocked > 0 ? "danger" : "muted"} />
          <Metric label="Pipeline" value={formatMoney(totalValue)} accent="accent" />
        </div>

        {/* Deal cards */}
        <div className="space-y-3">
          {deals.map(d => (
            <DealCard key={d.id} deal={d} />
          ))}
        </div>
      </main>
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: "navy" | "accent" | "danger" | "muted";
}) {
  const stripe = {
    navy: "bg-navy",
    accent: "bg-accent",
    danger: "bg-danger",
    muted: "bg-line",
  }[accent];
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line p-5 relative overflow-hidden">
      <div className={`absolute left-0 top-0 bottom-0 w-1 ${stripe}`} />
      <div className="text-[28px] font-semibold tracking-tight text-ink leading-none">{value}</div>
      <div className="text-[12px] uppercase tracking-wide text-muted font-medium mt-2">
        {label}
      </div>
    </div>
  );
}

function DealCard({ deal }: { deal: Deal }) {
  const gate = gateOf(deal);
  const stage = STAGES.find(s => s.key === deal.stageKey)!;
  const confirmed = SCOTSMAN_FIELDS.filter(f => deal.status[f.id] === "Yes").length;
  const total = SCOTSMAN_FIELDS.length;
  const pct = (confirmed / total) * 100;
  const stale = deal.lastActivityDays > 14;

  return (
    <Link
      href={`/deals/${deal.id}`}
      className="block bg-white rounded-xl2 shadow-card hover:shadow-cardHover border border-line p-5 transition group"
    >
      <div className="flex items-start justify-between gap-6">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h3 className="text-[17px] font-semibold text-ink group-hover:text-navy transition">
              {deal.name}
            </h3>
            <StatusPill go={gate.go} />
          </div>
          <div className="text-[13px] text-muted mt-0.5">
            {deal.ae} · {stage.label} {stage.pct} · {formatMoney(deal.valueUsd)}
          </div>

          {/* SCOTSMAN bar */}
          <div className="mt-4 max-w-[420px]">
            <div className="flex items-center justify-between text-[12px] mb-1.5">
              <span className="text-muted">SCOTSMAN qualification</span>
              <span className="font-medium text-ink">
                {confirmed}/{total} fields confirmed
              </span>
            </div>
            <div className="h-1.5 bg-line rounded-full overflow-hidden">
              <div
                className={`h-full ${gate.go ? "bg-accent" : confirmed / total > 0.6 ? "bg-warn" : "bg-danger"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          {/* Insight */}
          <div className="mt-3 text-[13px] text-ink/80 flex gap-2">
            <span className={`mt-0.5 ${!gate.go || stale ? "text-danger" : "text-accent"}`}>●</span>
            <span>{deal.insight}</span>
          </div>
        </div>

        <div className="text-right shrink-0">
          <div
            className={`text-[12px] font-medium ${
              stale ? "text-danger" : "text-muted"
            }`}
          >
            {deal.lastActivityDays} {deal.lastActivityDays === 1 ? "day" : "days"} since activity
          </div>
          {stale && (
            <div className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-danger bg-dangerSoft px-2 py-0.5 rounded-full">
              At Risk
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

function StatusPill({ go }: { go: boolean }) {
  return go ? (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-accent bg-accentSoft px-2 py-0.5 rounded-full">
      ● GO
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-danger bg-dangerSoft px-2 py-0.5 rounded-full">
      ● BLOCKED
    </span>
  );
}

function gateOf(deal: Deal) {
  const stage = STAGES.find(s => s.key === deal.stageKey)!;
  return gateStatus(stage, deal.status);
}

function isAtRisk(deal: Deal): boolean {
  const stale = deal.lastActivityDays > 14;
  const blocked = !gateOf(deal).go;
  return stale || (blocked && deal.lastActivityDays >= 3);
}

function formatMoney(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(0)}K`;
  return `$${v}`;
}
