/**
 * The four pains as rows, each with a small artifact rather than an icon.
 *
 * Every artifact is a literal picture of the pain it sits beside: struck-out
 * rows for the deals removed by hand, a blank where the reason should be, a
 * timeline where the signer arrives too late. Decoration would add noise to
 * writing that is already carrying the section.
 */

function CrmVsBuyer() {
  return (
    <div className="w-full max-w-[380px] space-y-2.5">
      <div className="rounded-lg border border-line bg-white px-4 py-3">
        <div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-muted">
          What the CRM says
        </div>
        <div className="mt-1 text-[15px] font-semibold text-muted">Commit, closing Sep 30</div>
      </div>
      <div className="rounded-lg border border-danger/35 bg-dangerSoft/40 px-4 py-3">
        <div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-danger">
          What the buyer did
        </div>
        <div className="mt-1 text-[15px] font-semibold text-ink">
          Declined the working session. No reply in 9 days.
        </div>
      </div>
    </div>
  );
}

function StruckPipeline() {
  // 15 rows standing in for 45; the two-in-three ratio is what matters.
  return (
    <div className="w-full max-w-[380px]">
      <div className="rounded-lg border border-line bg-white p-4">
        <div className="space-y-[5px]">
          {Array.from({ length: 15 }, (_, i) => {
            const dead = i % 3 !== 0;
            return (
              <div key={i} className="flex items-center gap-2">
                <div
                  className="h-[7px] flex-1 rounded-full"
                  style={{ backgroundColor: dead ? "#E2E8F0" : "#22C55E" }}
                />
                {dead && <div className="h-px w-full flex-1 -ml-[100%] bg-danger/50" />}
              </div>
            );
          })}
        </div>
      </div>
      <div className="mt-2.5 flex justify-between text-[12px] text-muted">
        <span>45 dated to close</span>
        <span className="font-semibold text-ink">15 you would stand behind</span>
      </div>
    </div>
  );
}

function MissingWhy() {
  return (
    <div className="w-full max-w-[380px] space-y-2.5">
      <div className="rounded-lg border border-line bg-white px-4 py-3">
        <div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-muted">
          Quarter, last 48 hours
        </div>
        <div className="mt-1 text-[26px] font-bold tracking-tight text-danger">
          &minus;$340K
        </div>
      </div>
      <div className="rounded-lg border border-dashed border-line bg-white px-4 py-3">
        <div className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-muted">
          Why
        </div>
        <div className="mt-1 text-[15px] text-muted">Not recorded anywhere</div>
      </div>
    </div>
  );
}

function LateSigner() {
  // Four equal columns rather than absolute positions: the labels then occupy
  // real space, so nothing can print through them, and no label can overflow
  // the container at either end.
  const marks = [
    { label: "Champion", week: "Week 1", bad: false },
    { label: "Demo", week: "Week 3", bad: false },
    { label: "Proposal", week: "Week 6", bad: false },
    { label: "Signer appears", week: "Week 9", bad: true },
  ];
  return (
    <div className="relative w-full max-w-[380px]">
      <div className="absolute left-[12.5%] right-[12.5%] top-[5px] h-[2px] rounded bg-line" />
      <div className="relative flex">
        {marks.map((m) => (
          <div key={m.label} className="flex flex-1 flex-col items-center text-center">
            <div
              className="h-3 w-3 rounded-full"
              style={{ backgroundColor: m.bad ? "#EF4444" : "#CBD5E1" }}
            />
            <div
              className="mt-2.5 text-[12px] font-semibold leading-tight"
              style={{ color: m.bad ? "#EF4444" : "#0F172A" }}
            >
              {m.label}
            </div>
            <div className="mt-0.5 text-[11px] leading-tight text-muted">{m.week}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const PAINS: { title: string; body: React.ReactNode; art: React.ReactNode }[] = [
  {
    title: "You don't see what the customer did. You see the rep's interpretation.",
    body: (
      <>
        The rep says it is closing this month. The economic buyer declined the
        last two invites, the champion has not replied in nine days, and no next
        meeting is booked. Only the rep&rsquo;s version reaches your CRM.
      </>
    ),
    art: <CrmVsBuyer />,
  },
  {
    title: "The forecast is corrected by hand, continuously.",
    body: (
      <>
        It is the 28th. Your CRM says forty-five deals close on the 31st. You will
        forecast fifteen. Removing the other thirty is your job, done from memory,
        one deal at a time, and it is the same job again next month.
      </>
    ),
    art: <StruckPipeline />,
  },
  {
    title: "The number is already committed. Then it moves, and nothing tells you why.",
    body: (
      <>
        A rep pushed a deal to Q4 to keep his Q3 clean. His VP still believes it
        lands in Q3. The number you already gave upward included it, and the
        dashboard showed only that the quarter softened.
      </>
    ),
    art: <MissingWhy />,
  },
  {
    title: "You find out in week nine that you were selling to someone who cannot buy.",
    body: (
      <>
        A VP everyone assumed could sign. A champion who was never the
        decision-maker. Legal and procurement arriving at the finish line. The
        deal was never qualified, and nothing in the pipeline said so.
      </>
    ),
    art: <LateSigner />,
  },
];

export function Pains() {
  return (
    <div className="border-t border-line">
      {PAINS.map((p, i) => (
        <div
          key={p.title}
          className="dr-item grid grid-cols-1 items-center gap-8 border-b border-line py-10 lg:grid-cols-[1fr_380px] lg:gap-16"
          style={{ transitionDelay: `${i * 90}ms` }}
        >
          <div>
            <div className="max-w-[560px] text-[21px] font-semibold leading-snug tracking-tight text-ink">
              {p.title}
            </div>
            <p className="mt-3 max-w-[560px] text-[16px] leading-relaxed text-muted">{p.body}</p>
          </div>
          <div className="flex justify-start lg:justify-end">{p.art}</div>
        </div>
      ))}
    </div>
  );
}
