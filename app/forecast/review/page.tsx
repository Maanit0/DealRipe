"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import {
  getTenant,
  type ForecastTenant,
  type Movement,
} from "@/lib/forecast-tenants";

const REPS = [
  "Erica Klein",
  "Marcus Webb",
  "Jimmy Park",
  "Sarah Chen",
  "Priya Patel",
];

type ReviewState = {
  notes: string;
  assignedTo: string;
  discussed: boolean;
};

export default function PipelineReviewPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-bg" />}>
      <PipelineReviewInner />
    </Suspense>
  );
}

function PipelineReviewInner() {
  const params = useSearchParams();
  const tenant = getTenant(params.get("tenant"));
  const deals = tenant.movements;

  const [index, setIndex] = useState(0);
  const [state, setState] = useState<Record<string, ReviewState>>(() =>
    Object.fromEntries(
      deals.map((d) => [d.id, { notes: "", assignedTo: "", discussed: false }]),
    ),
  );
  const [done, setDone] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const deal = deals[index];
  const current = state[deal.id];

  function update(patch: Partial<ReviewState>) {
    setState((prev) => ({
      ...prev,
      [deal.id]: { ...prev[deal.id], ...patch },
    }));
  }

  function next() {
    update({ discussed: true });
    if (index + 1 >= deals.length) {
      setDone(true);
    } else {
      setIndex(index + 1);
    }
  }

  function sendRecap() {
    setToast("Recap sent to maanit@dealripe.com");
    setTimeout(() => setToast(null), 3500);
  }

  if (done) {
    const reviewed = deals.length;
    const assigned = Object.values(state).filter((s) => s.assignedTo).length;
    return (
      <div className="min-h-screen bg-bg font-sans text-ink antialiased">
        <TopBar tenant={tenant} />
        <main className="max-w-[760px] mx-auto px-6 py-16 text-center">
          <div className="w-16 h-16 rounded-full bg-accent/10 mx-auto flex items-center justify-center mb-6">
            <svg viewBox="0 0 32 32" className="w-7 h-7" fill="none" stroke="#22c55e" strokeWidth="3">
              <path d="M7 17 L13 23 L25 9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h1 className="text-[32px] font-semibold tracking-tight text-ink leading-tight">
            Pipeline review complete.
          </h1>
          <p className="mt-3 text-[14px] text-muted">
            {reviewed} deals reviewed. {assigned} actions assigned.
          </p>

          <div className="mt-10 bg-white rounded-xl2 border border-line p-6 text-left max-w-[560px] mx-auto">
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-3">
              This week&rsquo;s assignments
            </div>
            <ul className="space-y-2">
              {deals.map((d) => {
                const s = state[d.id];
                return (
                  <li key={d.id} className="text-[13px] text-ink leading-snug">
                    <span className="font-semibold">{d.account}: </span>
                    {s.assignedTo ? (
                      <span>assigned to {s.assignedTo}.</span>
                    ) : (
                      <span className="text-muted">no owner assigned.</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="mt-8 flex items-center justify-center gap-3">
            <button
              onClick={sendRecap}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl2 bg-ink text-white text-[14px] font-semibold hover:bg-ink/90 transition"
            >
              Send recap to team
              <span aria-hidden>→</span>
            </button>
            <Link
              href={`/forecast?tenant=${tenant.slug}`}
              className="text-[13px] font-semibold text-muted hover:text-ink transition"
            >
              Back to Forecast Room
            </Link>
          </div>
        </main>

        {toast && <Toast message={toast} />}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg font-sans text-ink antialiased flex flex-col">
      <TopBar tenant={tenant} />

      <div className="border-b border-line bg-white">
        <div className="max-w-[820px] mx-auto px-6 py-3 flex items-center justify-between">
          <span className="text-[12px] font-semibold text-muted">
            Deal {index + 1} of {deals.length}
          </span>
          <div className="flex items-center gap-1">
            {deals.map((d, i) => (
              <span
                key={d.id}
                className={`w-1.5 h-1.5 rounded-full ${
                  i < index
                    ? "bg-accent"
                    : i === index
                      ? "bg-ink"
                      : "bg-line"
                }`}
                aria-hidden
              />
            ))}
          </div>
          <Link
            href={`/forecast?tenant=${tenant.slug}`}
            className="text-[12px] font-semibold text-muted hover:text-ink transition"
          >
            Exit review
          </Link>
        </div>
      </div>

      <main className="flex-1 max-w-[820px] w-full mx-auto px-6 py-10">
        <DealReviewCard
          deal={deal}
          state={current}
          onUpdate={update}
          onNext={next}
        />
      </main>

      {toast && <Toast message={toast} />}
    </div>
  );
}

function TopBar({ tenant }: { tenant: ForecastTenant }) {
  return (
    <header className="border-b border-line bg-white">
      <div className="max-w-[1180px] mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="text-[14px] font-semibold tracking-tight text-ink hover:opacity-80 transition"
          >
            DealRipe
          </Link>
          <span className="text-[12px] font-semibold text-ink">
            Pipeline Review &middot; {tenant.name}
          </span>
        </div>
        <Link
          href="/pipeline"
          className="text-[12px] font-semibold text-muted hover:text-ink transition"
        >
          Pipeline
        </Link>
      </div>
    </header>
  );
}

function DealReviewCard({
  deal,
  state,
  onUpdate,
  onNext,
}: {
  deal: Movement;
  state: ReviewState;
  onUpdate: (patch: Partial<ReviewState>) => void;
  onNext: () => void;
}) {
  const slip = deal.repQuarter !== deal.thisQuarter;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[28px] font-semibold tracking-tight text-ink leading-tight">
          {deal.account}
        </h1>
        <p className="text-[14px] text-muted mt-1">
          {formatMoney(deal.arr)} ACV
          {deal.industry ? ` · ${deal.industry}` : ""}
        </p>
        {deal.productContext && (
          <p className="text-[12px] text-muted mt-1 italic">
            {deal.productContext}
          </p>
        )}
      </div>

      <div className="bg-white rounded-xl2 shadow-card border border-line p-6">
        <div className="grid grid-cols-2 gap-6">
          <ForecastBlock
            label="Rep forecast"
            prob={deal.repProb}
            quarter={deal.repQuarter}
            date={deal.repDate}
            muted
          />
          <ForecastBlock
            label="DealRipe forecast"
            prob={deal.thisProb}
            quarter={deal.thisQuarter}
            date={deal.thisDate}
            slip={slip}
          />
        </div>

        <div className="mt-6 pt-5 border-t border-line">
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-2">
            Why DealRipe changed
          </div>
          <p className="text-[13.5px] text-ink leading-relaxed">{deal.reason}</p>
        </div>
      </div>

      <div className="bg-white rounded-xl2 shadow-card border border-line p-6 space-y-5">
        <div>
          <label
            htmlFor="notes"
            className="text-[10px] uppercase tracking-wider font-bold text-muted block mb-2"
          >
            Notes from this review
          </label>
          <textarea
            id="notes"
            value={state.notes}
            onChange={(e) => onUpdate({ notes: e.target.value })}
            rows={3}
            placeholder="What did we decide on this deal?"
            className="w-full bg-bg border border-line rounded-lg p-3 text-[13.5px] text-ink leading-snug focus:outline-none focus:ring-2 focus:ring-ink/10 resize-y"
          />
        </div>

        <div>
          <label
            htmlFor="assign"
            className="text-[10px] uppercase tracking-wider font-bold text-muted block mb-2"
          >
            Assign action to
          </label>
          <select
            id="assign"
            value={state.assignedTo}
            onChange={(e) => onUpdate({ assignedTo: e.target.value })}
            className="w-full bg-white border border-line rounded-lg p-3 text-[13.5px] text-ink focus:outline-none focus:ring-2 focus:ring-ink/10"
          >
            <option value="">Pick a rep</option>
            {REPS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={() => onUpdate({ discussed: true })}
            className={`px-4 py-2.5 rounded-xl2 text-[13.5px] font-semibold transition ${
              state.discussed
                ? "bg-accent/10 text-accent border border-accent/30"
                : "bg-white border border-line text-ink hover:bg-bg"
            }`}
          >
            {state.discussed ? "Marked discussed" : "Mark discussed"}
          </button>
          <button
            onClick={onNext}
            className="ml-auto inline-flex items-center gap-2 px-5 py-2.5 rounded-xl2 bg-ink text-white text-[13.5px] font-semibold hover:bg-ink/90 transition"
          >
            Next deal
            <span aria-hidden>→</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ForecastBlock({
  label,
  prob,
  quarter,
  date,
  muted,
  slip,
}: {
  label: string;
  prob: number;
  quarter: string;
  date: string;
  muted?: boolean;
  slip?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-2">
        {label}
      </div>
      <div
        className={`text-[28px] font-bold tracking-tight leading-none ${
          muted ? "text-muted" : "text-ink"
        }`}
      >
        {prob}%
      </div>
      <div
        className={`mt-2 text-[13px] ${muted ? "text-muted" : "text-ink font-semibold"}`}
      >
        {quarter} &middot; {date}
      </div>
      {slip && (
        <div className="text-[11px] font-semibold text-danger mt-1">
          Slipped from rep forecast
        </div>
      )}
    </div>
  );
}

function Toast({ message }: { message: string }) {
  return (
    <div className="fixed bottom-6 right-6 bg-ink text-white px-4 py-3 rounded-xl2 shadow-cardHover text-[13px] font-semibold z-20">
      {message}
    </div>
  );
}

function formatMoney(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1000) return `$${Math.round(v / 1000)}K`;
  return `$${v}`;
}
