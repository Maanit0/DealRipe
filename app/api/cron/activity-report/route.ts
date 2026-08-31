import { NextRequest, NextResponse } from "next/server";

import { buildActivityReport } from "@/lib/activity-report";
import { MailerConfigError, sendEmail } from "@/lib/mailer";
import { recordActivityReportSend } from "@/lib/sent-messages";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PILOT_TENANT_SLUG = "magaya";

/**
 * Every deal, split by whether the customer is moving. Mondays, with the digest.
 *
 * Mark Buman asked for it on 2026-08-26 and named the cadence himself: "if I can
 * get that on Mondays with the digest, that's perfect, because then I can look
 * at the two side by side."
 *
 * FIVE MINUTES AFTER THE DIGEST, not at the same minute. Both are one Resend
 * send to the same person, and two mails landing in the same second arrive in
 * an order neither of us controls. The digest is the one he already reads, so
 * it goes first and this follows.
 *
 * NO PDF FROM HERE. Mark asked for the report as a PDF, and this route cannot
 * make one: rendering it needs a headless browser and Vercel's Node runtime has
 * no Chrome. So the cron sends the HTML, which is complete and readable, and the
 * PDF is produced by scripts/test-send-report.ts on a machine that has Chrome.
 * Saying this here because "the cron sends a PDF" is the obvious assumption and
 * it is wrong.
 *
 * SENDING IS OFF UNTIL EXPLICITLY ENABLED.
 *
 * ACTIVITY_REPORT_ENABLED must be exactly "1". Without it this builds the
 * report, records what it would have sent, and returns the counts, which is how
 * we watch a few Mondays before a customer's CRO does. A weekly artifact that
 * goes to the sponsor is not something to ship unreviewed.
 */
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 500 });
  }
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const apply = process.env.ACTIVITY_REPORT_ENABLED === "1";
  // The same recipients as the digest, so the two arrive together for the same
  // people. Deliberately reading the digest's own variable rather than a second
  // list: two lists drift, and the failure is silent and lands on the sponsor.
  const to = (process.env.DIGEST_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // ACTIVITY_REPORT_BCC, its own variable rather than DIGEST_BCC. Whoever is
  // watching this report land is not necessarily on the digest, and one list
  // doing two jobs is how a name ends up on mail nobody meant to send them.
  const bcc = (process.env.ACTIVITY_REPORT_BCC ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  try {
    const tenantId = await resolveTenantId(PILOT_TENANT_SLUG);
    const report = await buildActivityReport({ tenantId });

    if (!apply || to.length === 0) {
      console.log(
        `[activity-report] apply=${apply} recipients=${to.length} bcc=${bcc.length} ` +
          `total=${report.counts.total} moving=${report.counts.moving} notMoving=${report.counts.notMoving} stalled=${report.counts.stalled} silent=${report.counts.silent} (not sent)`,
      );
      return NextResponse.json({
        ok: true,
        sent: false,
        reason: !apply ? "ACTIVITY_REPORT_ENABLED is not 1" : "DIGEST_TO is empty",
        ...report.counts,
      });
    }

    const res = await sendEmail({
      to,
      subject: report.subject,
      html: report.html,
      // Plain text is deliberately a pointer rather than a flattened table. 119
      // deals rendered as text is unreadable, and a text part nobody can use is
      // worse than one that says where to look.
      text: `${report.subject}. ${report.counts.silent} deals have gone quiet, ${report.counts.moving} are moving. Open the HTML version for the full list.`,
      ...(bcc.length > 0 ? { bcc } : {}),
    });
    await recordActivityReportSend({
      tenantId,
      toEmail: to.join(", "),
      subject: report.subject,
      html: report.html,
      text: report.subject,
      providerId: res.id || null,
    });

    console.log(
      `[activity-report] sent to ${to.join(", ")} total=${report.counts.total} silent=${report.counts.silent}`,
    );
    return NextResponse.json({ ok: true, sent: true, to, ...report.counts });
  } catch (err) {
    if (err instanceof MailerConfigError) {
      return NextResponse.json({ ok: false, error: `mailer not configured: ${err.message}` }, { status: 500 });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[activity-report] failed: ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
