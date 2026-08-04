import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { getWatcherDataset, totals } from "@/lib/watcher/datasets";
import type { Alert, MorningBrief } from "@/lib/watcher/types";
import { DEFAULT_TENANT_SLUG, withTenant } from "@/lib/tenant-nav";

export const dynamic = "force-dynamic";

type SP = { tenant?: string; view?: string };

function moneyK(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (a >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${Math.round(v)}`;
}

const SEV: Record<Alert["severity"], { chip: string; label: string }> = {
  critical: { chip: "bg-danger/10 text-danger", label: "Critical" },
  high: { chip: "bg-warn/10 text-warn", label: "High" },
  info: { chip: "bg-accent/10 text-accent", label: "Info" },
};

function timeAgo(iso: string): string {
  const h = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 3_600_000));
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

export default function TodayPage({ searchParams }: { searchParams: SP }) {
  const tenant = searchParams.tenant ?? DEFAULT_TENANT_SLUG;
  const ds = getWatcherDataset(tenant);

  return (
    <AppShell active="today" tenant={tenant}>
      {ds ? (
        <Feed dsSlug={tenant} view={searchParams.view ?? "leader"} />
      ) : (
        <div className="max-w-[980px] mx-auto px-6 py-7 text-[14px] text-muted">
          No watcher dataset for this tenant.
        </div>
      )}
    </AppShell>
  );
}

function Feed({ dsSlug, view }: { dsSlug: string; view: string }) {
  const ds = getWatcherDataset(dsSlug)!;
  const t = totals(ds);
  const needsYou = ds.alerts.filter((a) => a.state === "escalated" || (a.owner === "leader" && a.state === "new"));
  const handled = ds.alerts.filter((a) => a.state === "in_flight");
  const resolved = ds.alerts.filter((a) => a.state === "resolved");
  const brief = view === "rep" ? ds.repBrief : ds.leaderBrief;

  return (
    <div className="max-w-[980px] mx-auto px-6 py-7 space-y-6" style={{ zoom: 1.15 }}>
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] uppercase tracking-wider font-semibold text-muted">
            {ds.companyName} · watched continuously
          </div>
          <h1 className="text-[22px] font-semibold text-ink mt-1">Today</h1>
          <p className="text-[14px] text-muted mt-1 max-w-[680px]">
            DealRipe watches every deal, every call, every email, all the time, and interrupts only when it pays for
            itself. Everything below arrived before you opened anything.
          </p>
        </div>
        <div className="text-right text-[13px] text-muted">
          <div>
            Pipeline <span className="font-semibold text-ink">{moneyK(t.pipeline)}</span> · DealRipe forecast{" "}
            <span className="font-semibold text-accent">{moneyK(t.drW)}</span>
          </div>
          <div className="mt-0.5">
            Recoverable at risk <span className="font-semibold text-danger">{moneyK(t.recoverable)}</span>
          </div>
          <div className="mt-1">
            <Link href={withTenant("/commitments", dsSlug)} className="text-accent font-semibold hover:underline">
              Commitment Ledger →
            </Link>
          </div>
        </div>
      </div>

      {/* The inbox-rendered morning brief: the cold open */}
      <InboxBrief brief={brief} />

      {/* Needs you */}
      <section>
        <SectionHead
          tone="danger"
          title={`Needs you · ${needsYou.length}`}
          sub="Escalations only: un-actioned past the window, or calls only you can make."
        />
        <div className="space-y-3 mt-3">
          {needsYou.map((a) => (
            <AlertCard key={a.id} a={a} />
          ))}
        </div>
      </section>

      {/* Being handled */}
      <section>
        <SectionHead
          tone="warn"
          title={`Being handled · ${handled.length}`}
          sub="Reps have these, drafts approved or in flight. You're watching the immune system work."
        />
        <div className="space-y-3 mt-3">
          {handled.map((a) => (
            <AlertCard key={a.id} a={a} compact />
          ))}
        </div>
      </section>

      {/* Resolved */}
      {resolved.length > 0 && (
        <section>
          <SectionHead tone="accent" title={`Resolved this week · ${resolved.length}`} sub="Closed loops, receipts kept." />
          <div className="space-y-3 mt-3">
            {resolved.map((a) => (
              <AlertCard key={a.id} a={a} compact />
            ))}
          </div>
        </section>
      )}

      {/* Weekly receipt */}
      <Receipt dsSlug={dsSlug} />
    </div>
  );
}

function SectionHead({ tone, title, sub }: { tone: "danger" | "warn" | "accent"; title: string; sub: string }) {
  const cls = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-accent";
  return (
    <div>
      <div className={`text-[11px] uppercase tracking-wider font-bold ${cls}`}>{title}</div>
      <div className="text-[13px] text-muted mt-0.5">{sub}</div>
    </div>
  );
}

function InboxBrief({ brief }: { brief: MorningBrief }) {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      {/* Email-client chrome */}
      <div className="px-5 py-3 border-b border-line bg-bg/70 flex items-center gap-3">
        <span className="w-8 h-8 rounded-full bg-ink text-white text-[13px] font-bold flex items-center justify-center shrink-0">
          DR
        </span>
        <div className="min-w-0">
          <div className="text-[14px]">
            <span className="font-semibold text-ink">DealRipe</span>
            <span className="text-muted"> &lt;notify@dealripe.com&gt; · to {brief.recipientName}</span>
          </div>
          <div className="text-[11px] text-muted">{brief.dateLabel}</div>
        </div>
        <span className="ml-auto text-[10px] uppercase tracking-wider font-bold text-muted border border-line rounded px-2 py-0.5 shrink-0">
          Morning brief · {brief.audience}
        </span>
      </div>
      <div className="px-5 py-4">
        <div className="text-[15px] font-semibold text-ink">{brief.subject}</div>
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-accent">While you were out</div>
          <ul className="mt-1.5 space-y-1">
            {brief.didOvernight.map((d, i) => (
              <li key={i} className="text-[14px] text-ink/85 leading-snug flex gap-2">
                <span className="text-accent font-bold shrink-0">✓</span>
                <span>{d}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="mt-4">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">Today</div>
          <ul className="mt-1.5 space-y-1.5">
            {brief.items.map((it, i) => (
              <li key={i} className="text-[14px] text-ink leading-snug flex gap-2">
                <span className={`shrink-0 font-bold ${it.icon === "alert" ? "text-danger" : it.icon === "call" ? "text-ink" : "text-accent"}`}>
                  {it.icon === "alert" ? "⚠" : it.icon === "call" ? "📞" : "✓"}
                </span>
                <span>{it.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="px-5 py-2 border-t border-line bg-bg text-[11px] text-muted">
        Delivered to your inbox and Slack. The app below is the receipts, not the workflow.
      </div>
    </div>
  );
}

function AlertCard({ a, compact }: { a: Alert; compact?: boolean }) {
  const sev = SEV[a.severity];
  return (
    <div id={a.id} className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden scroll-mt-6 target:ring-2 target:ring-accent/50">
      <div className="px-5 py-3.5 flex items-start gap-3">
        <span className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded mt-0.5 shrink-0 ${sev.chip}`}>{sev.label}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[15px] font-semibold text-ink">{a.title}</span>
            <span className="text-[12.5px] text-muted">
              {a.account} · {moneyK(a.amountUsd)} · {a.rep} · fired {timeAgo(a.firedAt)}
            </span>
          </div>
          <div className="text-[13.5px] text-muted italic leading-snug mt-1.5">“{a.evidence}”</div>
          {!compact && <div className="text-[13.5px] text-ink/85 leading-snug mt-1.5">{a.why}</div>}
          <div className="text-[13.5px] leading-snug mt-1.5">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-accent mr-1.5">Move</span>
            <span className="text-ink">{a.move}</span>
          </div>

          {/* State line */}
          {a.state === "in_flight" && a.actionedAt && (
            <div className="text-[12.5px] text-accent mt-1.5">✓ Rep actioned {timeAgo(a.actionedAt)} · awaiting reply · escalates to you if nothing moves in 48h</div>
          )}
          {a.state === "escalated" && <div className="text-[12.5px] text-danger mt-1.5">⚠ Escalated: rep nudged twice, no change in 48h</div>}
          {a.state === "resolved" && a.actionedAt && <div className="text-[12.5px] text-accent mt-1.5">✓ Resolved {timeAgo(a.actionedAt)}</div>}

          {/* The one-click artifact */}
          <details className="mt-2.5 group">
            <summary className="cursor-pointer list-none inline-flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 transition">
                {a.action.label} →
              </span>
              <span className="text-[11px] text-muted group-open:hidden">drafted by DealRipe · review, then one click</span>
            </summary>
            <div className="mt-2.5 rounded-lg border border-line bg-bg/60 px-4 py-3">
              {a.action.kind === "email" && (
                <div>
                  <div className="text-[11px] text-muted">To: <span className="text-ink">{a.action.to}</span></div>
                  <div className="text-[13px] font-semibold text-ink mt-1">{a.action.subject}</div>
                  <pre className="text-[13.5px] text-ink/85 whitespace-pre-wrap font-sans leading-relaxed mt-2">{a.action.body}</pre>
                </div>
              )}
              {a.action.kind === "crm_fix" && (
                <div className="text-[13.5px] text-ink/85 leading-relaxed">
                  <div>
                    <span className="font-mono text-[11px] text-muted">{a.action.field}</span>{" "}
                    <span className="line-through text-muted">{a.action.from}</span> <span className="text-muted">→</span>{" "}
                    <span className="font-semibold text-ink">{a.action.to}</span>
                  </div>
                  <div className="text-[13px] text-muted italic mt-1.5">Grounded in: {a.action.quote}</div>
                  <div className="text-[12.5px] text-muted mt-1.5">One click writes the correction to Salesforce with the quote in the field history.</div>
                </div>
              )}
              {(a.action.kind === "brief" || a.action.kind === "calendar_fix") && (
                <div className="text-[13.5px] text-ink/85 leading-relaxed">{a.action.detail}</div>
              )}
              {a.action.kind === "ping_rep" && (
                <pre className="text-[13.5px] text-ink/85 whitespace-pre-wrap font-sans leading-relaxed">{a.action.message}</pre>
              )}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

function Receipt({ dsSlug }: { dsSlug: string }) {
  const ds = getWatcherDataset(dsSlug)!;
  const r = ds.receipt;
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-5 py-3.5 border-b border-line flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">What DealRipe prevented · {r.weekLabel}</h2>
          <p className="text-[13px] text-muted mt-0.5">The Friday receipt: closed loops, corrected fiction, caught slippage.</p>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-line border-b border-line">
        <Stat label="Commitments recovered" value={String(r.commitmentsRecovered)} />
        <Stat label="Close dates corrected" value={String(r.closeDatesCorrected)} />
        <Stat label="Slippage caught early" value={moneyK(r.slippageCaughtUsd)} accent />
        <Stat label="Plays coached" value={String(r.playsCoached)} />
      </div>
      <ul className="px-5 py-3.5 space-y-1.5">
        {r.highlights.map((h, i) => (
          <li key={i} className="text-[13.5px] text-ink/85 leading-snug flex gap-2">
            <span className="text-accent font-bold shrink-0">✓</span>
            <span>{h}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="px-4 py-3">
      <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">{label}</div>
      <div className={`text-[20px] font-semibold mt-0.5 ${accent ? "text-accent" : "text-ink"}`}>{value}</div>
    </div>
  );
}
