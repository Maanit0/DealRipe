import { NextRequest, NextResponse } from "next/server";

import { runDailyAudit, type AuditFinding } from "@/lib/audit";
import { sendEmail } from "@/lib/mailer";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PILOT_TENANT_SLUG = "magaya";

/**
 * Daily deal-hygiene audit cron. Runs the audit with fixes applied, then emails
 * a compact summary to the operator (you), not the customer. Same Vercel-cron
 * bearer pattern as the other crons (CRON_SECRET).
 *
 *   AUDIT_TO   who receives the summary (default DIGEST_REPLY_TO, else maanits@berkeley.edu)
 *   AUDIT_ALWAYS_EMAIL  "1" to email even on a clean run (default: only when there's something)
 */
export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 500 });
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const tenantId = await resolveTenantId(PILOT_TENANT_SLUG);
    const report = await runDailyAudit(tenantId, { apply: true });

    const needsAttention = report.findings.filter((f) => !f.fixed && f.severity !== "info");
    const shouldEmail =
      process.env.AUDIT_ALWAYS_EMAIL === "1" ||
      report.fixedCount > 0 ||
      needsAttention.length > 0;

    const to =
      process.env.AUDIT_TO ?? process.env.DIGEST_REPLY_TO ?? "maanits@berkeley.edu";
    let sentId: string | null = null;
    if (shouldEmail && to) {
      const { subject, html, text } = renderAuditEmail(report.findings, report.dealsChecked, report.fixedCount);
      const res = await sendEmail({
        to,
        subject,
        html,
        text,
        replyTo: to,
      });
      sentId = res.id;
    }

    return NextResponse.json({
      ok: true,
      dealsChecked: report.dealsChecked,
      fixed: report.fixedCount,
      findings: report.findings.length,
      needsAttention: needsAttention.length,
      emailed: sentId != null,
    });
  } catch (err) {
    console.error("[cron/audit] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

const COLOR: Record<string, string> = {
  error: "#EF4444",
  warn: "#F59E0B",
  info: "#10B981",
};

function renderAuditEmail(findings: AuditFinding[], dealsChecked: number, fixedCount: number) {
  const fixed = findings.filter((f) => f.fixed);
  const open = findings.filter((f) => !f.fixed);
  const subject = `DealRipe audit: ${fixedCount} fixed, ${open.length} to review`;

  const row = (f: AuditFinding) => {
    const dot = COLOR[f.severity] ?? "#64748B";
    return `<tr><td style="padding:8px 0;border-bottom:1px solid #E2E8F0;vertical-align:top">
      <span style="display:inline-block;width:8px;height:8px;border-radius:9999px;background:${dot};margin-right:8px"></span>
      <span style="color:#0F172A;font-size:14px">${escape(f.message)}</span>
      ${f.action ? `<div style="color:#64748B;font-size:12px;margin:2px 0 0 16px">${escape(f.action)}</div>` : ""}
    </td></tr>`;
  };

  const section = (title: string, items: AuditFinding[]) =>
    items.length === 0
      ? ""
      : `<div style="margin-top:20px"><div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#64748B;font-weight:600;margin-bottom:6px">${title}</div>
         <table style="width:100%;border-collapse:collapse">${items.map(row).join("")}</table></div>`;

  const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#0F172A">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#10B981;font-weight:700">DealRipe audit</div>
    <div style="font-size:20px;font-weight:700;margin-top:4px">${dealsChecked} deal${dealsChecked === 1 ? "" : "s"} checked</div>
    <div style="font-size:13px;color:#64748B;margin-top:4px">${fixedCount} fixed automatically, ${open.length} need${open.length === 1 ? "s" : ""} a look.</div>
    ${section("Needs your attention", open)}
    ${section("Fixed automatically", fixed)}
    ${findings.length === 0 ? `<div style="margin-top:20px;font-size:14px;color:#10B981">Everything looks consistent. Nothing to fix.</div>` : ""}
  </div>`;

  const text =
    `DealRipe audit — ${dealsChecked} deals checked, ${fixedCount} fixed, ${open.length} to review\n\n` +
    (open.length ? "NEEDS ATTENTION\n" + open.map((f) => `- ${f.message}${f.action ? ` (${f.action})` : ""}`).join("\n") + "\n\n" : "") +
    (fixed.length ? "FIXED\n" + fixed.map((f) => `- ${f.message}`).join("\n") + "\n" : "");

  return { subject, html, text };
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
