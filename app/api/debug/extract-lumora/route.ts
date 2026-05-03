import { NextRequest, NextResponse } from "next/server";
import { lumoraDiscoveryTranscript } from "@/lib/seed-transcript";

// DEBUG ONLY. Delete before commit.
// Posts the seeded Lumora transcript to /api/extract-scotsman and
// returns the raw extraction result for eyeballing.

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const start = Date.now();

  const response = await fetch(`${origin}/api/extract-scotsman`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      dealId: "lumora-2026-q2",
      transcript: lumoraDiscoveryTranscript,
    }),
  });

  const duration = Date.now() - start;
  const data = await response.json();

  return NextResponse.json({
    debug: {
      status: response.status,
      durationMs: duration,
    },
    ...data,
  });
}
