/**
 * The two architectures as a three-row comparison rather than two bullet lists.
 *
 * The argument is one idea, so it does not need eight sentences. Three rows,
 * read left to right, carry it: what it reads, what it remembers, and how it
 * reaches you.
 */

const ROWS: [string, string, string][] = [
  ["Reads", "What the rep entered", "What the customer did"],
  ["Remembers", "Nothing that belongs to one deal", "The full history of its own deal"],
  ["Reaches you", "When you log in and ask", "Before the next call, unprompted"],
];

export function Compare() {
  return (
    <>
      {/* Phones: one block per dimension, both sides stacked. A 680px table
          inside a horizontal scroller is worse than no table. */}
      <div className="space-y-4 md:hidden">
        {ROWS.map(([label, them, us], i) => (
          <div
            key={label}
            className="dr-item overflow-hidden rounded-xl2 border border-line bg-white"
            style={{ transitionDelay: `${i * 90}ms` }}
          >
            <div className="border-b border-line px-4 py-2.5 text-[11px] font-extrabold uppercase tracking-[0.07em] text-muted">
              {label}
            </div>
            <div className="border-b border-line bg-dangerSoft/30 px-4 py-3.5">
              <div className="text-[10px] font-extrabold uppercase tracking-[0.07em] text-danger">
                One AI layer
              </div>
              <div className="mt-1 text-[15.5px] leading-snug text-muted">{them}</div>
            </div>
            <div className="bg-accentSoft/40 px-4 py-3.5">
              <div className="text-[10px] font-extrabold uppercase tracking-[0.07em] text-emerald-700">
                One agent per deal
              </div>
              <div className="mt-1 text-[15.5px] font-medium leading-snug text-ink">{us}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden md:block">
        <div className="overflow-hidden rounded-xl2 border border-line bg-white">
          <div className="grid grid-cols-[132px_1fr_1fr] border-b border-line">
            <div />
            <div className="border-l border-line bg-dangerSoft/50 px-6 py-4 text-[15px] font-bold tracking-tight text-ink">
              One AI layer, every deal
            </div>
            <div className="border-l border-line bg-accentSoft/60 px-6 py-4 text-[15px] font-bold tracking-tight text-ink">
              One agent per deal
            </div>
          </div>
          {ROWS.map(([label, them, us], i) => (
            <div
              key={label}
              className={`dr-item grid grid-cols-[132px_1fr_1fr] ${
                i < ROWS.length - 1 ? "border-b border-line" : ""
              }`}
              style={{ transitionDelay: `${140 + i * 110}ms` }}
            >
              <div className="px-6 py-5 text-[12px] font-extrabold uppercase tracking-[0.07em] text-muted">
                {label}
              </div>
              <div className="border-l border-line bg-dangerSoft/30 px-6 py-5 text-[16px] leading-snug text-muted">
                {them}
              </div>
              <div className="border-l border-line bg-accentSoft/40 px-6 py-5 text-[16px] font-medium leading-snug text-ink">
                {us}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
