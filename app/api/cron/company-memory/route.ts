import { NextRequest, NextResponse } from "next/server";

import { backfillActivities } from "@/lib/crm-activities";
import { backfillFieldEvents } from "@/lib/crm-field-events";
import { buildCompanyContext, diffContext, lastCompanyContext, recordCompanyContext } from "@/lib/company-context";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TENANT_SLUG = "magaya";

/**
 * Keep the company's memory accumulating.
 *
 * WHY THIS ROUTE EXISTS. Three things were built and left as scripts, which
 * means they held a picture of the day someone last typed a command:
 *
 *   crm_field_events   Salesforce's own field history, 1,871 rows back to
 *                      2025-03-09. Salesforce retention is finite and the
 *                      pre-pilot baseline expires first, so a frozen copy
 *                      degrades into a frozen copy of less.
 *   crm_activities     rep-logged Task, Event and Rolldog activity, 2,200 rows
 *                      back to 2023. The only record of rep effort on the 36
 *                      deals that hold no email at all.
 *   company_context    the memory bank itself. A series that only grows when
 *                      someone runs a command is not a series, and the whole
 *                      argument for keeping it was that the interesting
 *                      questions are about CHANGE.
 *
 * DAILY, NOT HOURLY, and separate from the mail job. These are Salesforce and
 * Rolldog reads: field history and activity move on the scale of a rep updating
 * a record, not of a mailbox. Bolting them onto email-log would triple that
 * route's third-party surface for no extra freshness.
 *
 * ORDER MATTERS. The two backfills run first and the context snapshot last, so
 * the snapshot always describes a book that has already been refreshed. A
 * snapshot taken before the refresh would record yesterday's CRM as today's
 * fact, and this table's entire purpose is being trustworthy about what was
 * true when.
 *
 * EVERY STEP IS INDEPENDENTLY FAILABLE. A Salesforce outage must not cost the
 * Rolldog pull or the snapshot: each is caught, named in the response, and the
 * others continue. A run that half worked says so rather than returning ok.
 */
export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "CRON_SECRET is not set" }, { status: 500 });
  if ((req.headers.get("authorization") ?? "") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const errors: string[] = [];
  const out: Record<string, unknown> = {};

  try {
    const tenantId = await resolveTenantId(TENANT_SLUG);

    // 1. Salesforce field history. Idempotent on
    // (source_system, opportunity_id, field, changed_at), so a daily re-read of
    // an overlapping window writes only what is new.
    try {
      const r = await backfillFieldEvents({ tenantId });
      out.crmFieldEvents = { read: r.rowsRead, written: r.written, oldest: r.oldest, newest: r.newest };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      errors.push(`crm_field_events: ${m}`);
      out.crmFieldEvents = { failed: m };
    }

    // 2. Rep-logged CRM activity, same idempotency shape.
    try {
      const r = await backfillActivities({ tenantId });
      out.crmActivities = {
        salesforce: r.salesforce.read,
        rolldog: r.rolldog.read,
        written: r.written,
        // Named rather than swallowed: an unreadable opportunity is not an
        // opportunity with no activity.
        opportunitiesUnavailable: r.rolldog.opportunitiesUnavailable,
      };
      for (const e of r.errors.slice(0, 3)) errors.push(`crm_activities: ${e}`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      errors.push(`crm_activities: ${m}`);
      out.crmActivities = { failed: m };
    }

    // 3. The snapshot, last, so it describes a refreshed book. The diff is
    // taken against the PREVIOUS stored snapshot before this one is written,
    // which is what turns a pile of readings into a trajectory.
    try {
      const prev = await lastCompanyContext(tenantId);
      const ctx = await buildCompanyContext(tenantId, TENANT_SLUG);
      const id = await recordCompanyContext(tenantId, ctx);
      const changes = prev ? diffContext(prev, ctx) : [];
      out.companyContext = {
        snapshot: id,
        firstEver: !prev,
        changed: changes.length,
        // The paths only. Values can carry distributions and this response goes
        // to a log; the payload itself is in the table for anyone who needs it.
        changedPaths: changes.slice(0, 25).map((c) => c.path),
      };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      errors.push(`company_context: ${m}`);
      out.companyContext = { failed: m };
    }

    console.log(`[company-memory] ${JSON.stringify(out)} errors=${errors.length}`);
    return NextResponse.json({ ok: errors.length === 0, ...out, errors });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[company-memory] failed: ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
