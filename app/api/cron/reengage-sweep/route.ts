import { NextRequest, NextResponse } from "next/server";

import { runReengageSweep } from "@/lib/reengage-sweep";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PILOT_TENANT_SLUG = "magaya";

/**
 * Re-engagement drafts, triggered by a flag rather than by a call.
 *
 * Everything else DealRipe drafts is triggered by an event: a call ended, a
 * meeting was missed. That covers the moment after a conversation and nothing
 * else, so a deal that quietly stops moving gets nothing, which is exactly when
 * a rep most needs the nudge. Magaya's dominant recorded loss reason is
 * "No Decision / Non-Responsive", and 65 of 122 live deals are currently
 * awaiting a reply. The trigger is silence, and silence produces no event, so
 * it has to be swept for.
 *
 * Mondays 15:00 UTC, an hour after the link escalation and well after the 06:00
 * outcome sync, so a deal that closed over the weekend already carries its
 * outcome_label and is dropped before a draft is written about it. Weekly rather
 * than daily because the per-flag cooldown is measured in days: a faster cron
 * would do the same work and produce nothing.
 *
 * WRITES ARE OFF UNTIL EXPLICITLY ENABLED.
 *
 * REENGAGE_SWEEP_ENABLED must be exactly "1" for a draft to be created. Without
 * it this runs dry and reports what it would have done. That is not caution for
 * its own sake: turning this on makes unexplained drafts appear in six reps'
 * Outlook folders, which is a change they can see, and they get told before it
 * happens rather than after.
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
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const apply = process.env.REENGAGE_SWEEP_ENABLED === "1";
  try {
    const tenantId = await resolveTenantId(PILOT_TENANT_SLUG);
    const r = await runReengageSweep({ tenantId, apply });
    console.log(
      `[reengage-sweep] apply=${apply} openDeals=${r.openDeals} flagged=${r.flagged} ` +
        `drafted=${r.drafted} would=${r.would} failed=${r.failed} cappedOut=${r.cappedOut} skipped=${r.skips.length}`,
    );
    return NextResponse.json({
      ok: true,
      apply,
      openDeals: r.openDeals,
      flagged: r.flagged,
      drafted: r.drafted,
      would: r.would,
      failed: r.failed,
      cappedOut: r.cappedOut,
      // Reported, never silently dropped. A sweep that hides its skips reads as
      // "everything is handled" when it is not.
      skipped: r.skips.length,
      skipReasons: [...new Set(r.skips.map((s) => s.why))],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[reengage-sweep] failed: ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
