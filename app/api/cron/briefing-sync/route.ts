import { NextRequest, NextResponse } from "next/server";

import { runBriefingSync } from "@/lib/briefing-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Cron entry for pre-call briefing delivery. Same Authorization pattern as the
 * other /api/cron/* routes: Vercel attaches `Authorization: Bearer
 * ${CRON_SECRET}` when the route is listed in vercel.json and CRON_SECRET is
 * set on the project.
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
    const counts = await runBriefingSync();
    return NextResponse.json({ ok: true, counts });
  } catch (err) {
    console.error("[cron/briefing-sync] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
