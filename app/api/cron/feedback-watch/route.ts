import { NextRequest, NextResponse } from "next/server";

import { reviewNewFeedback, worthReporting } from "@/lib/feedback-watch";
import { MailerConfigError, sendEmail } from "@/lib/mailer";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PILOT_TENANT_SLUG = "magaya";

/**
 * Read what the reps said about their artifacts, within minutes of them saying it.
 *
 * Runs every 15 minutes. The latency is the point: a rep who thumbs down a
 * recap still remembers the call, so a question back to them lands while it
 * costs them nothing to answer. Nothing here writes to a rep.
 *
 * IT REPORTS TO ONE PERSON AND CHANGES NOTHING ITSELF. See lib/feedback-watch.ts
 * for why a loop that edits its own prompts is not what this is.
 *
 * SENDING IS OFF UNTIL EXPLICITLY ENABLED. FEEDBACK_WATCH_ENABLED must be
 * exactly "1". Without it the diagnoses are still computed and returned in the
 * response and the rows are still marked, so the queue does not silently pile
 * up while nobody is watching, but no mail goes out.
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
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const to = (process.env.FEEDBACK_WATCH_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const enabled = process.env.FEEDBACK_WATCH_ENABLED === "1";

  try {
    const tenantId = await resolveTenantId(PILOT_TENANT_SLUG);
    const { diagnoses, errors } = await reviewNewFeedback({ tenantId, limit: 20, markReviewed: true });
    const report = diagnoses.filter(worthReporting);

    // THE QUEUE LIVES IN THE DATABASE AND IS WORKED FROM .feedback/, NOT FROM A
    // MAILBOX. scripts/sync-feedback.ts materialises it on a machine that has
    // this repo; Vercel's filesystem is ephemeral so this cron cannot.
    //
    // Mail is therefore an INTERRUPTION, not the channel, and by default only
    // needs_you earns one: that verdict means a person has to decide something.
    // actionable and not_the_artifact are work, and work belongs in the queue
    // rather than in an inbox that six reps' artifacts already fill.
    const mailVerdicts = new Set(
      (process.env.FEEDBACK_WATCH_EMAIL_VERDICTS ?? "needs_you")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    );
    const toMail = report.filter((d) => mailVerdicts.has(d.verdict));

    if (toMail.length > 0 && enabled && to.length > 0) {
      await sendEmail({
        to,
        subject:
          toMail.length === 1
            ? `Rep feedback needs you: ${toMail[0].account ?? toMail[0].kind}`
            : `Rep feedback: ${toMail.length} items need you`,
        html: renderHtml(toMail),
        text: toMail
          .map((d) => `${d.vote.toUpperCase()} ${d.kind} ${d.account ?? ""} [${d.verdict}]\n${d.diagnosis}\n${d.proposedChange ?? ""}`)
          .join("\n\n"),
      });
    }

    console.log(
      `[feedback-watch] reviewed=${diagnoses.length} queued=${report.length} mailed=${toMail.length} ` +
        `errors=${errors.length} sent=${toMail.length > 0 && enabled && to.length > 0}`,
    );
    return NextResponse.json({
      ok: true,
      reviewed: diagnoses.length,
      queued: report.length,
      mailed: toMail.length,
      byVerdict: diagnoses.reduce<Record<string, number>>((a, d) => ({ ...a, [d.verdict]: (a[d.verdict] ?? 0) + 1 }), {}),
      sent: toMail.length > 0 && enabled && to.length > 0,
      errors,
    });
  } catch (err) {
    if (err instanceof MailerConfigError) {
      return NextResponse.json({ ok: false, error: `mailer not configured: ${err.message}` }, { status: 500 });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[feedback-watch] failed: ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

const LABEL: Record<string, string> = {
  actionable: "Fixable now",
  needs_you: "Your call",
  not_the_artifact: "Not the writing",
  no_signal: "Nothing to learn",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderHtml(items: ReturnType<typeof worthReporting> extends never ? never : Parameters<typeof worthReporting>[0][]): string {
  const rows = items
    .map(
      (d) =>
        `<div style="margin:0 0 22px;padding:14px 16px;border:1px solid #E5E7EB;border-radius:8px;">` +
        `<div style="font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:.04em;">${esc(LABEL[d.verdict] ?? d.verdict)}</div>` +
        `<div style="font-size:15px;font-weight:600;margin:4px 0 8px;">${d.vote === "up" ? "Thumbs up" : "Thumbs down"} on the ${esc(d.kind)}${d.account ? `, ${esc(d.account)}` : ""}</div>` +
        `<div style="font-size:13px;color:#374151;margin-bottom:8px;">${esc(d.repEmail)}${d.note ? `, who wrote: "${esc(d.note)}"` : ", who left no note"}</div>` +
        `<div style="font-size:14px;margin-bottom:8px;">${esc(d.diagnosis)}</div>` +
        (d.proposedChange ? `<div style="font-size:14px;background:#F9FAFB;padding:10px 12px;border-radius:6px;"><strong>Proposed:</strong> ${esc(d.proposedChange)}</div>` : "") +
        (d.wherePossibly ? `<div style="font-size:12px;color:#6B7280;margin-top:6px;">Likely in ${esc(d.wherePossibly)}</div>` : "") +
        `</div>`,
    )
    .join("");
  return `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:640px;">${rows}</div>`;
}
