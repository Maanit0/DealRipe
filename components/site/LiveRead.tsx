"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The product's central claim, animated: buyer behavior lands, gates flip, and
 * the read moves off the rep's number with the reason attached.
 *
 * Runs only while on screen, and holds the finished state rather than resetting
 * to blank, so a reader arriving late sees the conclusion and not an empty
 * card. Reduced-motion goes straight to the final frame.
 */

type Signal = { at: string; text: string; gate: number };

const SIGNALS: Signal[] = [
  { at: "Aug 14", text: "Elena Ruiz, VP Operations, declined Thursday's working session", gate: 0 },
  { at: "Aug 19", text: "Two emails to Ray Delgado since the 12th, no reply", gate: 1 },
  { at: "Aug 26", text: "Call ended with no next meeting booked", gate: 2 },
];

const GATES = ["Economic buyer engaged", "Champion responsive", "Next step committed"];

export function LiveRead() {
  const ref = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(-1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setStep(SIGNALS.length + 1);
      return;
    }

    const timers: ReturnType<typeof setTimeout>[] = [];
    // Plays once and holds. Looping back to an empty card would mean a reader
    // who glances away returns to nothing, and the finished state is the part
    // worth reading.
    const run = () => {
      for (let i = 0; i <= SIGNALS.length + 2; i++) {
        timers.push(setTimeout(() => setStep(i), 500 + i * 900));
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          run();
          io.disconnect();
        }
      },
      { threshold: 0.25 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
    };
  }, []);

  const moved = step >= SIGNALS.length + 1;
  const acted = step >= SIGNALS.length + 2;

  return (
    <div
      ref={ref}
      className="overflow-hidden rounded-xl2 border border-line bg-white shadow-card"
    >
      <div className="flex flex-wrap items-baseline gap-3 bg-ink px-6 py-4 text-white">
        <span className="text-[16.5px] font-bold tracking-tight">Northwind Logistics</span>
        <span className="text-[13px] text-slate-400">$340K · Enterprise, west</span>
        <span className="ml-auto flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.1em] text-accent">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
          Watching
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.25fr_1fr]">
        {/* Signals arriving */}
        <div className="border-b border-line p-6 lg:border-b-0 lg:border-r">
          <div className="mb-4 text-[10px] font-extrabold uppercase tracking-[0.1em] text-muted">
            What the buyer did
          </div>
          <div className="space-y-2.5">
            {SIGNALS.map((s, i) => (
              <div
                key={s.text}
                className="flex items-start gap-3 transition-all duration-500"
                style={{
                  opacity: step >= i ? 1 : 0,
                  transform: step >= i ? "none" : "translateY(8px)",
                }}
              >
                <span className="mt-0.5 w-[52px] shrink-0 text-[11px] font-semibold tabular-nums text-muted">
                  {s.at}
                </span>
                <span className="text-[14.5px] leading-snug text-slate-800">{s.text}</span>
              </div>
            ))}
          </div>

          <div className="mt-6 space-y-1.5 border-t border-line pt-5">
            {GATES.map((g, i) => {
              const open = step >= i;
              return (
                <div key={g} className="flex items-center gap-2.5 text-[13px]">
                  <span
                    className="h-1.5 w-1.5 rounded-full transition-colors duration-500"
                    style={{ backgroundColor: open ? "#ef4444" : "#22c55e" }}
                  />
                  <span className={open ? "text-ink" : "text-muted"}>{g}</span>
                  <span
                    className="ml-auto text-[11px] font-bold uppercase tracking-wide transition-colors duration-500"
                    style={{ color: open ? "#ef4444" : "#22c55e" }}
                  >
                    {open ? "Open" : "Met"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* The two reads */}
        <div className="p-6">
          <div className="mb-4 text-[10px] font-extrabold uppercase tracking-[0.1em] text-muted">
            The read
          </div>

          <div className="flex items-start gap-8">
            <div>
              <div className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-muted">
                Rep
              </div>
              <div className="mt-1.5 text-[22px] font-bold tracking-tight text-ink">Commit</div>
              <div className="text-[12px] text-muted">Close Sep 30</div>
            </div>
            <div>
              <div className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-muted">
                DealRipe
              </div>
              <div
                className="mt-1.5 text-[22px] font-bold tracking-tight transition-all duration-700"
                style={{ color: moved ? "#ef4444" : "#0f172a" }}
              >
                {moved ? "Best case" : "Commit"}
              </div>
              <div className="text-[12px] text-muted transition-all duration-700">
                {moved ? "No date the buyer confirmed" : "Close Sep 30"}
              </div>
            </div>
          </div>

          <div
            className="mt-5 rounded-xl border border-danger/30 bg-dangerSoft/50 p-4 transition-all duration-700"
            style={{
              opacity: moved ? 1 : 0,
              transform: moved ? "none" : "translateY(10px)",
            }}
          >
            <div className="mb-1.5 text-[10px] font-extrabold uppercase tracking-[0.08em] text-danger">
              Why they differ
            </div>
            <p className="text-[13.5px] leading-snug text-slate-800">
              Elena signs anything over $250K and has not been on a call. The
              deal is single threaded on Ray, an ops manager.
            </p>
          </div>


        </div>
      </div>

      <div
        className="border-t border-line bg-accentSoft/40 px-6 py-5 transition-all duration-700"
        style={{
          opacity: acted ? 1 : 0,
          transform: acted ? "none" : "translateY(10px)",
        }}
      >
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <span className="text-[10px] font-extrabold uppercase tracking-[0.1em] text-emerald-800">
            The move
          </span>
          <span className="text-[12px] text-muted">
            Written and waiting in Ray&rsquo;s drafts. DealRipe never sends.
          </span>
        </div>

        <div className="max-w-[720px] overflow-hidden rounded-xl border border-line bg-white">
          <div className="border-b border-line px-4 py-2.5 text-[12.5px] text-muted">
            <span className="text-ink">To</span> elena.ruiz@northwind.com
            <span className="mx-2 text-line">|</span>
            <span className="text-ink">Cc</span> r.delgado@northwind.com
          </div>
          <div className="border-b border-line px-4 py-2.5 text-[13.5px] font-semibold text-ink">
            Thursday: 15 minutes on cost per shipment
          </div>
          <div className="px-4 py-3.5 text-[14px] leading-relaxed text-slate-800">
            Elena, Ray mentioned you own the call on spend at this size. Before
            Thursday I&rsquo;ve put together what the current process costs per
            shipment against what it would look like on our side, using the
            volumes Ray gave us in July.
            <br />
            <br />
            Would 15 minutes at the top of Thursday work? You&rsquo;ll have the
            number in front of you before we start.
          </div>
        </div>

        <p className="mt-3 max-w-[720px] text-[13px] leading-snug text-muted">
          Drafted the way your top reps open this one. Deals on this motion that
          reached proposal without the budget holder on a call closed 2 of the
          last 11.
        </p>
      </div>
    </div>
  );
}
