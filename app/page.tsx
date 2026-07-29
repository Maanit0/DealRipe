export default function LandingPage() {
  return (
    <div className="min-h-screen bg-bg font-sans text-ink antialiased">
      <header className="max-w-[1080px] mx-auto px-6 pt-9">
        <div className="flex items-center justify-between">
          <span className="text-[14px] font-semibold tracking-tight text-ink">
            DealRipe
          </span>
          <a
            href="https://calendly.com/maanitsharma21/dealripe-demo-with-maanit"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] font-semibold text-muted hover:text-ink transition"
          >
            Book a demo →
          </a>
        </div>
      </header>

      <main className="max-w-[1080px] mx-auto px-6">
        {/* Hero */}
        <section className="pt-20 pb-16 max-w-[880px]">
          <div className="text-[11px] uppercase tracking-wider font-bold text-muted mb-5">
            For mid-market B2B sales teams
          </div>
          <h1 className="text-[40px] sm:text-[56px] font-semibold tracking-tight leading-[1.04] text-ink">
            The decision layer your revenue team runs on.
          </h1>
          <p className="mt-6 text-[18px] leading-relaxed text-muted max-w-[720px]">
            DealRipe watches every customer signal, calls, email, and calendar,
            and turns them into a forecast your CRO can trust and the next move
            that wins each deal. Nobody logs in. Briefings, recaps, next steps,
            and CRM updates arrive in Slack and email, done for the rep.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <a
              href="https://calendly.com/maanitsharma21/dealripe-demo-with-maanit"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl2 bg-ink text-white text-[14px] font-semibold hover:bg-ink/90 transition"
            >
              Book a demo
              <span aria-hidden>→</span>
            </a>
            <span className="text-[13px] text-muted">
              Live in production today.
            </span>
          </div>
        </section>

        {/* Product preview: forecast vs commit */}
        <section className="pb-20">
          <div className="max-w-[720px] mx-auto">
            <ForecastPreview />
            <p className="mt-5 text-center text-[13px] text-muted leading-relaxed max-w-[560px] mx-auto">
              Every read comes from what the customer said on the calls, with
              their own words written back to your CRM as the evidence.
            </p>
          </div>
        </section>

        {/* The problem, in the leader's words */}
        <section className="py-20 border-t border-line">
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-3">
            The problem
          </div>
          <h2 className="text-[28px] sm:text-[32px] font-semibold tracking-tight text-ink leading-tight max-w-[720px]">
            You own the number. You don&rsquo;t own the inputs.
          </h2>
          <div className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-9">
            <Problem title="You can&rsquo;t tell the customer from the rep.">
              A rep says a deal is closing and your tools take it at face value.
              But what the customer actually said and what the rep heard are
              rarely the same thing.
            </Problem>
            <Problem title="Your pipeline is full of deals that aren&rsquo;t real.">
              It&rsquo;s month-end and half the deals dated to close won&rsquo;t.
              Everyone knows it, nobody updated them, and you strip them out by
              hand before you can trust your own number.
            </Problem>
            <Problem title="The flags never tell you what to do.">
              Every tool surfaces risk. None of them say get the economic buyer
              in the room before the proposal goes out. So the gap gets found
              too late, and the deal slips a quarter.
            </Problem>
            <Problem title="And if the forecast is wrong, it&rsquo;s on you.">
              Not the rep who over-committed. You. Accurate forecasting is the
              job, and today it rests on inputs you can&rsquo;t fully trust.
            </Problem>
          </div>
        </section>

        {/* How it works */}
        <section className="py-20 border-t border-line">
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-8">
            How it works
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-10">
            <Capability title="Sees every customer signal">
              DealRipe joins every call over Teams, Zoom, and Meet, and reads
              the email, calendar, and CRM activity around each deal. Every
              customer touch becomes a verified signal on the deal, written to
              your CRM with the evidence behind it.
            </Capability>
            <Capability title="Forecasts every deal">
              Each deal shows DealRipe&rsquo;s forecast beside the rep&rsquo;s
              commit, what is blocking it, and whether it is real. Your pipeline
              review runs on what the customer confirmed, not on rep optimism.
            </Capability>
            <Capability title="Prescribes the next move">
              For every deal and every rep, DealRipe turns those signals into
              the specific action that moves it: the briefing before the call,
              the case to make on it, and the follow-up after. It all arrives
              where they already work, so the whole team moves, not just the top
              reps.
            </Capability>
          </div>
        </section>

        {/* The move, in detail */}
        <section className="py-20 border-t border-line">
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-3">
            The move, made for them
          </div>
          <h2 className="text-[28px] sm:text-[32px] font-semibold tracking-tight text-ink leading-tight max-w-[720px]">
            Not a summary. The exact thing to do next.
          </h2>
          <div className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-9">
            <DepthItem title="Pre-call briefing">
              The exact commitment to get from the stakeholder in the room, and
              the top questions to ask, tuned to what your best reps asked at
              this stage on similar accounts and to your own win and loss
              history.
            </DepthItem>
            <DepthItem title="ROI narrative">
              The business case in the customer&rsquo;s own numbers, built from
              what they said on the calls and ready to bring to the next
              conversation.
            </DepthItem>
            <DepthItem title="Product-line match">
              Which of your products or lines fits the gaps the customer
              surfaced, so the rep pitches what actually solves their problem.
            </DepthItem>
            <DepthItem title="Post-call follow-up">
              The recap and the next email, drafted from what was said and the
              commitment that was made, ready for the rep to send.
            </DepthItem>
          </div>
        </section>

        {/* Who it's for */}
        <section className="py-20 border-t border-line">
          <div className="max-w-[760px]">
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-5">
              Who it&rsquo;s for
            </div>
            <p className="text-[19px] leading-relaxed text-ink">
              Built for mid-market B2B sales teams, 10 to 50 reps, on
              Salesforce, with no RevOps org to run heavier tools. The reps who
              will not open another platform still get every briefing, recap,
              and next step, because it comes to them.
            </p>
          </div>
        </section>

        {/* Under the hood: technical depth */}
        <section className="py-20 border-t border-line">
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-3">
            Under the hood
          </div>
          <h2 className="text-[28px] sm:text-[32px] font-semibold tracking-tight text-ink leading-tight max-w-[720px]">
            Not an LLM on a transcript. A system of record.
          </h2>
          <p className="mt-4 text-[15px] leading-relaxed text-muted max-w-[720px]">
            The decision layer sits on a durable, auditable data model built for
            CRO-grade trust, not a prompt library.
          </p>
          <div className="mt-10 grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-9">
            <DepthItem title="Framework as a data structure">
              SCOTSMAN, MEDDIC, or your own stage gates live as database rows,
              not a prompt. Each field carries the CRM object it writes to and
              the stage it gates. Adding a framework is config, not a rewrite.
            </DepthItem>
            <DepthItem title="Per-field evidence, kept honest">
              Every field DealRipe fills is stamped with its source call and the
              customer&rsquo;s verbatim quote. A confirmed field stays confirmed
              until a later call changes it, so a pipeline review six months out
              is reproducible.
            </DepthItem>
            <DepthItem title="Fail-closed CRM writes with a full audit log">
              Every read and write passes a hard allowlist enforced before the
              call runs, and every access lands in an audit log your security
              team can review. Tenants are isolated with row-level security.
            </DepthItem>
            <DepthItem title="A forecast that learns your business">
              Every deal is snapshotted daily, DealRipe&rsquo;s read against the
              rep&rsquo;s commit, and labeled at close. That history is the
              substrate the calibration model we are building next will train
              on, tuned to your own wins and losses.
            </DepthItem>
          </div>
        </section>

        {/* Pilot proof */}
        <section className="py-20 border-t border-line">
          <div className="max-w-[760px]">
            <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-5">
              Live pilot
            </div>
            <p className="text-[19px] leading-relaxed text-ink">
              DealRipe is running in production today on a mid-market B2B
              team&rsquo;s real deals. Their CRO runs his weekly pipeline review
              on DealRipe&rsquo;s forecast: every deal ranked with the read
              against the rep&rsquo;s commit, what is blocking it, and the move
              to make. Within a week of going live, the reps asked to put every
              deal they run on it.
            </p>
          </div>
        </section>

        {/* CTA */}
        <section className="py-24 border-t border-line text-center">
          <h2 className="text-[28px] sm:text-[32px] font-semibold tracking-tight text-ink leading-tight max-w-[640px] mx-auto">
            See it run on one of your deals.
          </h2>
          <p className="mt-4 text-[15px] text-muted leading-relaxed max-w-[520px] mx-auto">
            Bring a stalled deal from your pipeline and a recent call. We&rsquo;ll
            show you the forecast DealRipe reads, the evidence behind it, and the
            exact next move to unstick it.
          </p>
          <a
            href="https://calendly.com/maanitsharma21/dealripe-demo-with-maanit"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-8 inline-flex items-center gap-2 px-6 py-3.5 rounded-xl2 bg-accent text-white text-[15px] font-semibold hover:bg-accent/90 transition"
          >
            Book a demo
            <span aria-hidden>→</span>
          </a>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="max-w-[1080px] mx-auto px-6 py-8 flex flex-wrap items-center justify-between gap-4 text-[11px] text-muted">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold text-ink">DealRipe</span>
            <span>·</span>
            <span>Built by Maanit Sharma.</span>
            <a
              href="mailto:maanit@dealripe.com"
              className="hover:text-ink transition"
            >
              maanit@dealripe.com
            </a>
            <span>·</span>
            <a
              href="https://www.linkedin.com/in/maanitsharma"
              className="hover:text-ink transition"
            >
              LinkedIn
            </a>
          </div>
          <span>© 2026</span>
        </div>
      </footer>
    </div>
  );
}

function Capability({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[18px] font-semibold tracking-tight text-ink leading-snug">
        {title}
      </div>
      <p className="mt-2.5 text-[14.5px] leading-relaxed text-muted">
        {children}
      </p>
    </div>
  );
}

function DepthItem({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[15px] font-semibold tracking-tight text-ink leading-snug">
        {title}
      </div>
      <p className="mt-2 text-[14px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}

function Problem({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-l-2 border-danger/40 pl-4">
      <div className="text-[16px] font-semibold tracking-tight text-ink leading-snug">
        {title}
      </div>
      <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}

/**
 * Forecast preview. Mirrors the shape of the live deal page: the rep's forecast
 * category next to DealRipe's evidence-backed category, with the gates driving
 * the delta listed underneath and the prescribed next move at the bottom.
 * Categories, not raw percentages: mid-market teams forecast in Commit / Best
 * Case / Pipeline, and a category grounded in confirmed gates reads truer than
 * a manufactured probability.
 */
function ForecastPreview() {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-5 py-3.5 border-b border-line flex items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold tracking-tight text-ink">
            Northwind Logistics
          </div>
          <div className="text-[11px] text-muted mt-0.5">
            SQL4 · 41 days in stage
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[18px] font-bold tracking-tight text-ink leading-none">
            $340K
          </div>
          <div className="text-[10px] uppercase tracking-wider font-bold text-danger mt-1">
            3 open gates
          </div>
        </div>
      </div>

      {/* Forecast: rep commit vs DealRipe read */}
      <div className="px-5 py-4 border-b border-line grid grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted">
            Rep commit
          </div>
          <div className="mt-1 text-[22px] font-bold tracking-tight text-ink leading-none">
            Commit
          </div>
          <div className="text-[11px] text-muted mt-1">Close Q3</div>
        </div>
        <div className="border-l border-line pl-4">
          <div className="text-[10px] uppercase tracking-wider font-semibold text-accent">
            DealRipe read
          </div>
          <div className="mt-1 text-[22px] font-bold tracking-tight text-ink leading-none">
            Best Case
          </div>
          <div className="text-[11px] text-muted mt-1">
            4 of 7 SQL4 gates confirmed
          </div>
        </div>
      </div>

      {/* Why: the gates driving the delta */}
      <div className="px-5 py-4 space-y-3">
        <div className="text-[10px] uppercase tracking-wider font-bold text-muted">
          Why the delta
        </div>

        <GapRow
          fieldId="A1"
          question="Economic buyer engaged"
          detail="The VP of Operations owns the budget and has never joined a call."
        />

        <GapRow
          fieldId="T1"
          question="Close date confirmed by customer"
          detail="Rep says Q3. No customer has confirmed a date on any call."
        />

        <GapRow
          fieldId="C1"
          question="Competing vendor addressed"
          detail="A competitor was named on the last call and never handled."
        />

        <div className="pt-2 border-t border-line">
          <div className="text-[10px] uppercase tracking-wider font-bold text-accent mb-1.5">
            Next move
          </div>
          <div className="text-[13px] text-ink leading-snug">
            Get the VP of Operations, who owns the budget, into the room before
            the rep sends the proposal.
          </div>
        </div>
      </div>
    </div>
  );
}

function GapRow({
  fieldId,
  question,
  detail,
}: {
  fieldId: string;
  question: string;
  detail: string;
}) {
  return (
    <div className="flex gap-3 items-start rounded-md px-2 py-2 -mx-2 bg-danger/[0.04]">
      <span className="w-[18px] h-[18px] rounded-full bg-danger shrink-0 mt-0.5 flex items-center justify-center">
        <svg
          viewBox="0 0 16 16"
          className="w-2.5 h-2.5"
          fill="none"
          stroke="white"
          strokeWidth="3"
        >
          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
        </svg>
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-[10px] text-muted shrink-0 pt-0.5">
            {fieldId}
          </span>
          <span className="text-[13px] text-ink font-medium leading-snug">
            {question}
          </span>
        </div>
        <div className="mt-1.5 text-[12px] text-muted leading-snug">
          {detail}
        </div>
      </div>
    </div>
  );
}
