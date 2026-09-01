/**
 * What one week produces, as numbers.
 *
 * Deliberately product output rather than claimed business result: these are
 * things DealRipe counted, not a revenue lift attributed to it. A lift claim
 * needs a measured baseline, and inviting "how did you measure that" is the
 * fastest way to lose a sceptical CRO.
 */

const STATS: [string, string, string][] = [
  ["7", "Deals", "where DealRipe's read differs from the rep's"],
  ["$1.4M", "Pipeline", "sitting behind those seven reads"],
  ["11", "Risks", "surfaced before anyone on the team flagged them"],
  ["9", "Moves", "drafted and waiting in a rep's drafts"],
  ["0", "Fields", "anyone had to type"],
];

export function WeekInNumbers() {
  return (
    <div className="rounded-xl2 bg-ink px-8 py-12 sm:px-12">
      <div className="text-[12px] font-extrabold uppercase tracking-[0.1em] text-accent">
        One week, one team
      </div>
      <h2 className="mt-4 max-w-[720px] text-[30px] font-semibold leading-[1.12] tracking-tight text-white sm:text-[36px]">
        You start Monday already knowing where the number is wrong.
      </h2>

      <div className="mt-12 grid grid-cols-2 gap-x-8 gap-y-10 lg:grid-cols-5">
        {STATS.map(([n, k, d], i) => (
          <div key={k} className="dr-item" style={{ transitionDelay: `${i * 90}ms` }}>
            <div className="text-[40px] font-bold leading-none tracking-tight text-white sm:text-[46px]">
              {n}
            </div>
            <div className="mt-3 text-[13px] font-bold uppercase tracking-[0.07em] text-accent">
              {k}
            </div>
            <div className="mt-1.5 text-[13.5px] leading-snug text-slate-400">{d}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
