import { NextRequest, NextResponse } from "next/server";

import { sweepAndEscalate } from "@/lib/link-escalation";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PILOT_TENANT_SLUG = "magaya";

/**
 * Weekly account-linking sweep and escalation.
 *
 * Mondays at 14:00 UTC, which is morning in Central where Magaya works, so a
 * rep opens the week with the list rather than getting it on a Friday evening.
 * Weekly rather than hourly on purpose: the escalation's own cooldown is seven
 * days, so a faster cron would do the same work and send nothing.
 *
 * Deals that link themselves are handled continuously by the relink cron. This
 * exists for the residue that needs a person.
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
  try {
    const tenantId = await resolveTenantId(PILOT_TENANT_SLUG);
    const counts = await sweepAndEscalate({ tenantId, apply: true });
    return NextResponse.json({ ok: true, counts });
  } catch (err) {
    console.error("[cron/link-escalation] error:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
