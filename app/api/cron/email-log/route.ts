import { NextRequest, NextResponse } from "next/server";

import { ingestMailbox } from "@/lib/email-log";
import { allowedMailboxes } from "@/lib/graph-mail";
import { autoJoinRepEmails } from "@/lib/pilot-config";
import { resolveTenantId } from "@/lib/tenant-deal-lookup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TENANT_SLUG = "magaya";
const GRAPH_TENANT = "magaya.com";
const SELLER_DOMAIN = "magaya.com";

/**
 * Keep deal_messages current.
 *
 * WHY THIS ROUTE EXISTS. `ingestMailbox` shipped with exactly one caller,
 * `scripts/ingest-email-log.ts`, run by hand. So the log grew only when someone
 * remembered, and it stopped on 2026-08-20. On 2026-08-31 every silence signal
 * was eleven days behind: `emailing_without_reply`, `losing_momentum` and
 * `invited_but_silent` all read this table, the Monday re-engagement sweep
 * drafts from those flags, and `lib/reengage-recipients.ts` now ranks recipients
 * on who has replied. A customer who wrote back on the 25th still looked silent,
 * and we would have mailed them about having gone quiet.
 *
 * That is this codebase's own failure mode wearing an ops costume: no ingest and
 * no email are indistinguishable, and the table cannot tell you which it is.
 *
 * SEVEN DAYS, NOT SIXTY. This keeps the log current; the script still owns
 * backfills. Re-reading the same week every two hours is free because the upsert
 * is keyed on (tenant_id, internet_message_id, deal_id) with ignoreDuplicates,
 * so overlap costs a no-op rather than a duplicate row.
 *
 * NO GATE, deliberately, unlike activity-report. This writes to one table we
 * own, stores no message body, sends nothing and touches no CRM. Gating it
 * behind a flag someone has to remember to set is how it came to be eleven days
 * stale in the first place.
 *
 * `allowedMailboxes()` remains the only boundary between this and every mailbox
 * in Magaya's tenant, because the Application Access Policy was declined. Rep
 * addresses are intersected with it rather than trusted from pilot config.
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

  const days = Number(process.env.EMAIL_LOG_LOOKBACK_DAYS ?? 7);
  const since = new Date(Date.now() - days * 86_400_000);

  const allowed = new Set(allowedMailboxes().map((m) => m.toLowerCase()));
  const wanted = autoJoinRepEmails().map((m) => m.toLowerCase());
  const mailboxes = wanted.filter((m) => allowed.has(m));
  const skipped = wanted.filter((m) => !allowed.has(m));

  if (mailboxes.length === 0) {
    // Named rather than returned as a quiet success. Zero mailboxes and zero new
    // messages produce the same row count, and only one of them is a problem.
    console.warn(`[email-log] no mailbox is inside GRAPH_MAIL_ALLOWED_MAILBOXES; wanted ${wanted.length}`);
    return NextResponse.json({ ok: false, reason: "no allowed mailbox", wanted: wanted.length }, { status: 200 });
  }

  try {
    const tenantId = await resolveTenantId(TENANT_SLUG);
    const totals = { read: 0, written: 0, noDeal: 0, freeMail: 0 };
    // Per-mailbox errors are collected rather than thrown. One rep's mailbox
    // failing must not cost the other five their ingest, and a run that half
    // worked has to say so rather than return ok.
    const errors: string[] = [];

    for (const mailbox of mailboxes) {
      try {
        const r = await ingestMailbox({
          tenantId,
          graphTenant: GRAPH_TENANT,
          mailbox,
          sellerDomain: SELLER_DOMAIN,
          since,
          dryRun: false,
        });
        totals.read += r.messagesRead;
        totals.written += r.rowsWritten;
        totals.noDeal += r.skippedNoDeal;
        totals.freeMail += r.skippedFreeMail;
        for (const e of r.errors) errors.push(`${mailbox}: ${e}`);
      } catch (err) {
        errors.push(`${mailbox}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    console.log(
      `[email-log] ${mailboxes.length} mailbox(es), ${days}d: read=${totals.read} written=${totals.written} ` +
        `noDeal=${totals.noDeal} freeMail=${totals.freeMail} errors=${errors.length}` +
        (skipped.length > 0 ? ` skippedNotAllowed=${skipped.length}` : ""),
    );
    return NextResponse.json({ ok: errors.length === 0, days, mailboxes: mailboxes.length, ...totals, errors });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[email-log] failed: ${message}`);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
