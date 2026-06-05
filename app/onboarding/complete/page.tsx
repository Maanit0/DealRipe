import Link from "next/link";

export default function CompletePage() {
  return (
    <div className="min-h-screen bg-bg font-sans text-ink antialiased flex flex-col">
      <header className="border-b border-line bg-white">
        <div className="max-w-[1080px] mx-auto px-6 py-4 flex items-center justify-between">
          <Link
            href="/"
            className="text-[14px] font-semibold tracking-tight text-ink hover:opacity-80 transition"
          >
            DealRipe
          </Link>
          <Link
            href="/pipeline"
            className="text-[12px] font-semibold text-muted hover:text-ink transition"
          >
            Skip to demo
          </Link>
        </div>
      </header>

      <main className="flex-1 max-w-[880px] w-full mx-auto px-6 py-20 flex flex-col items-center text-center">
        <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mb-6">
          <svg viewBox="0 0 32 32" className="w-7 h-7" fill="none" stroke="#22c55e" strokeWidth="3">
            <path d="M7 17 L13 23 L25 9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <h1 className="text-[32px] sm:text-[36px] font-semibold tracking-tight text-ink leading-tight">
          Setup complete.
        </h1>
        <p className="mt-3 text-[15px] text-muted leading-relaxed max-w-[560px]">
          Your team is ready to go. DealRipe will start analyzing your selected
          deals and sending pilot reps their first briefings before tomorrow&rsquo;s
          calls.
        </p>

        <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-4 w-full">
          <CompleteCta
            href="/pipeline"
            primary
            heading="Go to your dashboard"
            body="See your pilot deals scored against your framework. This is where you live day to day."
          />
          <CompleteCta
            href="/rep-onboarding"
            heading="Preview what reps see at setup"
            body="The Slack DM your team gets when you add them to the pilot."
          />
          <CompleteCta
            href="/rep-experience"
            heading="Preview what reps see day to day"
            body="The three Slack notifications a rep gets across one call cycle."
          />
        </div>
      </main>
    </div>
  );
}

function CompleteCta({
  href,
  heading,
  body,
  primary,
}: {
  href: string;
  heading: string;
  body: string;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`text-left bg-white rounded-xl2 border p-5 transition ${
        primary
          ? "border-ink hover:bg-ink hover:text-white group"
          : "border-line hover:border-muted/50"
      }`}
    >
      <div
        className={`text-[14px] font-semibold leading-snug ${
          primary ? "text-ink group-hover:text-white" : "text-ink"
        }`}
      >
        {heading}
      </div>
      <p
        className={`mt-2 text-[12.5px] leading-relaxed ${
          primary ? "text-muted group-hover:text-white/80" : "text-muted"
        }`}
      >
        {body}
      </p>
      <div
        className={`mt-4 text-[12px] font-bold ${
          primary ? "text-ink group-hover:text-white" : "text-accent"
        }`}
      >
        Open <span aria-hidden>→</span>
      </div>
    </Link>
  );
}
