import Link from "next/link";

import { AppShell } from "@/components/AppShell";

export const dynamic = "force-dynamic";

const LINKS = [
  { href: "/forecast", title: "Forecast room", desc: "Rep forecast vs. DealRipe's evidence-based read, at-risk deals." },
  { href: "/digests", title: "Weekly digest", desc: "What Mark receives each Monday, and every past send." },
  { href: "/impact", title: "Impact", desc: "Time saved, deals advanced, risks caught. The ROI story." },
];

export default function ReviewPage() {
  return (
    <AppShell active="review">
      <div className="max-w-[1100px] mx-auto px-6 py-7">
        <h1 className="text-[24px] font-semibold tracking-tight text-ink">Review</h1>
        <p className="text-[13px] text-muted mt-1">
          The leadership view: where the pipeline stands versus the evidence, what goes to Mark, and
          the value DealRipe has delivered.
        </p>
        <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-4">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4 hover:border-ink/30 transition block"
            >
              <div className="text-[14px] font-semibold text-ink">{l.title}</div>
              <div className="text-[12px] text-muted mt-1 leading-snug">{l.desc}</div>
            </Link>
          ))}
        </div>
        <p className="text-[11px] text-muted mt-4">
          These will fold into one Review view with tabs next. For now they open the existing pages.
        </p>
      </div>
    </AppShell>
  );
}
