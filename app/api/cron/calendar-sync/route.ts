import { NextRequest, NextResponse } from "next/server";

import { runCalendarSync } from "@/lib/calendar-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Cron entry for calendar sync. Vercel sends `Authorization: Bearer
 * ${CRON_SECRET}` automatically when a /api/cron/* route is listed in
 * vercel.json AND the CRON_SECRET env var is set on the project.
 *
 * Both GET (Vercel default) and POST are supported so the route can also
 * be triggered by a CI step or a curl command during incidents.
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
    const counts = await runCalendarSync();
    return NextResponse.json({ ok: true, counts });
  } catch (err) {
    console.error("[cron/calendar-sync] error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
