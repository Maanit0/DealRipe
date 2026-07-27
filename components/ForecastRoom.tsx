"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { demoEmailDraft, upcomingSlots } from "@/lib/demo-drafts";
import type { ForecastRoom, ForecastRoomAction, ForecastRoomDeal } from "@/lib/forecast-room";
import { DEFAULT_TENANT_SLUG, withTenant } from "@/lib/tenant-nav";

// ============================================================
// Money + helpers
// ============================================================
function money(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${Math.round(v)}`;
}
function signedMoney(v: number): string {
  const sign = v >= 0 ? "+" : "−";
  return `${sign}${money(Math.abs(v))}`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  } catch {
    return "—";
  }
}
const HEALTH: Record<ForecastRoomDeal["health"], { label: string; chip: string }> = {
  at_risk: { label: "At risk", chip: "bg-danger/10 text-danger" },
  stalled: { label: "Stalled", chip: "bg-warn/10 text-warn" },
  healthy: { label: "Healthy", chip: "bg-accent/10 text-accent" },
};

function isBooking(a: ForecastRoomAction): boolean {
  return a.actionType === "book_meeting";
}
// Prefer a real drafted email (which already carries proposed times) over the raw
// calendar picker. Asking a champion to broker a meeting is an email with times,
// not DealRipe silently booking a slot. The picker is only a fallback when no
// grounded draft exists.
function actionIsEmail(a: ForecastRoomAction): boolean {
  return !!demoEmailDraft(a.account) || !isBooking(a);
}
// A real customer-facing email draft for a non-booking action. Uses the grounded
// per-account draft for demo deals; falls back to a neutral scheduling email.
function draftEmail(a: ForecastRoomAction): { to: string; subject: string; body: string } {
  const demo = demoEmailDraft(a.account);
  if (demo) return demo;
  const body = [
    "Hi,",
    "",
    "I wanted to follow up on where we are and find time to connect.",
    "",
    "A few windows that work on my side:",
    ...upcomingSlots(3).map((t) => `  •  ${t}`),
    "",
    "Let me know what works and I will get it on the calendar.",
    "",
    "Best,",
  ].join("\n");
  return { to: `${a.account} contact`, subject: `Following up, ${a.account}`, body };
}
// 4 proposed weekday slots over the coming days, for the calendar broker.
function proposeSlots(): Array<{ label: string; se: boolean }> {
  const times = ["10:00 AM PT", "1:30 PM PT", "9:00 AM PT", "3:00 PM PT"];
  const out: Array<{ label: string; se: boolean }> = [];
  const d = new Date();
  let added = 0;
  while (added < 4) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    const day = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    out.push({ label: `${day} · ${times[added]}`, se: added % 2 === 0 });
    added += 1;
  }
  return out;
}

// ============================================================
// Entry: the room, or the deal-by-deal review flow.
// ============================================================
export function ForecastRoomView({ data, tenant }: { data: ForecastRoom; tenant: string }) {
  const [reviewing, setReviewing] = useState(false);
  if (reviewing) {
    return <ReviewFlow data={data} tenant={tenant} onExit={() => setReviewing(false)} />;
  }
  return <Room data={data} tenant={tenant} onStart={() => setReviewing(true)} />;
}

// ============================================================
// The room
// ============================================================
function Room({ data, tenant, onStart }: { data: ForecastRoom; tenant: string; onStart: () => void }) {
  const hasTarget = data.hasTarget;
  const gap = hasTarget ? data.gapToTargetUsd : data.overcommitUsd;
  const dealsAtRisk = data.deals.filter((d) => d.health === "at_risk").length;

  const [openAction, setOpenAction] = useState<ForecastRoomAction | null>(null);
  const [slot, setSlot] = useState<string | null>(null);
  const [doneState, setDoneState] = useState<Record<string, "sent" | "booked">>({});
  const slots = useMemo(() => proposeSlots(), []);

  useEffect(() => {
    if (!openAction) return;
    setSlot(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenAction(null);
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [openAction]);

  function confirmAction() {
    if (!openAction) return;
    setDoneState((p) => ({ ...p, [openAction.dealId]: actionIsEmail(openAction) ? "sent" : "booked" }));
    setOpenAction(null);
  }

  return (
    <div className="max-w-[1180px] mx-auto px-6 py-7 pb-28">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-ink">Forecast Room</h1>
          <p className="text-[13px] text-muted mt-1">
            Pipeline review for the week of {data.weekOf}. The rep&apos;s number next to DealRipe&apos;s, and what closes the gap.
          </p>
        </div>
        <div className="flex items-center gap-3 text-[12px]">
          <Link href={withTenant("/actions", tenant)} className="text-accent hover:underline">Actions</Link>
          <Link href={withTenant("/digests", tenant)} className="text-accent hover:underline">Weekly digest</Link>
          {tenant === DEFAULT_TENANT_SLUG && (
            <Link href="/review?view=pipeline" className="text-accent hover:underline">Full pipeline changes</Link>
          )}
        </div>
      </div>

      {/* The number */}
      <section className="mt-5 bg-white rounded-xl2 shadow-card border border-line p-7">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-7 md:gap-6">
          {hasTarget ? (
            <Cell label="Quarter target" value={money(data.quarterTargetUsd)} sub={data.quarterLabel} tone="muted" />
          ) : (
            <Cell label="Total pipeline" value={money(data.pipelineTotalUsd)} sub={`${data.deals.length} deals`} tone="muted" />
          )}
          <Cell label="DealRipe forecast" value={money(data.drWeightedUsd)} sub="Weighted by qualification" tone="ink" hero />
          <button onClick={onStart} className="text-left group" aria-label="Start pipeline review">
            <Cell
              label={hasTarget ? "Gap to target" : "Overcommit"}
              value={money(gap)}
              prefix={hasTarget ? <span className="text-danger">−</span> : undefined}
              sub={hasTarget ? `${dealsAtRisk} deal${dealsAtRisk === 1 ? "" : "s"} can close it` : "reps above DealRipe"}
              subClickable
              tone="danger"
              large
            />
          </button>
          <Cell
            label="Rep commit"
            value={money(data.repWeightedUsd)}
            sub={`Likely overcommit by ${money(data.overcommitUsd)}`}
            subTone="danger"
            tone="muted"
            small
          />
        </div>
        <div className="mt-7 pt-5 border-t border-line">
          <p className="text-[13.5px] italic text-muted leading-relaxed max-w-[820px]">
            If you carry the rep number, you commit {money(data.overcommitUsd)} that the calls do not yet support. If you carry
            DealRipe&apos;s number, {hasTarget ? "you have a plan to close to target." : "you’re forecasting on what the calls actually support."}
          </p>
        </div>
      </section>

      {/* What changed this week */}
      <section className="mt-9">
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">What changed this week and why</h2>
        <p className="text-[13px] text-muted mt-0.5 mb-3">DealRipe forecast reads with the reason behind each.</p>
        {data.changed.length === 0 ? (
          <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
            No forecast moves this week. Every deal reads as the rep has it.
          </div>
        ) : (
          <div className="bg-white rounded-xl2 shadow-card border border-line overflow-x-auto">
            <table className="w-full text-left text-[13px] min-w-[1120px]">
              <thead className="bg-bg/50 border-b border-line">
                <tr className="text-[10px] uppercase tracking-wider font-semibold text-muted">
                  <th className="px-5 py-3 w-[200px]">Deal</th>
                  <th className="px-2 py-3">Stage</th>
                  <th className="px-2 py-3">ARR</th>
                  <th className="px-2 py-3">Close</th>
                  <th className="px-2 py-3">Rep</th>
                  <th className="px-2 py-3">Rep forecast</th>
                  <th className="px-2 py-3">DealRipe</th>
                  <th className="px-2 py-3 text-right">{hasTarget ? "Delta" : "Status"}</th>
                  <th className="px-5 py-3">Why DealRipe reads it this way</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.changed.map((d) => (
                  <tr key={d.dealId} className="align-top hover:bg-bg/40">
                    <td className="px-5 py-3.5">
                      <Link href={withTenant(`/deals/${d.dealId}`, tenant)} className="font-medium text-ink hover:underline">
                        {d.account}
                      </Link>
                      {d.industry && <div className="text-[11px] text-muted mt-0.5">{d.industry}</div>}
                    </td>
                    <td className="px-2 py-3.5 text-ink whitespace-nowrap">
                      {d.stageKey ? <span className="text-muted">{d.stageKey} · </span> : null}
                      {d.stageLabel}
                    </td>
                    <td className="px-2 py-3.5 text-ink font-medium whitespace-nowrap">{money(d.arr)}</td>
                    <td className="px-2 py-3.5 text-muted whitespace-nowrap">{fmtDate(d.closeDate)}</td>
                    <td className="px-2 py-3.5 text-ink whitespace-nowrap">{d.repName}</td>
                    <td className="px-2 py-3.5 text-muted whitespace-nowrap">{d.repProbPct}% &middot; {d.repCategory}</td>
                    <td className="px-2 py-3.5 text-ink font-semibold whitespace-nowrap">{d.drProbPct}% &middot; {d.drCategory}</td>
                    <td className="px-2 py-3.5 text-right whitespace-nowrap">
                      {hasTarget ? (
                        <span className={`font-bold ${d.deltaPts < 0 ? "text-danger" : "text-accent"}`}>
                          {d.deltaPts > 0 ? "+" : ""}{d.deltaPts}pt
                        </span>
                      ) : (
                        <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded ${HEALTH[d.health].chip}`}>
                          {HEALTH[d.health].label}
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-ink leading-snug min-w-[280px]">{d.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* What closes the gap */}
      <section className="mt-9">
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">What closes your {money(gap)} gap</h2>
        <p className="text-[13px] text-muted mt-0.5 mb-3">The prescribed actions, ranked by weighted forecast lift.</p>
        <div className="space-y-3">
          {data.actions.map((a, i) => {
            const state = doneState[a.dealId];
            return (
              <div key={a.dealId} className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
                <div className="grid grid-cols-1 md:grid-cols-[1fr_240px]">
                  <div className="p-6">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-mono text-[11px] font-bold text-muted">{String(i + 1).padStart(2, "0")}</span>
                      <span className="text-[12px] font-medium text-muted">{a.account}</span>
                      {a.prescribed && (
                        <span className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                          DealRipe prescribed
                        </span>
                      )}
                      {state && (
                        <span className="text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-accent/10 text-accent">
                          {state === "sent" ? "Sent" : "Booked"}
                        </span>
                      )}
                    </div>
                    <p className="text-[18px] font-semibold text-ink leading-snug tracking-tight">{a.title}</p>
                    {a.detail && <p className="text-[13.5px] text-ink/80 leading-relaxed mt-2 max-w-[560px]">{a.detail}</p>}
                    <button
                      onClick={() => setOpenAction(a)}
                      className="mt-4 inline-flex items-center gap-1.5 px-4 py-2.5 rounded-lg text-[13px] font-semibold bg-ink text-white hover:bg-ink/90 transition"
                    >
                      {isBooking(a) ? "Open and book" : "Open and send"} <span aria-hidden>&rarr;</span>
                    </button>
                  </div>
                  <div className="border-t md:border-t-0 md:border-l border-line bg-bg p-5 space-y-3">
                    <Impact label="Close probability" value={`+${a.closeProbLiftPts} points`} />
                    <Impact label="Weighted lift" value={signedMoney(a.weightedLiftUsd)} bold />
                    <div className="pt-2 border-t border-line">
                      <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">Confidence</div>
                      <div className={`text-[13px] font-semibold ${a.confidence === "High" ? "text-accent" : "text-warn"}`}>{a.confidence}</div>
                      <p className="text-[11px] text-muted leading-snug mt-1">{a.confidenceNote}</p>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {openAction && (
        <div onClick={() => setOpenAction(null)} className="fixed inset-0 z-50 bg-black/45 flex items-center justify-center p-4">
          <div onClick={(e) => e.stopPropagation()} className="bg-white rounded-xl2 shadow-lg w-full max-w-[600px] max-h-[88vh] flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-line flex items-start justify-between gap-4 shrink-0">
              <div>
                <div className="text-[10px] uppercase tracking-wider font-bold text-accent">
                  {openAction.prescribed ? "DealRipe prescribed" : "Drafted by DealRipe"}
                </div>
                <div className="text-[16px] font-semibold text-ink mt-0.5">{openAction.title}</div>
                <div className="text-[12px] text-muted mt-0.5">{openAction.account}</div>
              </div>
              <button onClick={() => setOpenAction(null)} aria-label="Close" className="shrink-0 h-7 w-7 rounded-lg flex items-center justify-center text-muted hover:text-ink hover:bg-bg transition text-[15px]">✕</button>
            </div>

            <div className="px-5 py-4 overflow-auto">
              {openAction.detail && (
                <div className="mb-4 bg-accent/5 border border-accent/20 rounded-lg p-3.5">
                  <div className="text-[10px] uppercase tracking-wider font-bold text-accent mb-1">Why DealRipe recommends this</div>
                  <div className="text-[13px] text-ink leading-relaxed">{openAction.detail}</div>
                </div>
              )}
              {actionIsEmail(openAction) ? (
                <div className="space-y-3">
                  <Field label="To" value={draftEmail(openAction).to} />
                  <Field label="Subject" value={draftEmail(openAction).subject} />
                  <div>
                    <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">Body</div>
                    <div className="text-[13px] text-ink leading-relaxed whitespace-pre-wrap bg-bg rounded-lg border border-line p-3.5">{draftEmail(openAction).body}</div>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="text-[10px] uppercase tracking-wider font-bold text-muted">Proposed times</div>
                  <div className="flex flex-col gap-2">
                    {slots.map((s) => (
                      <button
                        key={s.label}
                        onClick={() => setSlot(s.label)}
                        className={`text-left px-3.5 py-2.5 rounded-lg border text-[13px] font-medium transition flex items-center justify-between gap-3 ${slot === s.label ? "border-ink bg-ink text-white" : "border-line text-ink hover:border-ink/40"}`}
                      >
                        <span>{s.label}</span>
                        {s.se && <span className={`text-[10.5px] ${slot === s.label ? "text-white/80" : "text-muted"}`}>your solutions engineer is free</span>}
                      </button>
                    ))}
                  </div>
                  <p className="text-[12px] text-muted leading-snug">DealRipe checked both calendars. Pick a slot and it sends the invite.</p>
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t border-line flex items-center justify-between gap-3 shrink-0">
              <span className="text-[11.5px] text-muted">DealRipe drafted this. Review, then {actionIsEmail(openAction) ? "send" : "book"}.</span>
              <div className="flex items-center gap-2">
                <button onClick={() => setOpenAction(null)} className="text-[13px] font-semibold text-muted hover:text-ink transition px-2">Cancel</button>
                <button
                  onClick={confirmAction}
                  disabled={!actionIsEmail(openAction) && !slot}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-accent text-white text-[13px] font-semibold hover:bg-accent/90 transition disabled:opacity-40"
                >
                  {actionIsEmail(openAction) ? "Send email" : "Book it"} <span aria-hidden>&rarr;</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Forecast accuracy — demo tenant only (the 90/63/184 figures are illustrative). */}
      {hasTarget && (
      <section className="mt-9">
        <h2 className="text-[17px] font-semibold tracking-tight text-ink">Why trust the DealRipe forecast</h2>
        <p className="text-[13px] text-muted mt-0.5 mb-3">Forecast accuracy over the last eight quarters.</p>
        <div className="bg-white rounded-xl2 shadow-card border border-line p-7 grid grid-cols-1 sm:grid-cols-2 gap-7">
          <div>
            <div className="text-[48px] font-bold text-accent tracking-tight leading-none">{data.calibration.drAccuracyPct}%</div>
            <div className="text-[14px] font-semibold text-ink mt-2">DealRipe forecast accuracy</div>
            <p className="text-[12px] text-muted mt-1 leading-snug">
              Average deviation from actual close: {money(data.calibration.drDeviationUsd)}, learned from {data.calibration.dealsTrainedOn} deals.
            </p>
          </div>
          <div>
            <div className="text-[36px] font-semibold text-muted tracking-tight leading-none">{data.calibration.repAccuracyPct}%</div>
            <div className="text-[13px] font-semibold text-muted mt-2">Rep commit accuracy</div>
            <p className="text-[12px] text-muted mt-1 leading-snug">
              Reps carry {money(data.overcommitUsd)} more than the calls support this week.
            </p>
          </div>
        </div>
      </section>
      )}

      <button
        onClick={onStart}
        className="fixed bottom-6 right-6 inline-flex items-center gap-2 px-5 py-3.5 rounded-xl2 bg-ink text-white text-[14px] font-semibold shadow-cardHover hover:bg-ink/90 transition z-10"
      >
        Start Pipeline Review <span aria-hidden>&rarr;</span>
      </button>
    </div>
  );
}

function Cell({
  label,
  value,
  prefix,
  sub,
  subClickable,
  subTone,
  tone,
  hero,
  large,
  small,
}: {
  label: string;
  value: string;
  prefix?: React.ReactNode;
  sub: string;
  subClickable?: boolean;
  subTone?: "danger";
  tone: "ink" | "muted" | "danger";
  hero?: boolean;
  large?: boolean;
  small?: boolean;
}) {
  const color = tone === "danger" ? "text-danger" : tone === "muted" ? "text-muted" : "text-ink";
  const size = hero ? "text-[46px] sm:text-[52px]" : large ? "text-[38px] sm:text-[42px]" : small ? "text-[26px]" : "text-[32px]";
  const weight = hero || large ? "font-bold" : "font-semibold";
  const subColor = subTone === "danger" ? "text-danger" : "text-muted";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-2">{label}</div>
      <div className={`${size} ${weight} ${color} tracking-tight leading-none flex items-baseline`}>
        {prefix}
        {value}
      </div>
      <div className={`mt-2 text-[12px] leading-snug ${subColor} ${subClickable ? "group-hover:text-ink group-hover:underline" : ""}`}>
        {sub}
      </div>
    </div>
  );
}

function Impact({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted">{label}</div>
      <div className={`text-[14px] mt-0.5 text-ink ${bold ? "font-bold" : "font-semibold"}`}>{value}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-1">{label}</div>
      <div className="text-[13px] text-ink font-medium leading-snug">{value}</div>
    </div>
  );
}

// ============================================================
// The deal-by-deal review flow
// ============================================================
type ReviewState = { notes: string; assignedTo: string; discussed: boolean };

function ReviewFlow({ data, tenant, onExit }: { data: ForecastRoom; tenant: string; onExit: () => void }) {
  const deals = data.deals;
  const [index, setIndex] = useState(0);
  const [state, setState] = useState<Record<string, ReviewState>>(() =>
    Object.fromEntries(deals.map((d) => [d.dealId, { notes: "", assignedTo: "", discussed: false }])),
  );
  const [done, setDone] = useState(false);

  const deal = deals[index];
  const current = state[deal?.dealId ?? ""] ?? { notes: "", assignedTo: "", discussed: false };

  function update(patch: Partial<ReviewState>) {
    setState((prev) => ({ ...prev, [deal.dealId]: { ...prev[deal.dealId], ...patch } }));
  }
  function next() {
    update({ discussed: true });
    if (index + 1 >= deals.length) setDone(true);
    else setIndex(index + 1);
  }

  if (done) {
    const assigned = Object.values(state).filter((s) => s.assignedTo).length;
    return (
      <div className="max-w-[760px] mx-auto px-6 py-14 text-center">
        <div className="w-14 h-14 rounded-full bg-accent/10 mx-auto flex items-center justify-center mb-5">
          <span className="text-accent text-[22px]">&#10003;</span>
        </div>
        <h1 className="text-[28px] font-semibold tracking-tight text-ink">Pipeline review complete.</h1>
        <p className="mt-2 text-[14px] text-muted">{deals.length} deals reviewed. {assigned} actions assigned.</p>
        <div className="mt-8 bg-white rounded-xl2 border border-line p-6 text-left max-w-[560px] mx-auto">
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-3">This week&rsquo;s assignments</div>
          <ul className="space-y-2">
            {deals.map((d) => {
              const s = state[d.dealId];
              return (
                <li key={d.dealId} className="text-[13px] text-ink leading-snug">
                  <span className="font-semibold">{d.account}: </span>
                  {s?.assignedTo ? <span>assigned to {s.assignedTo}.</span> : <span className="text-muted">no owner assigned.</span>}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="mt-7">
          <button onClick={onExit} className="inline-flex items-center gap-2 px-5 py-3 rounded-xl2 bg-ink text-white text-[14px] font-semibold hover:bg-ink/90 transition">
            Back to Forecast Room
          </button>
        </div>
      </div>
    );
  }

  const slip = deal.deltaPts < 0;
  return (
    <div className="min-h-[70vh]">
      <div className="border-b border-line bg-white -mx-6 px-6">
        <div className="max-w-[820px] mx-auto py-3 flex items-center justify-between">
          <span className="text-[12px] font-semibold text-muted">Deal {index + 1} of {deals.length}</span>
          <div className="flex items-center gap-1">
            {deals.map((d, i) => (
              <span key={d.dealId} className={`w-1.5 h-1.5 rounded-full ${i < index ? "bg-accent" : i === index ? "bg-ink" : "bg-line"}`} aria-hidden />
            ))}
          </div>
          <button onClick={onExit} className="text-[12px] font-semibold text-muted hover:text-ink transition">Exit review</button>
        </div>
      </div>

      <div className="max-w-[820px] mx-auto py-8 space-y-6">
        <div>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink leading-tight">{deal.account}</h1>
          <p className="text-[14px] text-muted mt-1">
            {money(deal.arr)} ACV{deal.industry ? ` · ${deal.industry}` : ""}
          </p>
        </div>

        <div className="bg-white rounded-xl2 shadow-card border border-line p-6">
          <div className="grid grid-cols-2 gap-6">
            <div>
              <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-2">Rep forecast</div>
              <div className="text-[28px] font-bold tracking-tight leading-none text-muted">{deal.repProbPct}%</div>
              <div className="mt-2 text-[13px] text-muted">{deal.repCategory} &middot; close {fmtDate(deal.closeDate)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-2">DealRipe forecast</div>
              <div className="text-[28px] font-bold tracking-tight leading-none text-ink">{deal.drProbPct}%</div>
              <div className="mt-2 text-[13px] text-ink font-semibold">{deal.drCategory} &middot; {deal.gatesConfirmed}/{deal.gatesTotal} gates</div>
              {slip && <div className="text-[11px] font-semibold text-danger mt-1">{deal.deltaPts}pt below the rep forecast</div>}
            </div>
          </div>
          <div className="mt-6 pt-5 border-t border-line">
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-2">Why DealRipe reads it this way</div>
            <p className="text-[13.5px] text-ink leading-relaxed">{deal.reason}</p>
            {deal.agreedNextStep && (
              <p className="text-[12.5px] text-muted leading-relaxed mt-2">Agreed next step: {deal.agreedNextStep}</p>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl2 shadow-card border border-line p-6 space-y-5">
          <div>
            <label htmlFor="notes" className="text-[10px] uppercase tracking-wider font-bold text-muted block mb-2">Notes from this review</label>
            <textarea
              id="notes"
              value={current.notes}
              onChange={(e) => update({ notes: e.target.value })}
              rows={3}
              placeholder="What did we decide on this deal?"
              className="w-full bg-bg border border-line rounded-lg p-3 text-[13.5px] text-ink leading-snug focus:outline-none focus:ring-2 focus:ring-ink/10 resize-y"
            />
          </div>
          <div>
            <label htmlFor="assign" className="text-[10px] uppercase tracking-wider font-bold text-muted block mb-2">Assign the action to</label>
            <select
              id="assign"
              value={current.assignedTo}
              onChange={(e) => update({ assignedTo: e.target.value })}
              className="w-full bg-white border border-line rounded-lg p-3 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-ink/10"
            >
              <option value="">Pick a rep</option>
              {(data.reps.length ? data.reps.map((r) => r.name) : [deal.repName]).map((r) => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => update({ discussed: true })}
              className={`px-4 py-2.5 rounded-xl2 text-[13.5px] font-semibold transition ${current.discussed ? "bg-accent/10 text-accent border border-accent/30" : "bg-white border border-line text-ink hover:bg-bg"}`}
            >
              {current.discussed ? "Marked discussed" : "Mark discussed"}
            </button>
            <button
              onClick={next}
              className="ml-auto inline-flex items-center gap-2 px-5 py-2.5 rounded-xl2 bg-ink text-white text-[13.5px] font-semibold hover:bg-ink/90 transition"
            >
              {index + 1 >= deals.length ? "Finish review" : "Next deal"} <span aria-hidden>&rarr;</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
