import type { MagayaBriefing } from "@/lib/generate-briefing";

const STAGE_LABELS: Record<string, string> = {
  SQL0: "Lead",
  SQL1: "Develop Opportunity",
  SQL2: "Solution Finalization",
  SQL3: "Proposal Validation",
  SQL4: "Negotiations",
  SQL5: "Agreement Formalization",
};

export function MagayaBriefingView({
  account,
  stageKey,
  attendees,
  briefing,
}: {
  account: string;
  stageKey: string;
  attendees: string;
  briefing: MagayaBriefing | null;
}) {
  if (!briefing) {
    return (
      <div className="bg-white rounded-xl2 shadow-card border border-line p-8 text-center">
        <p className="text-[14px] text-ink font-medium">Could not generate the briefing</p>
        <p className="text-[12px] text-muted mt-1">
          Check the deal has extracted call data, then reload.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[20px] font-semibold text-ink">
          Briefing for next call · {account}
        </h1>
        <p className="text-[12px] text-muted mt-0.5">
          {STAGE_LABELS[stageKey] ?? stageKey} · on the call: {attendees}
        </p>
      </div>

      <Section label="Call objective">
        <p className="text-[14px] text-ink leading-relaxed">{briefing.callObjective}</p>
      </Section>

      <Section label="Where it stands">
        <p className="text-[13px] text-ink leading-relaxed">{briefing.whereItStands}</p>
      </Section>

      <Section label={`Ask these (${briefing.questions.length})`}>
        <div className="space-y-4">
          {briefing.questions.map((q, i) => (
            <div key={i} className="flex gap-3">
              <span className="text-[13px] font-semibold text-muted shrink-0 pt-0.5">{i + 1}.</span>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-[14px] text-ink font-medium leading-snug">{q.ask}</span>
                  {q.targetLabel && (
                    <span className="text-[9px] uppercase tracking-wider font-bold text-muted bg-bg border border-line rounded px-1.5 py-0.5">
                      {q.targetLabel}
                    </span>
                  )}
                </div>
                {q.why && (
                  <p className="text-[12px] text-muted leading-snug mt-1">{q.why}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section label="Secure this next step">
        <p className="text-[13px] text-ink leading-relaxed">{briefing.nextStepCommitment}</p>
      </Section>

      <Section label="What's at risk" tone="danger">
        <p className="text-[13px] text-ink leading-relaxed">{briefing.whatsAtRisk}</p>
      </Section>

      {briefing.signalFlag && (
        <div className="bg-danger/[0.04] border border-danger/30 rounded-xl2 px-5 py-4">
          <div className="text-[10px] uppercase tracking-wider font-bold text-danger mb-1.5">
            Signal
          </div>
          <p className="text-[13px] text-ink leading-relaxed">{briefing.signalFlag}</p>
        </div>
      )}
    </div>
  );
}

function Section({
  label,
  tone = "default",
  children,
}: {
  label: string;
  tone?: "default" | "danger";
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl2 shadow-card border border-line px-5 py-4">
      <div
        className={`text-[10px] uppercase tracking-wider font-bold mb-2 ${tone === "danger" ? "text-danger" : "text-muted"}`}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
