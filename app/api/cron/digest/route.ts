import { NextRequest, NextResponse } from "next/server";

import { renderWeeklyDigestEmail } from "@/lib/emails/weekly-digest";
import { sendEmail } from "@/lib/mailer";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";
import { buildWeeklyDigestData } from "@/lib/weekly-digest-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PILOT_TENANT_SLUG = "magaya";

/**
 * Weekly digest cron. Builds the evidence-based digest across every pilot deal
 * and emails it to the sales leader. Same Vercel-cron bearer pattern as the
 * other crons (CRON_SECRET). Scheduled Monday 6am Central in vercel.json.
 *
 * Recipient is env-driven so it can be pointed at yourself for review before it
 * goes to the customer:
 *   DIGEST_TO         who receives it (required; skips send if unset)
 *   DIGEST_TO_NAME    name shown in the header (default "Mark Buman")
 *   DIGEST_REPLY_TO   where replies go (default maanits@berkeley.edu)
 *   DEALRIPE_APP_URL  base URL for the deal links + pipeline button
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
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const to = process.env.DIGEST_TO;
  if (!to) {
    return NextResponse.json({ ok: false, reason: "DIGEST_TO not set; nothing sent" });
  }

  try {
    const tenantId = await resolveTenantId(PILOT_TENANT_SLUG);
    const { attention, movement, noShows } = await buildWeeklyDigestData(tenantId);
    const weekLabel = new Date().toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      timeZone: "America/Chicago",
    });
    const email = renderWeeklyDigestEmail({
      attention,
      movement,
      noShows,
      weekLabel,
      recipientName: process.env.DIGEST_TO_NAME ?? "Mark Buman",
      baseUrl: process.env.DEALRIPE_APP_URL,
    });
    const res = await sendEmail({
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      replyTo: process.env.DIGEST_REPLY_TO ?? "maanits@berkeley.edu",
    });
    return NextResponse.json({
      ok: true,
      to,
      sentId: res.id,
      attention: attention.length,
      movement: movement.length,
      noShows: noShows.length,
    });
  } catch (err) {
    console.error("[cron/digest] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
