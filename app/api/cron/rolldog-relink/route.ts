import { NextRequest, NextResponse } from "next/server";

import { applyConfirmedLinks, findLinkMatches } from "@/lib/rolldog-reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PILOT_TENANT_SLUG = "magaya";

/**
 * Daily reconciliation cron. Finds deals DealRipe captured that have since been
 * promoted to a Rolldog opportunity, auto-links the confident matches, and
 * backfills the captured qualification data. Ambiguous matches are left for
 * manual review (they are not returned here as links). Same Vercel-cron bearer
 * pattern as the other crons (CRON_SECRET). Scheduled in vercel.json.
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
    const matches = await findLinkMatches(PILOT_TENANT_SLUG);
    const confirmed = matches.filter((m) => m.status === "confirmed");
    const review = matches.filter((m) => m.status === "review");
    const results = confirmed.length > 0 ? await applyConfirmedLinks(PILOT_TENANT_SLUG, confirmed) : [];
    const linked = results.filter((r) => r.linked).length;
    return NextResponse.json({
      ok: true,
      confirmed: confirmed.length,
      linked,
      review: review.length,
      results: results.map((r) => ({ account: r.account, oppId: r.oppId, linked: r.linked, wrote: r.writeback?.written ?? false, reason: r.writeback?.reason ?? r.error })),
    });
  } catch (err) {
    console.error("[cron/rolldog-relink] error:", err);
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
