import { NextRequest, NextResponse } from "next/server";

import { resolveUpcomingLinks } from "@/lib/upcoming-links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PILOT_TENANT_SLUG = "magaya";

/**
 * Pre-call link resolution.
 *
 * rolldog-relink and salesforce-relink both run AFTER a call, because they were
 * built to backfill a CRM record created later. That leaves a deal with a
 * meeting on Thursday and no captured call unexamined by anything, which on
 * 2026-08-11 meant three of a newly onboarded rep's deals showed "no Rolldog
 * opportunity" two days before their calls with nothing having looked.
 *
 * This closes that. For every deal with a meeting in the next week and no
 * authorized write target, it searches Rolldog by account name, domain root,
 * name prefixes and the calendar subject, resolves Salesforce by domain then
 * address then name, stores only unambiguous matches, and records the attempt
 * either way in deal_link_attempts.
 *
 * It re-searches on a per-outcome cadence rather than sweeping everything every
 * run (see RECHECK_MS in lib/upcoming-links.ts), so the cost is roughly the
 * deals that changed rather than the whole book. Rolldog asked us to reduce API
 * load on the same day this was written; hammering their search endpoint every
 * few hours would have traded one complaint for another.
 *
 * Linking is not writing. This decides which record a deal belongs to. Whether
 * anything is written into it stays gated in lib/crm-scope.ts and
 * lib/salesforce-scope.ts.
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
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const out = await resolveUpcomingLinks({ tenantSlug: PILOT_TENANT_SLUG, days: 7, apply: true });
    const searched = out.filter((o) => !o.alreadyWritable);

    // needs_decision is surfaced rather than counted away: it is the only
    // outcome that will never resolve itself, and a number nobody reads is how
    // a deal sits unlinked until someone notices after the call.
    const needsDecision = searched
      .filter((o) => o.rolldog.status === "needs_decision" || o.salesforce.status === "needs_decision")
      .map((o) => ({
        account: o.account,
        rep: o.repEmail,
        meetingAt: o.meetingAt,
        rolldogCandidates: o.rolldog.candidates,
        salesforce: o.salesforce.note,
      }));

    return NextResponse.json({
      ok: true,
      alreadyWritable: out.length - searched.length,
      searched: searched.length,
      linked: searched.filter((o) => o.rolldog.status === "linked" || o.salesforce.status === "linked").length,
      genuinelyNew: searched.filter(
        (o) => o.rolldog.status === "no_candidates" && o.salesforce.status === "no_candidates",
      ).length,
      couldNotCheck: searched.filter(
        (o) => o.rolldog.status === "unavailable" || o.salesforce.status === "unavailable",
      ).length,
      needsDecision,
    });
  } catch (err) {
    console.error("[cron/link-resolver] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
