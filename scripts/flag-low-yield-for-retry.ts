/**
 * Hand already-captured calls with no extraction back to the retry path.
 *
 * The yield guard added to transcript-sync on 2026-08-11 only fires on a fresh
 * ingest. Calls that already went through before it existed keep their empty
 * extraction and a null ingest_error, and retryFailedExtractions finds work by
 * looking for a NON-null ingest_error, so nothing will ever pick them up.
 *
 * Speed International is the case in point: 54,860 characters of conversation on
 * a deal linked to Rolldog opportunity 81537, one extracted field, and nothing
 * written to the CRM.
 *
 * This sets ingest_error on those calls, which is the signal the existing
 * recovery loop already understands. It re-extracts from the stored transcript
 * body, capped at MAX_INGEST_RETRIES, and clears the error on success. No new
 * extraction path, no duplicate logic.
 *
 *   npx tsx scripts/flag-low-yield-for-retry.ts
 *   npx tsx scripts/flag-low-yield-for-retry.ts --apply
 *
 * Then wait for transcript-sync (every 5 minutes) or run it directly. Confirm
 * with scripts/check-extraction-yield.ts afterwards.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

/** Same thresholds as the guard in transcript-sync, deliberately. A checker
 *  that picks its own numbers will disagree with production sooner or later. */
const MIN_ROWS = 5;
const SUBSTANTIAL = 5000;

const DEAD = new Set([
  "duplicate", "placeholder", "capture_failed", "discarded", "rescheduled", "no_show", "no_conversation",
]);

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  // --clear removes a low-yield flag this script set. Speed International was
  // flagged on 2026-08-11 and turned out not to be a failure at all: the model
  // evaluated all 27 fields and answered Unknown to 26 of them, because the call
  // is a post-sale implementation session. Leaving the flag would burn three
  // retries re-asking a question already correctly answered.
  if (process.argv.includes("--clear")) {
    const res = await db
      .from("calls")
      .select("id, ingest_error")
      .eq("tenant_id", tenantId)
      .not("ingest_error", "is", null);
    const mine = (res.data ?? []).filter((c) => /low extraction yield/i.test(String(c.ingest_error ?? "")));
    console.log(`\n${mine.length} call(s) carry a low-yield flag.`);
    for (const c of mine) {
      console.log(`  ${c.id}: ${c.ingest_error}`);
      if (!apply) continue;
      const upd = await db.from("calls").update({ ingest_error: null } as never).eq("id", c.id);
      console.log(upd.error ? `    FAILED: ${upd.error.message}` : `    cleared`);
    }
    console.log(apply ? "" : "\nRe-run with --apply to clear.\n");
    return;
  }

  const callsRes = await db
    .from("calls")
    .select("id, deal_id, title, scheduled_start, outcome, meeting_type, has_been_extracted, ingest_error")
    .eq("tenant_id", tenantId);
  if (callsRes.error) throw new Error(callsRes.error.message);
  const calls = (callsRes.data ?? []).filter((c) => !(c.outcome && DEAD.has(String(c.outcome))));

  const trs = await db.from("transcripts").select("call_id, body").eq("tenant_id", tenantId);
  const lenByCall = new Map(
    ((trs.data ?? []) as Array<{ call_id: string; body: string | null }>).map((t) => [t.call_id, (t.body ?? "").length]),
  );

  const fx = await db.from("field_extractions").select("deal_id").eq("tenant_id", tenantId);
  const rowsByDeal = new Map<string, number>();
  for (const f of (fx.data ?? []) as Array<{ deal_id: string }>) {
    rowsByDeal.set(f.deal_id, (rowsByDeal.get(f.deal_id) ?? 0) + 1);
  }

  const deals = await db.from("deals").select("id, account").eq("tenant_id", tenantId);
  const name = new Map((deals.data ?? []).map((d) => [d.id, d.account ?? "?"]));

  const targets = calls.filter((c) => {
    const chars = lenByCall.get(String(c.id)) ?? 0;
    if (chars < SUBSTANTIAL) return false;
    // Extraction is gated on classification: an internal or post-signing call
    // producing nothing is the gate working, not a failure to recover.
    if (c.meeting_type && String(c.meeting_type) !== "new_opportunity") return false;
    const rows = c.deal_id ? rowsByDeal.get(String(c.deal_id)) ?? 0 : 0;
    if (rows >= MIN_ROWS) return false;
    // Already flagged: the retry loop has it, leave the counter alone.
    if (c.ingest_error) return false;
    return true;
  });

  console.log("");
  if (targets.length === 0) {
    console.log("Nothing to flag. Every substantial sales call has a real extraction.\n");
    return;
  }
  console.log(`${targets.length} call(s) captured a substantial conversation and extracted almost nothing.`);
  console.log(apply ? "APPLYING." : "Dry run.");
  console.log("");

  for (const c of targets) {
    const account = c.deal_id ? name.get(String(c.deal_id)) ?? "?" : "?";
    const chars = lenByCall.get(String(c.id)) ?? 0;
    const rows = c.deal_id ? rowsByDeal.get(String(c.deal_id)) ?? 0 : 0;
    console.log(`  ${formatMeetingTime(c.scheduled_start).padEnd(26)} ${account.padEnd(20)} ${chars} chars, ${rows} row(s)`);
    if (!apply) continue;
    const upd = await db
      .from("calls")
      .update({
        ingest_error: `low extraction yield: ${rows} row(s) from a ${chars} char transcript [retry 0/3]`,
      } as never)
      .eq("id", c.id);
    console.log(upd.error ? `    FAILED: ${upd.error.message}` : `    flagged for retry`);
  }

  console.log("");
  if (!apply) {
    console.log("Re-run with --apply.");
  } else {
    console.log("transcript-sync picks these up on its next run (every 5 minutes). It");
    console.log("re-extracts from the stored transcript, sends the recap, and writes back.");
    console.log("Confirm afterwards with scripts/check-extraction-yield.ts.");
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
