import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { ReviewFilterBar } from "@/components/ReviewFilterBar";
import { attachDoThis } from "@/lib/digest-synthesis";
import { resolveRange, RANGE_LABELS, type RangeKey } from "@/lib/date-range";
import { getPipelineChanges, type DealChangeRecord, type ChangeEvent } from "@/lib/pipeline-changes";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const dynamic = "force-dynamic";

const TZ = "America/Chicago";
function fmtMoney(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: TZ });
  } catch {
    return "—";
  }
}
const CHANGE_SECTIONS: Array<{ kind: ChangeEvent["kind"]; title: string }> = [
  { kind: "stage", title: "Stage changes" },
  { kind: "forecast", title: "Forecast changes" },
  { kind: "amount", title: "Amount changes" },
  { kind: "close_date", title: "Close date changes" },
  { kind: "new", title: "New opportunities" },
  { kind: "won", title: "Closed won" },
  { kind: "lost", title: "Closed lost" },
];
const MOVE_COLOR: Record<string, string> = { forward: "text-accent", backward: "text-danger", none: "text-muted" };
const TONE_DOT: Record<string, string> = { up: "bg-accent", down: "bg-danger", neutral: "bg-ink/30" };

type SP = { range?: string; from?: string; to?: string; netnew?: string; noshow?: string; rep?: string };

export default async function ReviewPage({ searchParams }: { searchParams: SP }) {
  const range = resolveRange(searchParams.range ?? "7d", searchParams.from, searchParams.to);
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

  // Filters.
  const reps = Array.from(new Map(deals.filter((d) => d.repEmail).map((d) => [d.repEmail as string, d.repName])).entries()).map(([email, name]) => ({ email, name }));
  const filtered = deals.filter((d) => {
    if (searchParams.netnew === "1" && d.isRenewal) return false;
    if (searchParams.noshow === "1" && !d.isNoShow) return false;
    if (searchParams.rep && d.repEmail !== searchParams.rep) return false;
    return true;
  });
  const attention = filtered.filter((d) => d.needsAttention);
  const flatChanges = filtered.flatMap((d) => d.changes.map((ev) => ({ account: d.account, dealId: d.dealId, ev })));

  return (
    <AppShell active="review">
      <div className="max-w-[1050px] mx-auto px-6 py-7">
        <div className="flex items-center justify-between">
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">Pipeline changes</h1>
          <div className="flex items-center gap-3 text-[12px]">
            <Link href="/forecast" className="text-accent hover:underline">Forecast room</Link>
            <Link href="/digests" className="text-accent hover:underline">Weekly digest</Link>
            <Link href="/impact" className="text-accent hover:underline">Impact</Link>
          </div>
        </div>
        <p className="text-[13px] text-muted mt-1">
          What moved on your pipeline, what needs a look before your review, and why. Rolldog fields the
          reps control, plus what the calls caught that they did not log.
        </p>

        <ReviewFilterBar reps={reps} />
        <div className="mt-2 text-[11px] text-muted">Showing {rangeLabel.toLowerCase()}.</div>

        {/* Headline */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Metric label="Total pipeline" value={fmtMoney(headline.totalPipelineAnnual)} sub="annualized" />
          <Metric label="Deals changed" value={String(headline.dealsChanged)} sub={`${headline.newOpportunities} new`} />
          <Metric label="Need attention" value={String(attention.length)} sub="flagged" danger={attention.length > 0} />
          <Metric label="Won / lost" value={`${headline.closedWon} / ${headline.closedLost}`} sub="this period" />
        </div>
        {headline.forecastMix.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {headline.forecastMix.map((b) => (
              <span key={b.category} className="text-[11px] px-2 py-1 rounded-full bg-white border border-line text-muted">
                <span className="text-ink font-medium">{b.category}</span> {b.deals} · {fmtMoney(b.annual)}
              </span>
            ))}
          </div>
        )}

        {/* Needs attention */}
        <section className="mt-6">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-muted mb-2">Deals to look at ({attention.length})</div>
          {attention.length === 0 ? (
            <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">Nothing needs attention in this window.</div>
          ) : (
            <div className="space-y-3">
              {attention.map((d) => (
                <div key={d.dealId} className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
                  <div className="px-5 py-3.5 flex items-start gap-4 border-b border-line/70">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-medium text-ink">
                        <Link href={`/deals/${d.dealId}`} className="hover:underline">{d.account}</Link>
                        {d.isRenewal && <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-ink/[0.06] text-muted">Renewal</span>}
                      </div>
                      <div className="text-[11px] text-muted mt-0.5">
                        Rolldog: {d.stageName ?? "—"} · {d.forecastCategory ?? "—"} · closes {fmtDate(d.closeDate)} · {d.dealSizeAnnual ? fmtMoney(d.dealSizeAnnual) + "/yr" : "size —"}
                        {d.score ? ` · score ${d.score}` : ""} · {d.repName}
                      </div>
                    </div>
                    <span className="shrink-0 text-[11px] text-muted whitespace-nowrap">
                      {d.daysToClose != null ? `${d.daysToClose}d to close` : ""}
                    </span>
                  </div>
                  <div className="px-5 py-3 space-y-2 text-[13px]">
                    <div>
                      <span className="text-ink text-[11px] uppercase tracking-wider font-semibold">Moved this week: </span>
                      <span className={`font-medium ${MOVE_COLOR[d.movement.direction] ?? "text-ink"}`}>{d.movement.summary}</span>
                    </div>
                    {d.whatChanged.length > 0 && (
                      <ul className="space-y-1">
                        {d.whatChanged.map((w, i) => (
                          <li key={i} className="flex items-start gap-2 text-ink">
                            <span className={`shrink-0 mt-1.5 h-1.5 w-1.5 rounded-full ${TONE_DOT[w.tone] ?? "bg-ink/30"}`} />
                            <span>{w.label && <span className="font-semibold">{w.label}: </span>}{w.text}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="text-[11px] text-muted">
                      {d.isNoShow ? (
                        <span className="text-warn">Last meeting {fmtDate(d.lastConversationAt) || "recently"} · no-show</span>
                      ) : d.lastConversationAt ? (
                        <span>Last call {fmtDate(d.lastConversationAt)}</span>
                      ) : null}
                    </div>
                    {d.primaryContact && (
                      <div className="text-[11px] text-muted">
                        Main contact: <span className="text-ink">{d.primaryContact.name}</span>
                        {d.primaryContact.role ? ` · ${d.primaryContact.role}` : ""}
                        {d.primaryContact.relationship ? ` · ${d.primaryContact.relationship}` : ""}
                      </div>
                    )}
                    {d.lastConversationAt && !d.isNoShow && (
                      <div>
                        <span className="text-ink text-[11px] uppercase tracking-wider font-semibold">On the {fmtDate(d.lastConversationAt)} call: </span>
                        {d.agreedNextStep ? (
                          <span className="text-ink">
                            {d.agreedNextStep}
                            {d.nextStepIsMeeting && (
                              <span className={`font-medium ${d.nextMeetingBooked ? "text-accent" : "text-danger"}`}>
                                {d.nextMeetingBooked ? " The call is on the calendar." : " But no call has been booked on the calendar."}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-danger font-medium">No next step was agreed on this call.</span>
                        )}
                      </div>
                    )}
                    {d.captured.length > 0 && (
                      <div className="text-ink">
                        <span className="text-ink text-[11px] uppercase tracking-wider font-semibold">Captured: </span>
                        {d.captured.map((c) => `${c.label}: ${c.value}`).join(" · ")}
                      </div>
                    )}
                    {d.missing.length > 0 && (
                      <div className="text-ink">
                        <span className="text-ink text-[11px] uppercase tracking-wider font-semibold">Missing: </span>
                        {d.missing.join(", ")}
                      </div>
                    )}
                    {d.blockers.length > 0 && (
                      <div>
                        <div className="text-ink text-[11px] uppercase tracking-wider font-semibold mb-1">What&apos;s blocking</div>
                        <ul className="space-y-1">
                          {d.blockers.map((b, i) => (
                            <li key={i} className="flex items-start gap-2 text-ink">
                              <span className="shrink-0 mt-1.5 h-1.5 w-1.5 rounded-full bg-danger" />
                              <span>{b}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {d.doThis && (
                      <div className="pt-1">
                        <span className="text-ink text-[11px] uppercase tracking-wider font-semibold">Rep&apos;s next move: </span>
                        <span className="text-ink">{d.doThis}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* What changed (Kent grid) */}
        <section className="mt-8">
          <div className="text-[11px] uppercase tracking-wider font-semibold text-muted mb-2">What moved ({flatChanges.length})</div>
          {flatChanges.length === 0 ? (
            <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">No field changes in this window.</div>
          ) : (
            <div className="space-y-4">
              {CHANGE_SECTIONS.map(({ kind, title }) => {
                const rows = flatChanges.filter((c) => c.ev.kind === kind);
                if (rows.length === 0) return null;
                return (
                  <div key={kind}>
                    <div className="text-[12px] font-medium text-ink mb-1">{title} ({rows.length})</div>
                    <div className="bg-white rounded-xl2 shadow-card border border-line divide-y divide-line overflow-hidden">
                      {rows.map((c, i) => (
                        <div key={i} className="px-5 py-2.5 flex items-center gap-3 text-[13px]">
                          <Link href={`/deals/${c.dealId}`} className="text-accent hover:underline min-w-[140px]">{c.account}</Link>
                          <span className="text-ink">
                            {c.ev.from ? `${c.ev.from} → ${c.ev.to}` : c.ev.to ?? ""}
                          </span>
                          <span className="ml-auto text-[11px] text-muted">
                            {c.ev.source === "rolldog" ? "logged" : "caught on call"} · {fmtDate(c.ev.at)}
                          </span>
                        </div>
                      ))}
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

function Metric({ label, value, sub, danger }: { label: string; value: string; sub?: string; danger?: boolean }) {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-4 py-3">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`text-[20px] font-semibold ${danger ? "text-danger" : "text-ink"}`}>{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}
