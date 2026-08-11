/**
 * Is call_subtype actually being written?
 *
 * The pre-call prediction leans hardest on what previous calls on a deal turned
 * out to be: a deal whose last call was a proposal is not back at discovery. But
 * every deal in today's readiness run reported "no call history", while the Bee
 * Imagine card plainly showed a "Follow-up" subtype. Both cannot be generally
 * true, so either these deals really are all first calls or the column is being
 * written unreliably, and those need completely different responses.
 *
 * So this counts, over captured calls only:
 *
 *   SET        subtype written, and which values
 *   MISSING    captured and extracted, no subtype. This is the bug case.
 *   N/A        no transcript, so nothing could have classified it
 *
 * Counting MISSING against ALL calls rather than captured ones would bury the
 * signal under no-shows and future meetings, and make a real gap look like
 * normal background.
 *
 *   npx tsx scripts/check-subtype-coverage.ts
 *   npx tsx scripts/check-subtype-coverage.ts --days 60
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 45);
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const calls = await db
    .from("calls")
    .select("id, deal_id, title, scheduled_start, outcome, has_been_extracted, meeting_type, call_subtype")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", since)
    .lte("scheduled_start", new Date().toISOString())
    .order("scheduled_start", { ascending: false });
  if (calls.error) throw new Error(calls.error.message);

  const trs = await db.from("transcripts").select("call_id").eq("tenant_id", tenantId);
  const haveTranscript = new Set((trs.data ?? []).map((t) => String(t.call_id)));

  const deals = await db.from("deals").select("id, account").eq("tenant_id", tenantId);
  const dealName = new Map((deals.data ?? []).map((d) => [d.id, d.account ?? "?"]));

  // A no-show bot still writes a transcript row, so the presence of one is not
  // evidence that anyone spoke. Counting those as captured made five no-shows
  // look like a classification gap, which is the same shape of error as reading
  // an unticked checkbox as a recorded "no": the record exists, it just does not
  // say what it appears to say.
  const NO_CONTENT = new Set([
    "no_conversation",
    "no_show",
    "rescheduled",
    "placeholder",
    "capture_failed",
    "discarded",
    "duplicate",
  ]);
  const rows = calls.data ?? [];
  const noContent = rows.filter((c) => c.outcome && NO_CONTENT.has(String(c.outcome)));
  const captured = rows.filter(
    (c) =>
      !(c.outcome && NO_CONTENT.has(String(c.outcome))) &&
      (haveTranscript.has(c.id) || c.outcome === "captured" || c.has_been_extracted),
  );

  const withSub = captured.filter((c) => c.call_subtype);
  const missing = captured.filter((c) => !c.call_subtype);

  const byValue = new Map<string, number>();
  for (const c of withSub) {
    const k = String(c.call_subtype);
    byValue.set(k, (byValue.get(k) ?? 0) + 1);
  }

  console.log("");
  console.log(
    `Last ${days} days: ${rows.length} call row(s), ${captured.length} captured, ${noContent.length} no-show or otherwise no conversation.`,
  );
  console.log("");
  console.log(`  subtype set      ${withSub.length}`);
  console.log(`  subtype MISSING  ${missing.length}`);
  if (trs.error) {
    console.log(`  (transcripts table unreadable, so "captured" is based on outcome and extraction alone)`);
  }
  console.log("");

  if (byValue.size > 0) {
    console.log(`Values seen:`);
    for (const [k, n] of [...byValue.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(14)} ${n}`);
    }
    console.log("");
  }

  if (missing.length > 0) {
    console.log(`Captured calls with NO subtype. classifyCallSubtype either did not run or`);
    console.log(`its result was dropped. Each of these is a deal whose next prediction will`);
    console.log(`say "no call history":`);
    console.log("");
    for (const c of missing.slice(0, 20)) {
      console.log(
        `  ${formatMeetingTime(c.scheduled_start).padEnd(26)} ${(dealName.get(c.deal_id) ?? "?").padEnd(20)} outcome=${(c.outcome ?? "(none)").padEnd(14)} type=${c.meeting_type ?? "(null)"}`,
      );
    }
    if (missing.length > 20) console.log(`  ... and ${missing.length - 20} more`);
    console.log("");
    console.log(`transcript-sync writes meeting_type and call_subtype in ONE update, so:`);
    console.log(`  type set, subtype null   -> the subtype classifier returned null`);
    console.log(`  BOTH null                -> classification never ran on this call at all`);
    console.log(`The second is the more serious one and is worth tracing per call.`);
  } else if (captured.length > 0) {
    console.log(`Every captured call has a subtype. The "no call history" in the readiness`);
    console.log(`run means these deals genuinely have no earlier captured call, which is`);
    console.log(`expected for a pilot that widened to six reps yesterday.`);
  } else {
    console.log(`No captured calls in this window, so this says nothing either way.`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
