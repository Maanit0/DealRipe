import { NextRequest, NextResponse } from "next/server";

import { envValue } from "@/lib/env-value";

import { buildWeeklyDigest } from "@/lib/digest-build";
import { sendEmail } from "@/lib/mailer";
import { recordDigestSend } from "@/lib/sent-messages";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PILOT_TENANT_SLUG = "magaya";

/**
 * Weekly digest cron. Builds the evidence-based digest across every pilot deal
 * and emails it to the sales leader. Same Vercel-cron bearer pattern as the
 * other crons (CRON_SECRET). Scheduled Tuesday 6am Central in vercel.json, so it
 * lands before Mark's pipeline review. Runs a fresh snapshot first (see handle).
 *
 * Recipient is env-driven so it can be pointed at yourself for review before it
 * goes to the customer:
 *   DIGEST_TO         who receives it, comma-separated for multiple visible
 *                     recipients (required; skips send if unset)
 *   DIGEST_BCC        optional, comma-separated silent copies (e.g. yourself, so
 *                     Mark sees a clean email addressed only to him)
 *   DIGEST_TO_NAME    name shown in the header (default "Mark Buman")
 *   DIGEST_REPLY_TO   where replies go (default maanits@berkeley.edu)
 *   DEALRIPE_APP_URL  base URL for the deal links + pipeline button
 */

/** Split a comma/semicolon-separated env value into a clean list of addresses. */
function addrs(v: string | undefined): string[] {
  return (v ?? "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
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

  const to = addrs(envValue("DIGEST_TO"));
  const bcc = addrs(envValue("DIGEST_BCC"));
  if (to.length === 0) {
    return NextResponse.json({ ok: false, reason: "DIGEST_TO not set; nothing sent" });
  }

  try {
    const tenantId = await resolveTenantId(PILOT_TENANT_SLUG);
    // Every build step lives in lib/digest-build.ts so the preview script runs
    // the identical sequence. It drifted once, silently, and the preview then
    // showed a digest with no ranking, flags, narratives or forecast-why.
    const { email, pc, snapshot } = await buildWeeklyDigest({
      tenantId,
      recipientName: process.env.DIGEST_TO_NAME ?? "Mark Buman",
      baseUrl: process.env.DEALRIPE_APP_URL,
      refreshSnapshots: true,
    });
    console.log("[cron/digest] snapshot:", JSON.stringify(snapshot));
    const res = await sendEmail({
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      replyTo: process.env.DIGEST_REPLY_TO ?? "maanits@berkeley.edu",
      ...(bcc.length ? { bcc } : {}),
    });
    await recordDigestSend({
      tenantId,
      toEmail: [...to, ...bcc].join(", "),
      subject: email.subject,
      html: email.html,
      text: email.text,
      providerId: res.id,
    });
    return NextResponse.json({
      ok: true,
      to,
      bcc,
      sentId: res.id,
      deals: pc.deals.length,
      needAttention: pc.headline.dealsNeedingAttention,
      changed: pc.headline.dealsChanged,
    });
  } catch (err) {
    console.error("[cron/digest] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
