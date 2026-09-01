import { SiteHeader, SiteFooter, CtaButton } from "@/components/site/Chrome";
import { Reveal } from "@/components/site/Reveal";
import { Compare } from "@/components/site/Compare";
import { Pains } from "@/components/site/Pains";
import { LiveRead } from "@/components/site/LiveRead";
import { HowItWorks } from "@/components/site/HowItWorks";
import { Outputs } from "@/components/site/Outputs";
import { WeekInNumbers } from "@/components/site/WeekInNumbers";

// Marketing copy lives here rather than in the root layout, so the internal
// app pages do not inherit a sales headline in their tab title.
export const metadata = {
  title: "DealRipe. Turn more pipeline into closed-won revenue.",
  description:
    "An AI agent on every open opportunity. It reads what the customer is actually doing, then gives the rep the next move, drawn from what your best reps do to win deals like it.",
  openGraph: {
    title: "Turn more pipeline into closed-won revenue.",
    description:
      "An AI agent on every open opportunity. It reads what the customer is actually doing, then gives the rep the next move.",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "DealRipe" }],
  },
};

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 text-[12px] font-bold uppercase tracking-[0.1em] text-emerald-700">
      {children}
    </div>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="max-w-[780px] text-[30px] font-semibold leading-[1.12] tracking-tight text-ink sm:text-[38px]">
      {children}
    </h2>
  );
}

function Lede({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-5 max-w-[680px] text-[16px] leading-relaxed text-muted">{children}</p>
  );
}

function Verb({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-9 max-w-[720px] text-[30px] font-semibold leading-[1.12] tracking-tight text-ink sm:text-[36px]">
      {children}
    </h2>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 max-w-[620px] text-[16.5px] leading-relaxed text-muted">{children}</p>
  );
}

/** Sections are uniformly tall and quiet. The whitespace is doing design work. */
function Section({ children }: { children: React.ReactNode }) {
  return (
    <Reveal as="section" className="border-t border-line py-24 sm:py-28">
      {children}
    </Reveal>
  );
}


export default function LandingPage() {
  return (
    <div className="min-h-screen bg-bg font-sans text-ink antialiased">
      <SiteHeader />

      <main className="mx-auto max-w-[1080px] px-6">
        <Reveal as="section" className="max-w-[920px] pb-20 pt-24">
          <h1 className="text-[42px] font-semibold leading-[1.02] tracking-tight text-ink sm:text-[60px]">
            Turn more pipeline into closed-won revenue.
          </h1>
          <p className="mt-7 max-w-[700px] text-[19px] leading-relaxed text-muted">
            DealRipe puts an AI agent on every important deal. It reads what the
            customer is actually doing and decides, continuously, what that deal
            needs next, the way your best reps would.
          </p>
          <div className="mt-10">
            <CtaButton />
          </div>
        </Reveal>

        <Reveal as="section" className="pb-24">
          <Eyebrow>The read</Eyebrow>
          <LiveRead />
          <Verb>DealRipe reads the deal and drafts the move.</Verb>
          <Line>
            Which deal. What risk. What evidence. What to do next.
          </Line>
        </Reveal>

        <Section>
          <Eyebrow>The problem</Eyebrow>
          <H2>Too many deals look healthy, right up until they stall.</H2>
          <div className="mt-12">
            <Pains />
          </div>
        </Section>

        <Section>
          <Eyebrow>Why the tools do not fix it</Eyebrow>
          <H2>Every tool inherits the same constraint.</H2>
          <Lede>
            One model sitting over 200 deals can only read what the rep entered.
          </Lede>
          <div className="mt-12">
            <Compare />
          </div>
        </Section>

        {/* Header and stepper are separate elements: Reveal animates a
            transform, and a transformed ancestor can break position: sticky. */}
        <Reveal as="section" className="border-t border-line pt-24 sm:pt-28">
          <Eyebrow>How it works</Eyebrow>
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-16">
            <h2 className="text-[30px] font-semibold leading-[1.12] tracking-tight text-ink sm:text-[38px]">
              We learn your motion, then we run it on every deal.
            </h2>
            <p className="text-[16.5px] leading-relaxed text-muted lg:pt-2">
              DealRipe plugs into the calls, email and calendar your team already
              runs. Every open opportunity gets its own agent, which reads what
              the buyer did, tells the rep what to do next, and records what
              happened so the next recommendation is sharper. Nobody on your team
              opens another tool. It all arrives where they already work.
            </p>
          </div>
        </Reveal>

        <section className="pb-16">
          <HowItWorks />
        </section>

        <Section>
          <Eyebrow>What your team gets</Eyebrow>
          <div className="mt-2">
            <Outputs />
          </div>
        </Section>

        <Reveal as="section" className="pb-24 pt-4">
          <WeekInNumbers />
        </Reveal>

        <Reveal as="section" className="border-t border-line py-28 text-center">
          <h2 className="mx-auto max-w-[680px] text-[30px] font-semibold leading-tight tracking-tight text-ink sm:text-[38px]">
            See it run on one of your deals.
          </h2>
          <p className="mx-auto mt-5 max-w-[560px] text-[16px] leading-relaxed text-muted">
            Bring a stalled deal from your pipeline and a recent call on it.
            We&rsquo;ll show you the read, the evidence behind it, and the next
            move to unstick it.
          </p>
          <p className="mx-auto mt-6 max-w-[560px] text-[15px] leading-relaxed text-ink">
            DealRipe is live on real deals under a paid contract. A CRO runs his
            weekly pipeline review out of it rather than his CRM.
          </p>
          <div className="mt-10">
            <CtaButton variant="accent" />
          </div>
        </Reveal>
      </main>

      <SiteFooter />
    </div>
  );
}
