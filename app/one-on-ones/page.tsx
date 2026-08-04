import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { REP_CALIBRATION } from "@/lib/demos/second-nature/board-meta";
import { getForecastRoom, type ForecastRoom, type ForecastRoomDeal } from "@/lib/forecast-room";
import { supabaseAdmin } from "@/lib/supabase";
import { getTasks, type TaskItem } from "@/lib/tasks";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";
import { DEFAULT_TENANT_SLUG, withTenant } from "@/lib/tenant-nav";

export const dynamic = "force-dynamic";

type SP = { tenant?: string; rep?: string };

const NEAT_STAGE: Record<string, string> = {
  SQL1: "Discovery",
  SQL2: "Evaluation",
  SQL3: "Vendor of Choice",
  SQL4: "Contract Out",
  SQL5: "Signed",
};

function moneyK(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (a >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${Math.round(v)}`;
}

type MissPattern = { label: string; count: number; total: number; accounts: string[] };

/** Gate-level miss patterns per rep: which framework category is open across
 *  their deals, so the 1:1 starts at the coaching point, not the status pull. */
async function getMissPatterns(tenantId: string): Promise<Map<string, MissPattern[]>> {
  const db = supabaseAdmin();
  const [dealsRes, fxRes, ffRes] = await Promise.all([
    db.from("deals").select("id, account, rep_email").eq("tenant_id", tenantId),
    db.from("field_extractions").select("deal_id, framework_field_key, status").eq("tenant_id", tenantId).eq("status", "No"),
    db.from("framework_fields").select("field_key, label").eq("tenant_id", tenantId),
  ]);
  const labelByKey = new Map(((ffRes.data ?? []) as Array<{ field_key: string; label: string }>).map((f) => [f.field_key, f.label]));
  const deals = (dealsRes.data ?? []) as Array<{ id: string; account: string; rep_email: string | null }>;
  const dealById = new Map(deals.map((d) => [d.id, d]));
  // rep -> label -> set of accounts with that gate open
  const agg = new Map<string, Map<string, Set<string>>>();
  const dealsPerRep = new Map<string, number>();
  for (const d of deals) {
    const rep = d.rep_email ?? "";
    dealsPerRep.set(rep, (dealsPerRep.get(rep) ?? 0) + 1);
  }
  for (const r of (fxRes.data ?? []) as Array<{ deal_id: string; framework_field_key: string }>) {
    const deal = dealById.get(r.deal_id);
    if (!deal) continue;
    const rep = deal.rep_email ?? "";
    const label = labelByKey.get(r.framework_field_key) ?? r.framework_field_key;
    const byLabel = agg.get(rep) ?? new Map<string, Set<string>>();
    const set = byLabel.get(label) ?? new Set<string>();
    set.add(deal.account);
    byLabel.set(label, set);
    agg.set(rep, byLabel);
  }
  const out = new Map<string, MissPattern[]>();
  for (const [rep, byLabel] of agg) {
    const total = dealsPerRep.get(rep) ?? 0;
    const patterns = Array.from(byLabel.entries())
      .map(([label, accounts]) => ({ label, count: accounts.size, total, accounts: Array.from(accounts) }))
      .sort((a, b) => b.count - a.count);
    out.set(rep, patterns);
  }
  return out;
}

export default async function OneOnOnesPage({ searchParams }: { searchParams: SP }) {
  const tenant = searchParams.tenant ?? DEFAULT_TENANT_SLUG;
  let room: ForecastRoom | null = null;
  let missByRepEmail = new Map<string, MissPattern[]>();
  let tasks: TaskItem[] = [];
  try {
    const tenantId = await resolveTenantId(tenant);
    [room, missByRepEmail, tasks] = await Promise.all([
      getForecastRoom(tenantId, { quarterTargetUsd: 1_500_000 }),
      getMissPatterns(tenantId),
      getTasks(tenantId),
    ]);
  } catch (err) {
    console.error("[one-on-ones] load failed:", err);
  }
  if (!room) {
    return (
      <AppShell active="oneOnOnes" tenant={tenant}>
        <div className="max-w-[1100px] mx-auto px-6 py-7 text-[13px] text-muted">1-on-1 view could not load for this tenant.</div>
      </AppShell>
    );
  }

  const reps = Array.from(new Set(room.deals.map((d) => d.repName))).sort();
  const activeRep = searchParams.rep && reps.includes(searchParams.rep) ? searchParams.rep : reps[0] ?? null;
  const repDeals = room.deals
    .filter((d) => d.repName === activeRep)
    .sort((a, b) => a.deltaPts - b.deltaPts); // biggest risk first
  const repEmail = repDeals.find((d) => d.repEmail)?.repEmail ?? null;
  const misses = (repEmail ? missByRepEmail.get(repEmail) : null) ?? [];
  const topMisses = misses.filter((m) => m.count >= 2).slice(0, 2);
  const repTasks = tasks.filter((t) => t.repEmail === repEmail && t.status !== "done").slice(0, 5);
  const cal = activeRep ? REP_CALIBRATION[activeRep] : null;
  const repCommitW = repDeals.reduce((s, d) => s + Math.round((d.arr * d.repProbPct) / 100), 0);
  const drW = repDeals.reduce((s, d) => s + Math.round((d.arr * d.drProbPct) / 100), 0);

  return (
    <AppShell active="oneOnOnes" tenant={tenant}>
      <div className="max-w-[1100px] mx-auto px-6 py-7 space-y-5" style={{ zoom: 1.15 }}>
        <div>
          <div className="text-[11px] uppercase tracking-wider font-semibold text-muted">Sales-leader view</div>
          <h1 className="text-[22px] font-semibold text-ink mt-1">1-on-1 prep</h1>
          <p className="text-[13px] text-muted mt-1 max-w-[720px]">
            Everything you would normally spend the first 30 minutes pulling out of the rep, already on one page: what moved on their deals and
            why, where their deals consistently stall, and the open actions. Walk in coaching, not gathering.
          </p>
        </div>

        {/* Rep tabs */}
        <div className="flex items-center gap-1 flex-wrap">
          {reps.map((r) => (
            <Link
              key={r}
              href={withTenant(`/one-on-ones?rep=${encodeURIComponent(r)}`, tenant)}
              className={`px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold border transition ${
                r === activeRep ? "bg-white text-ink border-line shadow-sm" : "bg-bg text-muted border-transparent hover:text-ink"
              }`}
            >
              {r}
            </Link>
          ))}
        </div>

        {/* The coaching headline: where this rep's deals stall */}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-danger">Where {activeRep}&apos;s deals stall</div>
            {topMisses.length > 0 ? (
              <div className="mt-2 space-y-3">
                {topMisses.map((m) => (
                  <div key={m.label}>
                    <div className="text-[14px] font-semibold text-ink">
                      {m.label} <span className="text-muted font-normal">open on {m.count} of {m.total} deals</span>
                    </div>
                    <div className="text-[12px] text-muted mt-0.5">{m.accounts.join(" · ")}</div>
                  </div>
                ))}
                <p className="text-[12.5px] text-ink/80 leading-relaxed pt-1 border-t border-line">
                  The pattern to coach: the same gate keeps staying open across different accounts. One conversation about how the best reps
                  close that gate moves every deal on this list at once.
                </p>
              </div>
            ) : (
              <p className="text-[13px] text-muted mt-2">No repeated gate pattern across this rep&apos;s deals right now.</p>
            )}
          </div>

          {/* Calibration */}
          <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Whose number to trust</div>
            {cal ? (
              <>
                <div className="mt-2 flex items-center gap-3">
                  <span className={`text-[10px] uppercase tracking-wider font-bold px-2 py-0.5 rounded ${cal.landsPerHundred < 95 ? "bg-danger/10 text-danger" : "bg-accent/10 text-accent"}`}>
                    {cal.landsPerHundred < 95 ? "over-commits" : cal.landsPerHundred > 100 ? "under-commits" : "calibrated"}
                  </span>
                  <span className="text-[14px] font-semibold text-ink">${cal.landsPerHundred} of every $100 committed lands</span>
                </div>
                <p className="text-[12.5px] text-muted mt-2 leading-relaxed">{cal.note}</p>
              </>
            ) : (
              <p className="text-[13px] text-muted mt-2">No calibration history yet.</p>
            )}
            <div className="mt-3 pt-3 border-t border-line flex gap-6 text-[12.5px]">
              <div>
                <span className="text-muted">Rep weighted: </span>
                <span className="font-semibold text-ink">{moneyK(repCommitW)}</span>
              </div>
              <div>
                <span className="text-muted">DealRipe: </span>
                <span className={`font-semibold ${drW < repCommitW ? "text-danger" : "text-accent"}`}>{moneyK(drW)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Their deals: delta + why + the move */}
        <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
          <div className="px-5 py-3.5 border-b border-line">
            <h2 className="text-[14px] font-semibold text-ink">{activeRep}&apos;s deals, biggest risk first</h2>
            <p className="text-[12px] text-muted mt-0.5">What changed, why DealRipe reads it that way, and the next move. No status pull needed.</p>
          </div>
          <div className="divide-y divide-line">
            {repDeals.map((d) => (
              <DealRow key={d.dealId} d={d} tenant={tenant} />
            ))}
          </div>
        </div>

        {/* Open actions */}
        {repTasks.length > 0 && (
          <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
            <div className="px-5 py-3.5 border-b border-line">
              <h2 className="text-[14px] font-semibold text-ink">Open actions on {activeRep}&apos;s deals</h2>
            </div>
            <div className="divide-y divide-line">
              {repTasks.map((t) => (
                <div key={t.id} className="px-5 py-3">
                  <div className="text-[13px] font-medium text-ink">{t.title}</div>
                  <div className="text-[11.5px] text-muted mt-0.5">
                    {t.account ?? ""}{t.deadline ? ` · due ${t.deadline}` : ""}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function DealRow({ d, tenant }: { d: ForecastRoomDeal; tenant: string }) {
  const softer = d.deltaPts < 0;
  return (
    <div className="px-5 py-4">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-2.5">
          <Link href={withTenant(`/deals/${d.dealId}`, tenant)} className="text-[14px] font-semibold text-ink hover:text-accent transition">
            {d.account}
          </Link>
          <span className="text-[11.5px] text-muted">{NEAT_STAGE[d.stageKey] ?? d.stageLabel} · {moneyK(d.arr)}</span>
        </div>
        <div className="text-[12.5px] whitespace-nowrap">
          <span className="text-muted">rep {d.repProbPct}%</span>
          <span className="text-muted"> → </span>
          <span className={`font-bold ${softer ? "text-danger" : "text-accent"}`}>DealRipe {d.drProbPct}%</span>
          {d.deltaPts !== 0 && (
            <span className={`ml-2 font-bold ${softer ? "text-danger" : "text-accent"}`}>
              {d.deltaPts > 0 ? "+" : ""}
              {d.deltaPts}pt
            </span>
          )}
        </div>
      </div>
      <p className="text-[12.5px] text-ink/80 leading-relaxed mt-1.5 max-w-[860px]">{d.reason}</p>
    </div>
  );
}
