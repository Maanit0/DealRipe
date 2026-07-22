import Link from "next/link";

import { AppShell } from "@/components/AppShell";
import { runDailyAudit, type AuditFinding, type AuditReport } from "@/lib/audit";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const dynamic = "force-dynamic";

const SEV_DOT: Record<string, string> = {
  error: "bg-danger",
  warn: "bg-warn",
  info: "bg-accent",
};

export default async function AuditPage() {
  let report: AuditReport | null = null;
  try {
    const tenantId = await resolveTenantId("magaya");
    // Read-only: a dry run that surfaces issues without changing any data.
    report = await runDailyAudit(tenantId, { apply: false });
  } catch (err) {
    console.error("[audit page] load failed:", err);
  }

  const open = report?.findings.filter((f) => f.severity !== "info") ?? [];
  const info = report?.findings.filter((f) => f.severity === "info") ?? [];

  return (
    <AppShell active="audit">
      <div className="min-h-screen bg-bg">
      <main className="max-w-[900px] mx-auto px-6 py-7">
        <Link
          href="/pipeline?tenant=magaya"
          className="inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink transition mb-5"
        >
          <span className="text-base leading-none">←</span> Back to pipeline
        </Link>

        <div className="text-[11px] uppercase tracking-wider font-semibold text-accent">
          DealRipe audit
        </div>
        <h1 className="text-[24px] font-semibold text-ink mt-1">Deal consistency check</h1>
        <p className="text-[13px] text-muted mt-1">
          Checks that the UI, the transcripts, who was on each call, and the stored
          stakeholders agree. Runs automatically every morning and fixes the safe issues;
          this page is a live read-only view.
        </p>

        {!report ? (
          <div className="mt-6 bg-white rounded-xl2 shadow-card border border-line px-5 py-4 text-[13px] text-muted">
            Could not run the audit. Check the server logs.
          </div>
        ) : report.findings.length === 0 ? (
          <div className="mt-6 bg-white rounded-xl2 shadow-card border border-line px-5 py-5">
            <div className="text-[14px] text-accent font-medium">
              Everything looks consistent across {report.dealsChecked} deal
              {report.dealsChecked === 1 ? "" : "s"}.
            </div>
            <div className="text-[12px] text-muted mt-1">Nothing to fix right now.</div>
          </div>
        ) : (
          <>
            <div className="mt-5 text-[12px] text-muted">
              {report.dealsChecked} deal{report.dealsChecked === 1 ? "" : "s"} checked ·{" "}
              {open.length} to review · {info.length} informational
            </div>

            {open.length > 0 && (
              <Section title="Needs attention" findings={open} />
            )}
            {info.length > 0 && (
              <Section title="Informational" findings={info} />
            )}

            <p className="text-[11px] text-muted mt-4 leading-snug">
              Safe fixes (backfilling a missing rep, re-extracting a stakeholder who
              spoke but was not captured) run automatically on the morning cron. Anything
              touching Rolldog is surfaced here for you rather than changed.
            </p>
          </>
        )}
      </main>
      </div>
    </AppShell>
  );
}

function Section({ title, findings }: { title: string; findings: AuditFinding[] }) {
  return (
    <div className="mt-5">
      <div className="text-[11px] uppercase tracking-wider font-semibold text-muted mb-2">
        {title}
      </div>
      <div className="bg-white rounded-xl2 shadow-card border border-line overflow-hidden">
        {findings.map((f, i) => (
          <div
            key={`${f.dealId}-${f.type}-${i}`}
            className={`px-5 py-3.5 flex items-start gap-3 ${
              i < findings.length - 1 ? "border-b border-line" : ""
            }`}
          >
            <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${SEV_DOT[f.severity] ?? "bg-muted"}`} />
            <div className="min-w-0">
              <Link
                href={`/deals/${f.dealId}`}
                className="text-[13px] text-ink hover:text-accent transition"
              >
                {f.message}
              </Link>
              {f.action && <div className="text-[12px] text-muted mt-0.5">{f.action}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
