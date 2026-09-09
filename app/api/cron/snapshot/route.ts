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

    // The rep's checklist trajectory, which Rolldog itself does not keep.
    //
    // Here rather than inside recordAllDealSnapshots because the digest cron
    // calls that too, and the checklist sweep belongs to one owner. Here rather
    // than in briefing-sync because briefings only cover deals with an upcoming
    // meeting, so a deal would stop being observed exactly when its checklist
    // matters most. Here rather than in its own cron because this route already
    // resolves the deals and excludes the resolved ones correctly.
    //
    // Internally gated to one read per opportunity per 12 hours, so running on
    // the four-hourly cadence does not quadruple crm_access_log volume for a
    // list a human ticks a few times a month.
    //
    // Best effort: a checklist failure must never cost a day of snapshots,
    // which are the thing the digest actually runs on.
    let gateEvents: number | string = 0;
    try {
      const { sweepAllChecklists } = await import("@/lib/stage-gate-log");
      const swept = await sweepAllChecklists({ tenantId, apply: true });
      gateEvents = swept.reduce((n, r) => n + r.changes.length, 0);
      const unreadable = swept.filter((r) => r.status === "unavailable").length;
      if (unreadable > 0) console.warn(`[cron/snapshot] ${unreadable} checklist(s) unavailable`);
    } catch (err) {
      // Reported in the response rather than swallowed. A whole-run failure
      // that looks identical to "nothing moved" is how a broken sweep survives
      // for weeks.
      gateEvents = `failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error("[cron/snapshot] checklist sweep failed:", err);
    }

    return NextResponse.json({ ok: true, written, gateEvents });
  } catch (err) {
    console.error("[cron/snapshot] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
