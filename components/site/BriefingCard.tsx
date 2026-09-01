/**
 * What the rep gets before the call. The point of showing it rather than
 * describing it is the specificity: a named commitment to land, a named thing
 * not to do, and the reason behind each one.
 *
 * Company names here are illustrative. Nothing on this page comes from a real
 * customer's deal.
 */

type Row = {
  label: string;
  body: React.ReactNode;
  quote?: string;
  warn?: boolean;
};

// Kept short on purpose. This is a visual inside a scrolling section, so it has
// to be recognisable at a glance rather than read line by line.
const ROWS: Row[] = [
  {
    label: "Since last call",
    body: (
      <>
        Their VP of Operations accepted. <b>First time anyone who can sign has
        been in the room.</b>
      </>
    ),
  },
  {
    label: "Unanswered",
    warn: true,
    body: <>Their migration question is nine days old.</>,
  },
  {
    label: "Land today",
    body: <>A named date for the security review.</>,
  },
  {
    label: "Do not",
    warn: true,
    body: (
      <>
        Do not price live. Four deals took that path last quarter and none
        closed.
      </>
    ),
  },
  {
    label: "Still open",
    body: <>The SOC 2 report you promised. Draft is written and waiting.</>,
  },
];

export function BriefingCard() {
  return (
    <div className="overflow-hidden rounded-xl2 border border-line bg-white shadow-card">
      <div className="flex flex-wrap items-baseline gap-3 bg-ink px-6 py-3.5 text-white">
        <span className="text-[16.5px] font-bold tracking-tight">
          Second call, technical evaluation
        </span>
        <span className="ml-auto text-[13px] text-slate-400">
          Sent 30 minutes before
        </span>
      </div>
      {ROWS.map((r, i) => (
        <div
          key={r.label}
          style={{ transitionDelay: `${140 + i * 90}ms` }}
          className={`dr-item grid grid-cols-1 gap-2 border-b border-line/70 px-6 py-4 last:border-b-0 sm:grid-cols-[140px_1fr] sm:gap-6 ${
            r.warn ? "bg-warnSoft/40" : ""
          }`}
        >
          <div
            className={`pt-0.5 text-[11.5px] font-extrabold uppercase tracking-[0.07em] ${
              r.warn ? "text-amber-700" : "text-muted"
            }`}
          >
            {r.label}
          </div>
          <div className="text-[16px] leading-relaxed text-slate-800">
            {r.body}
            {r.quote && (
              <span className="mt-2 block border-l-2 border-accent/40 pl-3.5 text-[15.5px] text-slate-700">
                {r.quote}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
