/**
 * Fill agreement state and machine-sender onto rows that predate those columns.
 *
 *   npx tsx scripts/backfill-message-signals.ts          # dry run
 *   npx tsx scripts/backfill-message-signals.ts --apply  # WRITES
 *
 * FREE. Both signals are pure functions of columns already stored: agreement
 * state comes from the subject and machine-sender from from_email. No Graph
 * call, no rate limit, no cost. Run this before the body backfill, which is the
 * expensive one.
 *
 * WHY A SCRIPT AND NOT A RE-INGEST. lib/email-log.ts upserts with
 * ignoreDuplicates:true, so re-running the ingest will never populate a new
 * column on an existing row, and flipping it to a real upsert would rewrite
 * direction, customer_side, subject and graph_message_id on ~1900 historical
 * rows using today's rules. Every update here is by primary key and touches
 * only the new columns.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: rewrite customer_side on the EchoSign rows.
 * It is known-bad (domain-based, so echosign@echosign.com reads as the customer
 * writing to you) and lib/activity-report.ts and scripts/validate-reports.ts
 * already compensate for it. Correcting it here would silently change what both
 * of those report. is_machine_sender is the new, additive answer.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import type { Database } from "../lib/database.types";
import { agreementSignal, isMachineSender } from "../lib/meeting-state";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const PAGE = 1000;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  // Paginated. PostgREST caps a plain select at 1000 rows and says nothing
  // about it, which is how backfill-gate-events reported "would seed 1000"
  // against 2140 real rows.
  type Row = { id: string; subject: string | null; from_email: string | null; is_calendar_response: boolean };
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const res = await db
      .from("deal_messages")
      .select("id, subject, from_email, is_calendar_response")
      .eq("tenant_id", tenantId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (res.error) throw new Error(`deal_messages read failed: ${res.error.message}`);
    rows.push(...((res.data ?? []) as Row[]));
    if ((res.data ?? []).length < PAGE) break;
  }

  const { count: total } = await db
    .from("deal_messages")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  if (typeof total === "number" && total !== rows.length) {
    throw new Error(`read ${rows.length} rows but the table reports ${total}; refusing to backfill a partial set`);
  }

  let agreements = 0;
  let executed = 0;
  let machines = 0;
  let bodySkips = 0;
  type Patch = Database["public"]["Tables"]["deal_messages"]["Update"];
  const updates: Array<{ id: string; patch: Patch }> = [];

  for (const r of rows) {
    const sig = agreementSignal(r.subject);
    const machine = isMachineSender(r.from_email);
    if (sig) {
      agreements += 1;
      if (sig.executed) executed += 1;
    }
    if (machine) machines += 1;

    const patch: Patch = {
      agreement_kind: sig?.kind ?? null,
      agreement_state: sig ? (sig.executed ? "executed" : "sent") : null,
      is_machine_sender: machine,
    };
    // A machine sender or a calendar auto-response is never worth a body, so
    // mark it skipped rather than leaving it in the not_fetched queue for the
    // expensive backfill to walk past every run.
    if (machine || r.is_calendar_response) {
      patch.body_status = "skipped";
      bodySkips += 1;
    }
    updates.push({ id: r.id, patch });
  }

  console.log(`\n  deal_messages rows on magaya:  ${rows.length}`);
  console.log(`  agreement notifications:       ${agreements}   (${executed} executed, ${agreements - executed} still out)`);
  console.log(`  machine senders:               ${machines}`);
  console.log(`  marked body_status=skipped:    ${bodySkips}   <- machine or calendar, never worth a body`);

  if (!apply) {
    console.log("\n  Dry run. Re-run with --apply to write.\n");
    return;
  }

  // GROUPED, not one request per row. The first version issued 2,495 sequential
  // updates and took minutes; almost every row gets the identical patch
  // (no agreement, not a machine sender), so grouping by patch shape turns it
  // into a handful of requests. Chunked at 200 ids because a URL carrying 2,000
  // uuids in an `in.(...)` filter is rejected.
  const byShape = new Map<string, { patch: Patch; ids: string[] }>();
  for (const u of updates) {
    const key = JSON.stringify(u.patch);
    const g = byShape.get(key) ?? { patch: u.patch, ids: [] };
    g.ids.push(u.id);
    byShape.set(key, g);
  }
  console.log(`\n  ${byShape.size} distinct patch shape(s) across ${updates.length} rows`);

  let written = 0;
  let failed = 0;
  for (const g of byShape.values()) {
    for (let i = 0; i < g.ids.length; i += 200) {
      const slice = g.ids.slice(i, i + 200);
      const res = await db.from("deal_messages").update(g.patch).in("id", slice);
      if (res.error) {
        failed += slice.length;
        console.error(`  update failed (${slice.length} rows): ${res.error.message}`);
      } else written += slice.length;
    }
  }
  console.log(`\n  wrote ${written} row(s)${failed > 0 ? `, ${failed} FAILED` : ""}.`);

  // ENQUEUE THE REST FOR THE BODY BACKFILL.
  //
  // NULL body_status means "this row predates the column and has never been
  // considered". fillMissingBodies looks for 'not_fetched' or 'unavailable', so
  // without this step every historical row stays invisible to it and the body
  // backfill reports "considered: 0" and looks finished. That is a silent
  // no-op wearing the costume of a completed job.
  //
  // Filtered on body_status IS NULL so it can never walk back a row that is
  // already 'stored', 'gone' or 'skipped'.
  const enq = await db
    .from("deal_messages")
    .update({ body_status: "not_fetched" })
    .eq("tenant_id", tenantId)
    .is("body_status", null)
    .select("id");
  if (enq.error) console.error(`  enqueue failed: ${enq.error.message}`);
  else console.log(`  enqueued ${enq.data?.length ?? 0} row(s) as not_fetched for the body backfill.\n`);
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
