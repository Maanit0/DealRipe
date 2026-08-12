/**
 * Split call rows that collapsed a recurring series onto one row.
 *
 * calendar-sync keyed calls on iCalUId alone until 2026-08-11. That is stable
 * across mailboxes, which is what it was for, and ALSO stable across occurrences
 * of a recurring meeting. So a weekly series produced a single row: the first
 * occurrence was captured, then every later occurrence matched the same row and
 * pushed its date forward.
 *
 * The Luke Rousselle row was the giveaway. It carried a no-show transcript from
 * an earlier week and a scheduled_start of Aug 14, so it appeared in Recorded
 * and Upcoming simultaneously, and its transcript view was headed with a date
 * three days in the future.
 *
 * A collapsed row is identifiable without guessing:
 *
 *   external_id has no ":date" suffix   (keyed before the fix)
 *   a transcript exists                 (an occurrence really was captured)
 *   scheduled_start is in the future    (the date has moved past that occurrence)
 *
 * The repair points the row back at the occurrence it actually recorded, using
 * the transcript's own created_at as the evidence, and re-keys it so the next
 * calendar-sync creates a separate clean row for the upcoming occurrence rather
 * than adopting this one again.
 *
 *   npx tsx scripts/fix-recurring-call-rows.ts
 *   npx tsx scripts/fix-recurring-call-rows.ts --apply
 *
 * The transcript, bot and extraction stay exactly where they are. Only the
 * row's date and key change.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const now = new Date();

  const callsRes = await db
    .from("calls")
    .select("id, deal_id, title, external_id, scheduled_start, call_date, outcome, recall_bot_id")
    .eq("tenant_id", tenantId)
    .gt("scheduled_start", now.toISOString());
  if (callsRes.error) throw new Error(callsRes.error.message);
  const future = callsRes.data ?? [];

  if (future.length === 0) {
    console.log("\nNo future call rows at all.\n");
    return;
  }

  const trs = await db
    .from("transcripts")
    .select("call_id, body, created_at")
    .in("call_id", future.map((c) => String(c.id)));
  const trByCall = new Map(
    ((trs.data ?? []) as Array<{ call_id: string; body: string | null; created_at: string }>).map((t) => [
      t.call_id,
      { chars: (t.body ?? "").length, at: t.created_at },
    ]),
  );

  const deals = await db.from("deals").select("id, account").eq("tenant_id", tenantId);
  const dealName = new Map((deals.data ?? []).map((d) => [d.id, d.account ?? "?"]));

  // A future-dated row holding a transcript is the whole signal: a meeting that
  // has not happened cannot have a recording. Nothing else is required.
  //
  // This originally also demanded a colon-free external_id as a proxy for "keyed
  // before the fix", which excluded the Luke Rousselle row and reported the
  // system clean while the bug was on screen. A row with a null or oddly shaped
  // key is still a row claiming to hold a recording of a future call.
  //
  // The only exclusion is a row already keyed to its own date, which means it
  // has been repaired and its date is now trusted.
  const collapsed = future.filter((c) => {
    const t = trByCall.get(String(c.id));
    if (!t || t.chars === 0) return false;
    const key = String(c.external_id ?? "");
    const own = String(c.scheduled_start ?? "").slice(0, 10);
    return !(own && key.endsWith(`:${own}`));
  });

  console.log("");
  if (collapsed.length === 0) {
    console.log("No collapsed recurring rows. Every future call row is free of a transcript.\n");
    return;
  }
  console.log(`${collapsed.length} row(s) hold a transcript while dated in the future.`);
  console.log(apply ? "APPLYING." : "Dry run. Nothing will change.");
  console.log("");

  for (const c of collapsed) {
    const t = trByCall.get(String(c.id))!;
    const account = c.deal_id ? dealName.get(c.deal_id) ?? "?" : "?";
    // The transcript is persisted immediately after the bot finishes, so its
    // created_at is the closest thing we have to the occurrence that was
    // actually recorded. The row's own date has been overwritten and cannot be
    // trusted; that is the bug.
    const trueStart = t.at;
    // A null or empty key still needs to become something calendar-sync will not
    // adopt for the upcoming occurrence, so fall back to the row id.
    const base = String(c.external_id ?? "").trim() || `repaired-${c.id}`;
    const newKey = `${base}:${trueStart.slice(0, 10)}`;

    console.log(`${account}   ${String(c.title ?? "").slice(0, 46)}`);
    console.log(`   row ${c.id}`);
    console.log(`   dated       ${formatMeetingTime(c.scheduled_start)}   <- an occurrence that has not happened`);
    console.log(`   recorded    ${formatMeetingTime(trueStart)}   (${t.chars} chars, outcome=${c.outcome ?? "none"})`);
    console.log(`   re-key to   ${newKey}`);
    if (c.recall_bot_id) console.log(`   bot ${c.recall_bot_id} stays attached`);

    if (!apply) {
      console.log("");
      continue;
    }
    const upd = await db
      .from("calls")
      .update({
        scheduled_start: trueStart,
        call_date: trueStart,
        external_id: newKey,
      } as never)
      .eq("id", c.id);
    console.log(upd.error ? `   FAILED: ${upd.error.message}\n` : `   fixed\n`);
  }

  if (!apply) {
    console.log("Re-run with --apply.");
    console.log("");
    console.log("Afterwards the next calendar-sync creates a fresh row for the upcoming");
    console.log("occurrence, because the repaired row no longer matches its key. Give it a");
    console.log("cycle, then check Meetings: the call should appear once under Recorded on");
    console.log("its real date and once under Upcoming on the next one.");
    console.log("");
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
