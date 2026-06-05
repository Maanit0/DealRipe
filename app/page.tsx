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
        <section className="pt-20 pb-16 max-w-[840px]">
          <h1 className="text-[40px] sm:text-[56px] font-semibold tracking-tight leading-[1.04] text-ink">
            The deal inspection layer for B2B sales teams.
          </h1>
          <p className="mt-6 text-[18px] leading-relaxed text-muted max-w-[700px]">
            DealRipe audits every active deal against your qualification
            framework, tells reps the exact questions to ask before each call,
            and writes the customer&rsquo;s verbatim answers back to your CRM.
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
          </div>
        </section>

        {/* Product preview */}
        <section className="pb-20">
          <div className="max-w-[720px] mx-auto">
            <ProductPreview />
            <p className="mt-5 text-center text-[13px] text-muted leading-relaxed max-w-[560px] mx-auto">
              Every field on every deal, scored against your framework, with the
              customer&rsquo;s own words attached.
            </p>
          </div>
        </section>

        {/* How it works */}
        <section className="py-20 border-t border-line">
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-8">
            How it works
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 md:gap-10">
            <Capability title="Audit">
              Every active deal scored against your team&rsquo;s framework:
              SCOTSMAN, MEDDIC, MEDDPICC, or custom. Surfaces what is missing:
              budget unconfirmed, economic buyer unidentified, procurement
              timeline unmapped.
            </Capability>
            <Capability title="Prepare">
              Before every call, the rep gets the three situational questions
              to ask on this specific deal to close the gaps.
            </Capability>
            <Capability title="Extract">
              After the call, DealRipe pulls the answers from the transcript
              and writes them back to the CRM with the customer&rsquo;s
              verbatim quote as evidence.
            </Capability>
          </div>
        </section>

        {/* CTA */}
        <section className="py-24 border-t border-line text-center">
          <h2 className="text-[28px] sm:text-[32px] font-semibold tracking-tight text-ink leading-tight max-w-[640px] mx-auto">
            See it run on a real deal.
          </h2>
          <p className="mt-4 text-[15px] text-muted leading-relaxed max-w-[520px] mx-auto">
            The product is live and runs end-to-end. Book a walkthrough and
            we&rsquo;ll run it on a deal from your world.
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
            {/* TODO: confirm contact email */}
            <a
              href="mailto:maanit@dealripe.com"
              className="hover:text-ink transition"
            >
              maanit@dealripe.com
            </a>
            <span>·</span>
            {/* TODO: confirm LinkedIn URL */}
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

/**
 * Inline product preview that mirrors the real OpportunityControlSheet
 * styling. Three rows: confirmed (with verbatim quote), gap (with the SPIN
 * follow-up), and a newly-promoted field (with the NEW marker). The same
 * design language as the live product.
 */
function ProductPreview() {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
      <div className="px-5 py-3.5 border-b border-line flex items-start justify-between gap-3">
        <div>
          <div className="text-[14px] font-semibold tracking-tight text-ink">
            Lumora Marketplace
          </div>
          <div className="text-[11px] text-muted mt-0.5">
            Validation · 23 days in stage
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[18px] font-bold tracking-tight text-ink leading-none">
            $340K
          </div>
          <div className="text-[10px] uppercase tracking-wider font-bold text-danger mt-1">
            2 gaps
          </div>
        </div>
      </div>

      <div className="px-5 py-4 space-y-3">
        {/* Confirmed (Yes) with verbatim evidence */}
        <PreviewRow
          status="yes"
          fieldId="T1"
          question="Are we aware of their timescales?"
          body={
            <span className="italic">
              &ldquo;We need to monetize peak Q4 or we&rsquo;re waiting another
              year.&rdquo;
            </span>
          }
        />

        {/* Gap (No) with SPIN follow-up */}
        <PreviewRow
          status="no"
          fieldId="M1"
          question="Is a target budget defined?"
          body={
            <span>
              <span className="text-[9px] uppercase tracking-wider font-semibold mr-1.5 align-baseline">
                Ask
              </span>
              Has this spend already been budgeted, or would it need to be
              approved as a new line item?
            </span>
          }
        />

        {/* Newly confirmed (Yes + NEW) */}
        <PreviewRow
          status="yes"
          isNew
          fieldId="T2"
          question="Is the timescale defined?"
          body={
            <span className="italic">
              &ldquo;Mid-June feels doable. We&rsquo;d need to move on this in
              the next four to six weeks.&rdquo;
            </span>
          }
        />
      </div>
    </div>
  );
}

function PreviewRow({
  status,
  fieldId,
  question,
  body,
  isNew,
}: {
  status: "yes" | "no";
  fieldId: string;
  question: string;
  body: React.ReactNode;
  isNew?: boolean;
}) {
  const rowBg = isNew
    ? "bg-accent/[0.06] border-l-2 border-accent"
    : status === "no"
      ? "bg-danger/[0.04]"
      : "bg-transparent";

  return (
    <div className={`flex gap-3 items-start rounded-md px-2 py-2 -mx-2 ${rowBg}`}>
      <StatusDot status={status} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-mono text-[10px] text-muted shrink-0 pt-0.5">
            {fieldId}
          </span>
          {isNew && (
            <span className="font-mono text-[9px] uppercase tracking-wider font-bold text-accent px-1 py-[1px] rounded bg-accent/10">
              New
            </span>
          )}
          <span className="text-[13px] text-ink font-medium leading-snug">
            {question}
          </span>
        </div>
        <div className="mt-1.5 text-[12px] text-muted leading-snug">
          {body}
        </div>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: "yes" | "no" }) {
  if (status === "yes") {
    return (
      <span className="w-[18px] h-[18px] rounded-full bg-accent shrink-0 mt-0.5 flex items-center justify-center">
        <svg
          viewBox="0 0 16 16"
          className="w-2.5 h-2.5"
          fill="none"
          stroke="white"
          strokeWidth="3"
        >
          <path
            d="M3 8l3.5 3.5L13 5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }
  return (
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
  );
}
