/**
 * What the team actually receives, as four columns.
 *
 * Each visual is a miniature of a real artifact rather than an icon, so the
 * column shows the thing itself and the copy underneath only has to name it.
 */

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[188px] items-center justify-center rounded-lg border border-line bg-bg p-4">
      {children}
    </div>
  );
}

function MiniBriefing() {
  return (
    <div className="w-full space-y-1.5">
      {[
        ["Since last call", "Finance joined the invite"],
        ["Unanswered", "Migration question, 9 days"],
        ["Land today", "A named security date"],
        ["Do not", "Price live on this call"],
      ].map(([k, v], i) => (
        <div key={k} className="rounded border border-line bg-white px-2.5 py-1.5">
          <div className="text-[7.5px] font-extrabold uppercase tracking-[0.08em] text-muted">
            {k}
          </div>
          <div
            className="mt-0.5 text-[10px] leading-tight"
            style={{ color: i === 3 ? "#B45309" : "#0F172A" }}
          >
            {v}
          </div>
        </div>
      ))}
    </div>
  );
}

function MiniDraft() {
  return (
    <div className="w-full overflow-hidden rounded border border-line bg-white">
      <div className="border-b border-line px-2.5 py-1.5 text-[8.5px] text-muted">
        To elena.ruiz@northwind.com
      </div>
      <div className="border-b border-line px-2.5 py-1.5 text-[9.5px] font-semibold text-ink">
        Thursday: 15 minutes on cost per shipment
      </div>
      <div className="space-y-1 px-2.5 py-2">
        {[100, 92, 78, 96, 54].map((w, i) => (
          <div key={i} className="h-[4px] rounded-full bg-line" style={{ width: `${w}%` }} />
        ))}
      </div>
      <div className="border-t border-line px-2.5 py-1.5 text-[8.5px] font-semibold text-emerald-700">
        Draft, waiting to send
      </div>
    </div>
  );
}

function MiniQuiet() {
  return (
    <div className="w-full space-y-2">
      <div className="rounded border border-line bg-white px-2.5 py-2">
        <div className="text-[8.5px] font-extrabold uppercase tracking-[0.07em] text-muted">
          Kestrel Freight
        </div>
        <div className="mt-1.5 flex items-center gap-1">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-[14px] flex-1 rounded-sm"
              style={{ backgroundColor: i < 2 ? "#22C55E" : "#E2E8F0" }}
            />
          ))}
        </div>
        <div className="mt-1.5 text-[9px] text-danger">Nothing since Aug 12</div>
      </div>
      <div className="rounded border border-accent/40 bg-accentSoft/60 px-2.5 py-2">
        <div className="text-[8.5px] font-extrabold uppercase tracking-[0.07em] text-emerald-800">
          Drafted without being asked
        </div>
        <div className="mt-1 space-y-1">
          {[96, 84, 62].map((w, i) => (
            <div key={i} className="h-[4px] rounded-full bg-accent/35" style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MiniDigest() {
  return (
    <div className="w-full space-y-1.5">
      {[
        ["Northwind Logistics", "$340K", "down"],
        ["Bellcastle Group", "$120K", "up"],
        ["Ardent Systems", "$95K", "flat"],
        ["Kestrel Freight", "$78K", "down"],
      ].map(([n, v, d]) => (
        <div
          key={n}
          className="flex items-center justify-between rounded border border-line bg-white px-2.5 py-[7px]"
        >
          <span className="text-[9.5px] font-semibold text-ink">{n}</span>
          <span className="flex items-center gap-1.5">
            <span className="text-[9px] text-muted">{v}</span>
            <span
              className="text-[10px] font-bold"
              style={{
                color: d === "down" ? "#EF4444" : d === "up" ? "#22C55E" : "#94A3B8",
              }}
            >
              {d === "down" ? "↓" : d === "up" ? "↑" : "="}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

const COLUMNS: {
  label: string;
  visual: React.ReactNode;
  verb: string;
  body: string;
}[] = [
  {
    label: "Before the call",
    visual: <MiniBriefing />,
    verb: "DealRipe preps the rep.",
    body: "The commitment to land, the questions that have worked on deals like this one, and the one thing not to do.",
  },
  {
    label: "After the call",
    visual: <MiniDraft />,
    verb: "DealRipe writes the follow-up.",
    body: "Written into the rep's own drafts, in their voice, carrying whatever was committed to on the call.",
  },
  {
    label: "When it goes quiet",
    visual: <MiniQuiet />,
    verb: "DealRipe re-opens the deal.",
    body: "Nothing triggered this. The deal simply went silent, and a way back in was written before anyone noticed it had.",
  },
  {
    label: "Monday morning",
    visual: <MiniDigest />,
    verb: "DealRipe runs your review.",
    body: "Your deals ranked by what needs you, each one carrying what changed this week and why.",
  },
];

const SYSTEMS = ["Salesforce", "Teams", "Zoom", "Meet", "Outlook", "Slack"];

export function Outputs() {
  return (
    <div>
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-16">
        <h2 className="text-[30px] font-semibold leading-[1.12] tracking-tight text-ink sm:text-[38px]">
          Everything the agent knows about that deal, delivered where each person
          already works.
        </h2>
        <div>
          <p className="text-[16.5px] leading-relaxed text-muted">
            DealRipe connects to what your team already runs: the calls, the
            inbox, the calendar, the CRM. It replaces none of it, and it writes
            back to your CRM without anyone typing.
          </p>
          <p className="mt-4 text-[16.5px] leading-relaxed text-muted">
            None of these are templates. Each one is written from that
            deal&rsquo;s own memory, and every claim in them points back to
            something the customer actually said or did. Nobody logs into
            anything.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-5">
            {SYSTEMS.map((s) => (
              <span
                key={s}
                className="rounded-md border border-line bg-white px-2.5 py-1.5 text-[12px] font-semibold text-muted"
              >
                {s}
              </span>
            ))}
            <span className="text-[12px] uppercase tracking-[0.08em] text-muted">
              plus whatever else you run
            </span>
          </div>
        </div>
      </div>

      <div className="mt-14 grid grid-cols-1 gap-x-10 gap-y-12 border-t border-line pt-12 sm:grid-cols-2 lg:grid-cols-4 lg:gap-x-0">
        {COLUMNS.map((c, i) => (
          <div
            key={c.label}
            className={`dr-item lg:px-7 ${i > 0 ? "lg:border-l lg:border-line" : ""} ${
              i === 0 ? "lg:pl-0" : ""
            } ${i === COLUMNS.length - 1 ? "lg:pr-0" : ""}`}
            style={{ transitionDelay: `${i * 100}ms` }}
          >
            <div className="mb-4 text-[11px] font-extrabold uppercase tracking-[0.1em] text-muted">
              {c.label}
            </div>
            <Panel>{c.visual}</Panel>
            <div className="mt-5 text-[17px] font-semibold leading-snug tracking-tight text-ink">
              {c.verb}
            </div>
            <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{c.body}</p>
          </div>
        ))}
      </div>

      <p className="mt-14 max-w-[760px] border-t border-line pt-8 text-[18px] leading-relaxed text-ink">
        Any tool can write a summary. What none of them hold is the deal&rsquo;s
        own history: who is on it, what was promised, what was never answered,
        and which moves have actually worked on deals like it before.
      </p>
    </div>
  );
}
