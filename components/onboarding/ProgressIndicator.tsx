const STEPS = [
  { n: 1 as const, label: "Connect" },
  { n: 2 as const, label: "Framework" },
  { n: 3 as const, label: "Team" },
  { n: 4 as const, label: "Deals" },
];

export function ProgressIndicator({ step }: { step: 1 | 2 | 3 | 4 }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {STEPS.map((s, i) => {
        const past = s.n < step;
        const current = s.n === step;
        return (
          <div key={s.n} className="flex items-center gap-2">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-bold ${
                past
                  ? "bg-accent text-white"
                  : current
                    ? "bg-ink text-white"
                    : "bg-white border border-line text-muted"
              }`}
            >
              {past ? (
                <svg viewBox="0 0 16 16" className="w-3 h-3" fill="none" stroke="white" strokeWidth="3">
                  <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                s.n
              )}
            </div>
            <span
              className={`text-[12px] font-semibold ${current ? "text-ink" : "text-muted"}`}
            >
              {s.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="w-6 border-t border-line" aria-hidden />
            )}
          </div>
        );
      })}
    </div>
  );
}
