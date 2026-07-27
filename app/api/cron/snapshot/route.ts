import { NextRequest, NextResponse } from "next/server";

import { recordAllDealSnapshots } from "@/lib/snapshot";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PILOT_TENANT_SLUG = "magaya";

/**
 * Daily signal-snapshot cron. Writes one deal_signal_snapshots row per
 * pilot deal so the digest has week-over-week history to diff. Same
 * Vercel-cron bearer pattern as the other crons (CRON_SECRET).
 * Scheduled in vercel.json.
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

  try {
    const tenantId = await resolveTenantId(PILOT_TENANT_SLUG);
    // Live Rolldog state per deal, so each snapshot records the rep-entered
    // stage/forecast/close/size and the digest can diff real week-over-week moves.
    const written = await recordAllDealSnapshots(tenantId);
    return NextResponse.json({ ok: true, written });
  } catch (err) {
    console.error("[cron/snapshot] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
