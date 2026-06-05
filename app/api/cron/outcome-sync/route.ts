import { NextRequest, NextResponse } from "next/server";

import { syncOutcomes } from "@/lib/outcome-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PILOT_TENANT_SLUG = "magaya";

/**
 * Cron entry for daily outcome sync. Same Vercel-cron bearer pattern as
 * calendar-sync and transcript-sync: CRON_SECRET set on the project,
 * Vercel auto-attaches the Authorization header on cron invocations.
 *
 * Scheduled daily (06:00 UTC) in vercel.json. Outcomes don't change
 * minute-to-minute; once a day is sufficient and minimises Salesforce
 * API load.
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
    return NextResponse.json(
      { error: "CRON_SECRET is not set" },
      { status: 500 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const counts = await syncOutcomes(PILOT_TENANT_SLUG);
    return NextResponse.json({ ok: true, counts });
  } catch (err) {
    console.error("[cron/outcome-sync] error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
