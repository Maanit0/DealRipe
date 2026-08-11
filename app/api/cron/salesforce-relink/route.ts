import { NextRequest, NextResponse } from "next/server";

import { sweepSalesforceLinks } from "@/lib/salesforce-relink";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PILOT_TENANT_SLUG = "magaya";

/**
 * Periodic Salesforce link reconciliation, modelled on rolldog-relink.
 *
 * Same idea: a deal that gains an Account later still gets linked, without
 * anyone remembering to go back for it. Writes only domain-verified matches;
 * name matches and ambiguous matches are counted and returned for a human and
 * are never stored automatically.
 *
 * Linking is not writing. This establishes which Account a deal belongs to; it
 * writes nothing INTO Salesforce. That is gated separately and independently in
 * lib/salesforce-scope.ts, which is off by default.
 *
 * Same Vercel-cron bearer pattern as the other crons (CRON_SECRET), pinned to
 * the magaya tenant. Scheduled in vercel.json.
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
    const sweep = await sweepSalesforceLinks(PILOT_TENANT_SLUG, { days: 14, apply: true });
    return NextResponse.json({
      ok: true,
      ...sweep.counts,
      // Surfaced rather than logged: an unrun migration would otherwise look
      // exactly like a sweep that found nothing to link.
      schemaMissing: sweep.schemaMissing,
      // Only the rows a human has to act on. A confirmed link needs no report.
      needsAHuman: sweep.rows
        .filter((r) => r.resolution.status === "ambiguous" || r.resolution.status === "resolved_by_name")
        .map((r) => ({ account: r.account, externalId: r.externalId, detail: r.summary })),
      unavailable: sweep.rows
        .filter((r) => r.resolution.status === "lookup_failed")
        .map((r) => ({ account: r.account, detail: r.summary })),
    });
  } catch (err) {
    console.error("[cron/salesforce-relink] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
