"use client";

import { useEffect, useRef, useState } from "react";
import { SwarmGrid } from "./SwarmGrid";
import { BriefingCard } from "./BriefingCard";
import { ForecastRoom } from "./ForecastRoom";

/**
 * Scroll-linked stepper. The section is taller than the viewport and its inner
 * panel is sticky, so scrolling advances the active step rather than moving the
 * page. The left column lists the steps and the right shows the matching
 * surface.
 *
 * Falls back to a plain stacked list when JS is off or reduced motion is set:
 * the sticky behaviour is an enhancement, never the only way to read it.
 */

const STEPS: { name: string; body: string }[] = [
  {
    name: "Watch",
    body: "Every open opportunity gets its own agent. It reads the calls, the email and the calendar activity on that deal, and nothing else.",
  },
  {
    name: "Read",
    body: "It builds its own read from what the buyer actually did, and shows it next to the rep's with the evidence for the gap.",
  },
  {
    name: "Prescribe",
    body: "The rep gets the next move before the call. The commitment to land, the questions that have worked, and the one thing not to do.",
  },
  {
    name: "Learn",
    body: "Every action and what followed it is recorded, so the moves your best reps make become the moves every rep gets.",
  },
];

function Visual({ i }: { i: number }) {
  if (i === 0)
    return (
      <div className="flex flex-col items-center">
        <SwarmGrid />
        <p className="mt-5 max-w-[340px] text-center text-[13.5px] leading-snug text-muted">
          One agent per deal, each holding the full history of its own deal.
        </p>
      </div>
    );
  if (i === 1) return <div className="w-full scale-[0.86]"><ForecastRoom /></div>;
  if (i === 2) return <div className="w-full scale-[0.82]"><BriefingCard /></div>;
  return (
    <div className="w-full max-w-[460px]">
      <div className="rounded-xl2 border border-line bg-white p-6">
        {[
          ["What DealRipe told the rep to do", "prescribed"],
          ["Whether the rep did it", "observed"],
          ["What the buyer did next", "measured"],
          ["How the deal ended", "recorded"],
        ].map(([t, tag]) => (
          <div
            key={t}
            className="flex items-baseline justify-between gap-4 border-b border-line py-3 last:border-b-0"
          >
            <span className="text-[15px] text-ink">{t}</span>
            <span className="text-[10.5px] font-extrabold uppercase tracking-[0.08em] text-accent">
              {tag}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-dashed border-accent bg-accentSoft px-3 py-2.5 text-[12.5px] font-bold text-emerald-800">
        <span aria-hidden>&#8635;</span> Fed back into every agent
      </div>
    </div>
  );
}

export function HowItWorks() {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [sticky, setSticky] = useState(false);

  useEffect(() => {
    // Below lg the two columns stack, and a stacked list plus a visual does
    // not fit in one viewport, so the pinned version is desktop-only.
    const enabled =
      window.innerWidth >= 1024 &&
      !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!enabled) return;
    setSticky(true);

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const scrollable = el.offsetHeight - window.innerHeight;
        if (scrollable <= 0) return;
        const progress = Math.min(Math.max(-rect.top / scrollable, 0), 0.999);
        setActive(Math.floor(progress * STEPS.length));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  if (!sticky) {
    return (
      <div className="space-y-14">
        {STEPS.map((s, i) => (
          <div key={s.name} className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,380px)_1fr]">
            <div>
              <div className="text-[22px] font-semibold tracking-tight text-ink">{s.name}</div>
              <p className="mt-2 text-[16px] leading-relaxed text-muted">{s.body}</p>
            </div>
            <div className="flex items-center justify-center">
              <Visual i={i} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div ref={ref} style={{ height: `${STEPS.length * 100}vh` }} className="relative">
      <div className="sticky top-0 flex h-screen items-center">
        <div className="grid w-full grid-cols-1 gap-10 lg:grid-cols-[minmax(0,360px)_1fr] lg:gap-16">
          <div className="border-t border-line">
            {STEPS.map((s, i) => (
              <button
                key={s.name}
                type="button"
                onClick={() => {
                  const el = ref.current;
                  if (!el) return;
                  const scrollable = el.offsetHeight - window.innerHeight;
                  window.scrollTo({
                    top: el.offsetTop + (scrollable * (i + 0.35)) / STEPS.length,
                    behavior: "smooth",
                  });
                }}
                className="block w-full border-b border-line py-5 text-left"
              >
                <div
                  className="text-[21px] font-semibold tracking-tight transition-colors duration-300"
                  style={{ color: active === i ? "#047857" : "#0F172A" }}
                >
                  {s.name}
                </div>
                <p
                  className="mt-1.5 text-[15px] leading-snug transition-opacity duration-300"
                  style={{ opacity: active === i ? 1 : 0.42, color: "#334155" }}
                >
                  {s.body}
                </p>
              </button>
            ))}
          </div>

          <div className="relative flex min-h-[420px] items-center justify-center">
            {STEPS.map((_, i) => (
              <div
                key={i}
                aria-hidden={active !== i}
                className="absolute inset-0 flex items-center justify-center transition-all duration-500"
                style={{
                  opacity: active === i ? 1 : 0,
                  transform: active === i ? "none" : "translateY(14px)",
                  pointerEvents: active === i ? "auto" : "none",
                }}
              >
                <Visual i={i} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
