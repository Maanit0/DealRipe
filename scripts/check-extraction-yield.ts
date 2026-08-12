/**
 * Which captured calls produced no extraction, despite being marked extracted?
 *
 * Found on 2026-08-11. Groupe Morneau's 21,776 character transcript produced 24
 * field_extractions rows (12 Yes, 12 No), which is what a healthy extraction
 * looks like: the extractor records what it rejected as well as what it
 * confirmed. Speed International's 54,860 character transcript produced 1 row.
 * TW Customs produced 0. Both were flagged has_been_extracted = true.
 *
 * So the flag means "we tried", not "it worked", and nothing distinguished the
 * two. A deal whose qualification silently never got extracted looks identical
 * in every view to a deal whose call genuinely had nothing in it, right up until
 * a rep opens the opportunity in Rolldog and finds it empty.
 *
 * This sweeps every captured call and reports yield: transcript length against
 * rows produced. The signal is the ratio, not either number alone. A 400 char
 * no-show transcript producing nothing is fine; a 50,000 char discovery call
 * producing nothing is a lost call.
 *
 *   npx tsx scripts/check-extraction-yield.ts
 *   npx tsx scripts/check-extraction-yield.ts --days 30
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

/** Below this a transcript is too short to expect qualification from. Chosen
 *  well under TW Customs' 1,198, so nothing real is excused by it. */
const TRIVIAL_TRANSCRIPT = 800;

/** A real extraction records rejections too, so a healthy run produces rows in
 *  the tens. One or two on a substantial call means it did not evaluate. */
const SUSPICIOUS_ROWS = 3;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 45);
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const calls = await db
    .from("calls")
    .select("id, deal_id, title, scheduled_start, outcome, has_been_extracted, meeting_type")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", since)
    .lte("scheduled_start", new Date().toISOString())
    .order("scheduled_start", { ascending: false });
  if (calls.error) throw new Error(calls.error.message);

  const DEAD = new Set(["duplicate", "placeholder", "capture_failed", "discarded", "rescheduled", "no_show", "no_conversation"]);
  const live = (calls.data ?? []).filter((c) => !(c.outcome && DEAD.has(String(c.outcome))));

  const trs = await db.from("transcripts").select("call_id, body").eq("tenant_id", tenantId);
  const lenByCall = new Map(
    ((trs.data ?? []) as Array<{ call_id: string; body: string | null }>).map((t) => [t.call_id, (t.body ?? "").length]),
  );

  const fx = await db.from("field_extractions").select("deal_id, status").eq("tenant_id", tenantId);
  if (fx.error) throw new Error(fx.error.message);
  const rowsByDeal = new Map<string, number>();
  for (const f of fx.data ?? []) {
    const k = String((f as { deal_id: string }).deal_id);
    rowsByDeal.set(k, (rowsByDeal.get(k) ?? 0) + 1);
  }

  const deals = await db.from("deals").select("id, account").eq("tenant_id", tenantId);
  const nameById = new Map((deals.data ?? []).map((d) => [d.id, d.account ?? "?"]));

  const bad: Array<{ when: string; account: string; chars: number; rows: number }> = [];
  let healthy = 0;
  let trivial = 0;
  let notExtracted = 0;

  for (const c of live) {
    const chars = lenByCall.get(c.id) ?? 0;
    if (chars === 0) continue; // nothing captured; a different problem
    const rows = c.deal_id ? rowsByDeal.get(c.deal_id) ?? 0 : 0;

    // Extraction is gated on classification (transcript-sync step 5): only a
    // new_opportunity call is extracted, because deal truth must come from a
    // customer sales call and not from an internal prep meeting or a
    // post-signing kickoff. Those calls correctly produce zero rows.
    //
    // Not knowing this, an earlier version of this script reported Diamond
    // Forwarding's kickoff as a lost extraction. It was a working gate.
    if (c.meeting_type && String(c.meeting_type) !== "new_opportunity") {
      notExtracted += 1;
      continue;
    }

    if (chars < TRIVIAL_TRANSCRIPT) {
      trivial += 1;
      continue;
    }
    if (rows < SUSPICIOUS_ROWS) {
      bad.push({
        when: formatMeetingTime(c.scheduled_start),
        account: c.deal_id ? nameById.get(c.deal_id) ?? "?" : "?",
        chars,
        rows,
      });
    } else {
      healthy += 1;
    }
  }

  console.log("");
  console.log(`Last ${days} days: ${live.length} captured call(s) with a transcript.`);
  console.log(`  ${healthy} produced a normal number of extraction rows`);
  console.log(`  ${notExtracted} were not sales calls, so extraction was correctly skipped`);
  console.log(`  ${trivial} had a transcript under ${TRIVIAL_TRANSCRIPT} chars, too short to judge`);
  console.log(`  ${bad.length} produced almost nothing despite a substantial transcript`);
  console.log("");

  if (bad.length === 0) {
    console.log("No lost extractions. Speed International and TW Customs were isolated.");
    console.log("");
    return;
  }

  console.log("LOST EXTRACTIONS. Transcript captured, nothing evaluated:");
  console.log("");
  console.log(`  ${"When".padEnd(26)} ${"Deal".padEnd(22)} ${"Transcript".padStart(11)}  Rows`);
  for (const b of bad.sort((x, y) => y.chars - x.chars)) {
    console.log(`  ${b.when.padEnd(26)} ${b.account.padEnd(22)} ${String(b.chars).padStart(11)}  ${b.rows}`);
  }
  console.log("");
  console.log("Each of these is a real customer conversation whose qualification never");
  console.log("reached DealRipe, and therefore never reached the CRM. The deals look");
  console.log("normal everywhere: the call is captured, the recap went out, the flag says");
  console.log("extracted. Only the row count gives it away.");
  console.log("");
  console.log("Next: check extraction_runs for these calls to see whether a run was even");
  console.log("attempted, and whether it recorded an error, before re-running any of them.");
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
