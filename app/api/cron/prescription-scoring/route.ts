import { NextRequest, NextResponse } from "next/server";

import { runPrescriptionScoring } from "@/lib/prescription-scoring";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PILOT_TENANT_SLUG = "magaya";

/**
 * Cron entry for prescription scoring. Same Vercel-cron bearer pattern as
 * every other job here.
 *
 * NOT YET IN vercel.json, deliberately. Wiring it schedules writes against the
 * live ledger, which should happen once the migration is applied and the
 * backfill has been read. The line to add when that is true:
 *
 *   { "path": "/api/cron/prescription-scoring", "schedule": "0 0,6,12,18 * * *" }
 *
 * Six-hourly rather than every five minutes: a transcript that lands during a
 * call is scored within hours either way, and the outcome refresh does a
 * mailbox read per call, which is not worth doing 288 times a day. Rolldog
 * already asked us once to stop hammering a cron on a schedule the work did
 * not need.
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
    const counts = await runPrescriptionScoring({ tenantSlug: PILOT_TENANT_SLUG });
    return NextResponse.json({ ok: true, counts });
  } catch (err) {
    console.error("[cron/prescription-scoring] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
