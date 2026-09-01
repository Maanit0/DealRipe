/**
 * The leader's view: the rep's read, DealRipe's read, and the reason they
 * differ. The reason column is the product, so it gets the most width.
 *
 * Company names are illustrative.
 */

type Deal = {
  name: string;
  segment: string;
  value: string;
  rep: string;
  repNote?: string;
  read: string;
  dir: "down" | "up" | "same";
  basis: string;
  why: React.ReactNode;
};

const DEALS: Deal[] = [
  {
    name: "Northwind Logistics",
    segment: "Enterprise, west",
    value: "$340K",
    rep: "Commit",
    repNote: "Close Sep 30",
    read: "Best case",
    dir: "down",
    basis: "Buyer behavior",
    why: (
      <>
        The person who signs at this size declined the last two sessions.{" "}
        <em>Single threaded on an ops manager.</em>
      </>
    ),
  },
  {
    name: "Bellcastle Group",
    segment: "Mid-market, southeast",
    value: "$120K",
    rep: "Best case",
    repNote: "Close Oct 15",
    read: "Commit",
    dir: "up",
    basis: "Buyer behavior",
    why: (
      <>
        CFO joined the last two calls and asked for a multi-year quote.{" "}
        <em>That has preceded a signature nine times in eleven.</em>
      </>
    ),
  },
  {
    name: "Ardent Systems",
    segment: "Enterprise, northeast",
    value: "$95K",
    rep: "Commit",
    repNote: "Close Sep 12",
    read: "Commit",
    dir: "same",
    basis: "Confirmed",
    why: <>PO issued Aug 7 and read back on the call.</>,
  },
];

const COLS = "grid-cols-[1.35fr_.55fr_.8fr_.8fr_.4fr_3fr]";

function Arrow({ dir }: { dir: Deal["dir"] }) {
  return (
    <span
      className="text-[13px] font-extrabold"
      style={{
        color: dir === "down" ? "#EF4444" : dir === "up" ? "#22C55E" : "#94A3B8",
      }}
      aria-label={dir}
    >
      {dir === "down" ? "\u2193" : dir === "up" ? "\u2191" : "="}
    </span>
  );
}

export function ForecastRoom() {
  return (
    <>
      {/* Phones: a card per deal. The desktop table needs 860px and a sideways
          scroller is a poor way to read a comparison. */}
      <div className="space-y-4 lg:hidden">
        {DEALS.map((d, i) => (
          <div
            key={d.name}
            className="dr-item overflow-hidden rounded-xl2 border border-line bg-white"
            style={{ transitionDelay: `${160 + i * 110}ms` }}
          >
            <div className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
              <div>
                <div className="text-[15px] font-bold tracking-tight text-ink">{d.name}</div>
                <div className="mt-0.5 text-[12px] text-muted">{d.segment}</div>
              </div>
              <div className="text-[15px] font-bold text-ink">{d.value}</div>
            </div>
            <div className="flex items-center gap-6 border-b border-line px-4 py-3">
              <div>
                <div className="text-[10px] font-extrabold uppercase tracking-[0.07em] text-muted">
                  Rep read
                </div>
                <div className="mt-0.5 text-[15px] font-bold text-ink">{d.rep}</div>
                <div className="text-[12px] text-muted">{d.repNote}</div>
              </div>
              <Arrow dir={d.dir} />
              <div>
                <div className="text-[10px] font-extrabold uppercase tracking-[0.07em] text-muted">
                  DealRipe read
                </div>
                <div className="mt-0.5 text-[15px] font-bold text-ink">{d.read}</div>
              </div>
            </div>
            <div className="px-4 py-3.5">
              <div className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.07em] text-muted">
                {d.basis}
              </div>
              <div className="text-[14px] leading-relaxed text-slate-700 [&_em]:font-bold [&_em]:not-italic [&_em]:text-ink">
                {d.why}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="hidden lg:block">
        <div className="overflow-hidden rounded-xl2 border border-line bg-white">
          <div
            className={`grid ${COLS} gap-3.5 border-b border-line bg-bg py-2.5 text-[9.5px] font-extrabold uppercase tracking-[0.07em] text-muted`}
            style={{ paddingLeft: 18, paddingRight: 18 }}
          >
            <span>Deal</span>
            <span>Value</span>
            <span>Rep read</span>
            <span>DealRipe read</span>
            <span />
            <span>Why they differ</span>
          </div>
          {DEALS.map((d, i) => (
            <div
              key={d.name}
              className={`dr-item grid ${COLS} items-start gap-3.5 border-b border-line/70 py-3 text-[12.5px] last:border-b-0`}
              style={{ paddingLeft: 18, paddingRight: 18, transitionDelay: `${160 + i * 110}ms` }}
            >
              <div>
                <div className="text-[13px] font-bold leading-tight tracking-tight text-ink">
                  {d.name}
                </div>
                <div className="mt-0.5 text-[11px] text-muted">{d.segment}</div>
              </div>
              <div className="text-[13px] font-bold text-ink">{d.value}</div>
              <div className="leading-tight text-muted">
                <b className="block font-bold text-ink">{d.rep}</b>
                {d.repNote}
              </div>
              <div className="leading-tight text-muted">
                <b className="block font-bold text-ink">{d.read}</b>
              </div>
              <Arrow dir={d.dir} />
              <div className="text-[12px] leading-relaxed text-slate-700 [&_em]:font-bold [&_em]:not-italic [&_em]:text-ink">
                <span className="mb-1 block text-[9.5px] font-extrabold uppercase tracking-[0.06em] text-muted">
                  {d.basis}
                </span>
                {d.why}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
