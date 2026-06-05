import Link from "next/link";
import { SlackMessage } from "@/components/SlackMessage";

export default function RepExperiencePage() {
  return (
    <div className="min-h-screen bg-bg font-sans text-ink antialiased">
      <header className="border-b border-line bg-white">
        <div className="max-w-[760px] mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/" className="text-[14px] font-semibold tracking-tight text-ink hover:opacity-80 transition">
            DealRipe
          </Link>
          <Link
            href="/onboarding/complete"
            className="text-[12px] font-semibold text-muted hover:text-ink transition"
          >
            Back to setup
          </Link>
        </div>
      </header>

      <main className="max-w-[760px] mx-auto px-6 py-10">
        <div className="mb-10">
          <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-2">
            Rep view
          </div>
          <h1 className="text-[24px] sm:text-[28px] font-semibold tracking-tight text-ink leading-tight">
            What your reps see day to day.
          </h1>
          <p className="mt-3 text-[14px] text-muted leading-relaxed max-w-[600px]">
            Three Slack notifications across one call cycle. No dashboard. No
            forms. The rep does their job. DealRipe handles the qualification
            and the CRM updates.
          </p>
        </div>

        <div className="space-y-10">
          <NotificationGroup heading="30 minutes before a call">
            <SlackThread time="10:00 AM, Tuesday">
              <SlackMessage authorName="DealRipe Bot" authorRole="App" time="10:00 AM">
                <p className="font-semibold">Briefing for Acme Corp at 10:30 AM.</p>
                <p className="mt-3">
                  <span className="font-semibold">Call objective:</span>{" "}
                  confirm budget authority and decision timeline.
                </p>
                <div className="mt-3">
                  <p className="font-semibold">Top 3 questions:</p>
                  <ol className="mt-1 space-y-1.5 list-decimal pl-5">
                    <li>
                      Walk me through who needs to sign off on a contract this
                      size. Is this CEO level or CFO level?
                    </li>
                    <li>
                      Has this been budgeted for this fiscal year, or would it
                      need new line item approval?
                    </li>
                    <li>What is your timeline for making a decision?</li>
                  </ol>
                </div>
                <p className="mt-3">
                  <span className="font-semibold text-danger">
                    What&rsquo;s at risk:
                  </span>{" "}
                  if we do not surface the budget owner today, the Q3 close
                  date you committed slips. Marcus said &ldquo;we&rsquo;re
                  waiting another year&rdquo; on the last call.
                </p>
                <div className="mt-4">
                  <button className="inline-flex items-center px-3 py-1.5 rounded-md bg-white border border-line text-ink text-[12.5px] font-semibold hover:bg-bg transition">
                    View full deal context
                  </button>
                </div>
              </SlackMessage>
            </SlackThread>
          </NotificationGroup>

          <NotificationGroup heading="Right after the call">
            <SlackThread time="11:08 AM, Tuesday">
              <SlackMessage authorName="DealRipe Bot" authorRole="App" time="11:08 AM">
                <p className="font-semibold">
                  Updated Acme Corp from your 10:30 AM call.
                </p>
                <ul className="mt-3 space-y-1.5">
                  <li className="flex items-start gap-2">
                    <span className="w-4 h-4 rounded-full bg-accent shrink-0 mt-0.5 flex items-center justify-center">
                      <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="none" stroke="white" strokeWidth="3">
                        <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span>
                      <span className="font-semibold">Confirmed:</span> $340K
                      budget approved (M1)
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-4 h-4 rounded-full bg-accent shrink-0 mt-0.5 flex items-center justify-center">
                      <svg viewBox="0 0 16 16" className="w-2.5 h-2.5" fill="none" stroke="white" strokeWidth="3">
                        <path d="M3 8l3.5 3.5L13 5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <span>
                      <span className="font-semibold">Confirmed:</span> CFO
                      identified as economic buyer (A2)
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-4 h-4 rounded-full border-2 border-line bg-white shrink-0 mt-0.5" />
                    <span>
                      <span className="font-semibold">Still missing:</span>{" "}
                      legal counsel relationship (A3)
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="w-4 h-4 rounded-full border-2 border-line bg-white shrink-0 mt-0.5" />
                    <span>
                      <span className="font-semibold">Still missing:</span>{" "}
                      paperwork timeline (T2)
                    </span>
                  </li>
                </ul>
                <p className="mt-3 text-muted text-[13px]">
                  3 fields written back to Salesforce automatically.
                </p>
                <div className="mt-3">
                  <button className="inline-flex items-center px-3 py-1.5 rounded-md bg-white border border-line text-ink text-[12.5px] font-semibold hover:bg-bg transition">
                    Review changes
                  </button>
                </div>
              </SlackMessage>
            </SlackThread>
          </NotificationGroup>

          <NotificationGroup heading="End of day">
            <SlackThread time="6:00 PM, Tuesday">
              <SlackMessage authorName="DealRipe Bot" authorRole="App" time="6:00 PM">
                <p className="font-semibold">Tomorrow&rsquo;s prep.</p>
                <p className="mt-3">
                  You have 2 calls tomorrow. Briefings will arrive 30 minutes
                  before.
                </p>
                <ul className="mt-2 space-y-1.5">
                  <li className="text-[14px]">
                    <span className="font-mono text-[12px] text-muted mr-2">10:00 AM</span>
                    Acme Corp <span className="text-muted">(continued)</span>
                  </li>
                  <li className="text-[14px]">
                    <span className="font-mono text-[12px] text-muted mr-2">2:00 PM</span>
                    Northwind Holdings{" "}
                    <span className="font-mono text-[9px] uppercase tracking-wider font-bold text-accent px-1 py-[1px] rounded bg-accent/10">
                      New
                    </span>
                    <span className="text-muted ml-2">
                      economic buyer joining
                    </span>
                  </li>
                </ul>
              </SlackMessage>
            </SlackThread>
          </NotificationGroup>
        </div>
      </main>
    </div>
  );
}

function NotificationGroup({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted mb-3">
        {heading}
      </div>
      {children}
    </section>
  );
}

function SlackThread({
  time,
  children,
}: {
  time: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl2 border border-line overflow-hidden">
      <div className="px-5 py-3 border-b border-line bg-bg flex items-center gap-2 text-[12px] text-muted">
        <span className="w-4 h-4 rounded-full bg-accent flex items-center justify-center text-white font-bold text-[8px]">
          DR
        </span>
        <span className="font-semibold text-ink">DealRipe</span>
        <span>·</span>
        <span>Direct message</span>
        <span className="ml-auto">{time}</span>
      </div>
      <div className="px-5 py-5">{children}</div>
    </div>
  );
}
