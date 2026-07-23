import Link from "next/link";

import { TZ } from "@/lib/date-range";
import { subResourceLabel, type CoverageStep, type MeetingCoverage } from "@/lib/meeting-coverage";

const STATUS_META: Record<
  CoverageStep["status"],
  { icon: string; cls: string; word: string }
> = {
  on_time: { icon: "✓", cls: "bg-accent/10 text-accent", word: "On time" },
  late: { icon: "▲", cls: "bg-warn/10 text-warn", word: "Late" },
  early: { icon: "▲", cls: "bg-warn/10 text-warn", word: "Early" },
  duplicate: { icon: "⧉", cls: "bg-danger/10 text-danger", word: "Duplicate" },
  missing: { icon: "✕", cls: "bg-danger/10 text-danger", word: "Missing" },
  pending: { icon: "◷", cls: "bg-ink/[0.05] text-muted", word: "Pending" },
  not_expected: { icon: "–", cls: "bg-ink/[0.04] text-muted/60", word: "N/A" },
};

function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: TZ,
    });
  } catch {
    return "—";
  }
}

function StepChip({ label, step }: { label: string; step: CoverageStep }) {
  const m = STATUS_META[step.status];
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className={`shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-[11px] font-semibold ${m.cls}`}>
        {m.icon}
      </span>
      <div className="min-w-0">
        <div className="text-[12px] text-ink font-medium leading-tight">{label}</div>
        <div className="text-[11px] text-muted leading-tight truncate">
          {step.status === "not_expected" ? "not applicable" : step.detail}
        </div>
      </div>
    </div>
  );
}

const TYPE_LABEL: Record<string, string> = {
  discovery: "Discovery",
  demo: "Demo",
  proposal: "Proposal",
  follow_up: "Follow-up",
  customer: "Customer",
  internal: "Internal",
};

export function CoverageList({ meetings }: { meetings: MeetingCoverage[] }) {
  if (meetings.length === 0) {
    return (
      <div className="mt-5 bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
        No meetings in this range.
      </div>
    );
  }

  const withIssues = meetings.filter((m) => m.issues.length > 0).length;

  return (
    <div className="mt-4 space-y-3">
      {withIssues > 0 && (
        <div className="text-[12px] text-muted">
          <span className="font-medium text-danger">{withIssues}</span> of {meetings.length} meetings have something to
          look at.
        </div>
      )}
      {meetings.map((m) => {
        const clean = m.issues.length === 0;
        const wb = m.writeback;
        const showWbDetail = wb.written.length > 0 || wb.missed.length > 0 || wb.nextStep !== "none";
        return (
          <div key={m.callId} className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
            <div className="px-5 py-3.5 flex items-start gap-4 border-b border-line/70">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] text-ink font-medium">
                  <Link href={`/meetings/${m.callId}`} className="hover:underline">
                    {m.title || m.account || "Meeting"}
                  </Link>
                  {m.account && m.title && (
                    <>
                      {" · "}
                      {m.dealId ? (
                        <Link href={`/deals/${m.dealId}`} className="text-accent hover:underline">
                          {m.account}
                        </Link>
                      ) : (
                        <span className="text-muted">{m.account}</span>
                      )}
                    </>
                  )}
                </div>
                <div className="text-[11px] text-muted mt-0.5">
                  {fmt(m.callDate)}
                  {m.callSubtype && TYPE_LABEL[m.callSubtype] ? ` · ${TYPE_LABEL[m.callSubtype]}` : ""}
                </div>
              </div>
              <span
                className={`shrink-0 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full ${
                  clean ? "bg-accent/10 text-accent" : "bg-danger/10 text-danger"
                }`}
              >
                {clean ? "All clear" : `${m.issues.length} to review`}
              </span>
            </div>

            <div className="px-5 py-3.5 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StepChip label="Briefing" step={m.briefing} />
              <StepChip label="Recap" step={m.recap} />
              <StepChip label="Rolldog write-back" step={m.writeback} />
            </div>

            {(showWbDetail || !clean) && (
              <div className="px-5 pb-3.5 space-y-2">
                {showWbDetail && (
                  <div className="text-[11px] text-muted rounded-lg bg-bg border border-line px-3 py-2">
                    {wb.written.filter((s) => s !== "activities").length > 0 && (
                      <div>
                        <span className="text-ink font-medium">Wrote:</span>{" "}
                        {wb.written.filter((s) => s !== "activities").map(subResourceLabel).join(", ")}
                      </div>
                    )}
                    {wb.missed.length > 0 && (
                      <div className="text-danger mt-0.5">
                        <span className="font-medium">Missed:</span> {wb.missed.map(subResourceLabel).join(", ")} (confirmed
                        on the call but not written)
                      </div>
                    )}
                    <div className="mt-0.5">
                      <span className="text-ink font-medium">Next step:</span>{" "}
                      {wb.nextStep === "written"
                        ? "written to interactions tab"
                        : wb.nextStep === "gated"
                          ? "composed, live write gated (ROLLDOG_WRITE_NEXT_STEP off)"
                          : "none"}
                    </div>
                  </div>
                )}
                {!clean && (
                  <div className="text-[11px] text-danger">{m.issues.join(" · ")}</div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
