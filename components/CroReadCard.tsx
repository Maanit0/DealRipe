"use client";

import { useState } from "react";
import { saveCroRead } from "@/lib/cro-read-action";
import type { CroRead } from "@/lib/cro-read";

const CATEGORIES = ["Commit", "Expect", "Pipeline"] as const;
const EB = ["Yes", "No", "Not sure"] as const;

/**
 * "Mark's read" — the CRO's day-0 baseline for a deal. A small structured form
 * so each field lines up with something DealRipe surfaces later, making the
 * day-30 comparison clean. Reference only; nothing here drives the product.
 */
export function CroReadCard({
  dealId,
  initial,
}: {
  dealId: string;
  initial: CroRead | null;
}) {
  const [forecastCategory, setForecastCategory] = useState(initial?.forecastCategory ?? "");
  const [winProbability, setWinProbability] = useState(
    initial?.winProbability != null ? String(initial.winProbability) : "",
  );
  const [expectedClose, setExpectedClose] = useState(initial?.expectedClose ?? "");
  const [economicBuyerEngaged, setEconomicBuyerEngaged] = useState(
    initial?.economicBuyerEngaged ?? "",
  );
  const [biggestUnknown, setBiggestUnknown] = useState(initial?.biggestUnknown ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSave() {
    setStatus("saving");
    setError(null);
    const raw = winProbability.replace(/[^0-9.]/g, "");
    const prob = raw === "" ? null : Math.round(Number(raw));
    const res = await saveCroRead(dealId, {
      forecastCategory: forecastCategory || null,
      winProbability: prob != null && !Number.isNaN(prob) ? prob : null,
      expectedClose: expectedClose.trim() || null,
      economicBuyerEngaged: economicBuyerEngaged || null,
      biggestUnknown: biggestUnknown.trim() || null,
      notes: notes.trim() || null,
      updatedAt: null,
    });
    if (res.ok) {
      setStatus("saved");
      setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 2500);
    } else {
      setStatus("error");
      setError(res.error ?? "Save failed");
    }
  }

  const pill = (active: boolean) =>
    `text-[12px] font-semibold px-3 py-1.5 rounded-lg border transition ${
      active
        ? "bg-ink text-white border-ink"
        : "bg-white text-ink border-line hover:border-ink/30"
    }`;
  const inputCls =
    "w-full text-[13px] text-ink bg-white border border-line rounded-lg px-3 py-2 focus:outline-none focus:border-ink/40";
  const labelCls = "text-[11px] uppercase tracking-wider font-semibold text-muted";

  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold text-ink">Mark&rsquo;s read</h2>
          <p className="text-[12px] text-muted mt-0.5">
            Your gut call today. We hold it and compare against what DealRipe surfaces at day 30.
          </p>
        </div>
        {initial?.updatedAt && status === "idle" && (
          <span className="text-[11px] text-muted shrink-0">
            saved {new Date(initial.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <div className={labelCls}>Forecast category</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className={pill(forecastCategory === c)}
                onClick={() => setForecastCategory(forecastCategory === c ? "" : c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className={labelCls}>Win probability today</div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <input
              className={`${inputCls} w-24`}
              inputMode="numeric"
              placeholder="e.g. 90"
              value={winProbability}
              onChange={(e) => setWinProbability(e.target.value)}
            />
            <span className="text-[13px] text-muted">%</span>
          </div>
        </div>

        <div>
          <div className={labelCls}>Expected close</div>
          <input
            className={`${inputCls} mt-1.5`}
            placeholder="e.g. September 2026"
            value={expectedClose}
            onChange={(e) => setExpectedClose(e.target.value)}
          />
        </div>

        <div>
          <div className={labelCls}>Economic buyer engaged?</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {EB.map((c) => (
              <button
                key={c}
                type="button"
                className={pill(economicBuyerEngaged === c)}
                onClick={() => setEconomicBuyerEngaged(economicBuyerEngaged === c ? "" : c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className={labelCls}>The one thing you&rsquo;re least sure about</div>
        <textarea
          className={`${inputCls} mt-1.5 min-h-[64px] resize-y`}
          placeholder="Biggest risk or open question on this deal"
          value={biggestUnknown}
          onChange={(e) => setBiggestUnknown(e.target.value)}
        />
      </div>

      <div className="mt-4">
        <div className={labelCls}>Notes (optional)</div>
        <textarea
          className={`${inputCls} mt-1.5 min-h-[56px] resize-y`}
          placeholder="Anything else worth capturing"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={status === "saving"}
          className="px-4 py-2 rounded-xl2 bg-ink text-white text-[13px] font-semibold hover:bg-ink/90 transition disabled:opacity-60"
        >
          {status === "saving" ? "Saving..." : "Save my read"}
        </button>
        {status === "saved" && <span className="text-[12px] text-accent font-medium">Saved ✓</span>}
        {status === "error" && (
          <span className="text-[12px] text-danger">{error ?? "Save failed"}</span>
        )}
      </div>
    </div>
  );
}
