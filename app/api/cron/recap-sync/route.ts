import { NextRequest, NextResponse } from "next/server";

import { runRecapSync } from "@/lib/recap-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The recap and follow-up draft, split out of transcript-sync.
 *
 * transcript-sync now does only what cannot be re-run: poll the bot, persist
 * the transcript body, extract, mark. This does everything expensive, and being
 * killed here costs a five minute delay rather than a lost draft. See the
 * header of lib/recap-sync.ts for the measurements that forced the split.
 *
 * Runs on the same five minute cadence, offset by a minute so the two are not
 * competing for the same Anthropic capacity in the same second.
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
    const counts = await runRecapSync();
    return NextResponse.json({ ok: true, ...counts });
  } catch (err) {
    console.error("[cron/recap-sync] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
