/**
 * Which calls were lost to an outage rather than to their own content.
 *
 * On 2026-08-16 the Anthropic key ran out of credit. Extraction, briefings and
 * recaps all run on it. transcript-sync persists the transcript before
 * extraction, so no conversation was lost, but MAX_INGEST_RETRIES is 3 at one
 * retry per five-minute run: a call captured during the outage exhausts its
 * budget in about fifteen minutes, is marked gave-up, and nothing recovers it.
 *
 * The distinction this script exists to make: a 400 saying the credit balance
 * is too low is not the call's fault. A malformed transcript is. Those deserve
 * opposite treatment and the pipeline currently treats them identically, which
 * is the same error as reading an empty attendee list as "no external
 * attendees". So failures are sorted into recoverable and content, and only the
 * recoverable ones are offered for reset.
 *
 * Read-only without --apply.
 *
 *   npx tsx scripts/ingest-casualties.ts
 *   npx tsx scripts/ingest-casualties.ts --days 3
 *   npx tsx scripts/ingest-casualties.ts --apply     # clears the marker
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { formatMeetingTime } from "../lib/graph-time";

/** Failures caused by us or by a provider, never by the conversation. */
const RECOVERABLE =
  /credit balance|insufficient_quota|rate.?limit|429|500|502|503|504|overloaded|timeout|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed|invalid_request_error: Your credit/i;

/** A run that was killed rather than one that reported a result. */
const KILLED = /attempt started; the run did not report a result/i;

/**
 * Capture never happened, so there is nothing to re-run. A third category on
 * purpose: these are not our outage and not the conversation's fault, and the
 * remedy is different. Re-inviting the bot or pulling the host's own Teams
 * transcript recovers these; clearing an error does not.
 */
const CAPTURE =
  /media unavailable|no media|waiting.?room|not admitted|bot_kicked|meeting_not_accessible|timeout_exceeded|never joined|no transcript/i;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? "1");
  const apply = process.argv.includes("--apply");
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const res = await db
    .from("calls")
    .select("*")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", since)
    .order("scheduled_start", { ascending: false });
  if (res.error) throw new Error(res.error.message);

  const rows = (res.data ?? []) as Array<Record<string, unknown>>;
  const failed = rows.filter((r) => {
    const err = String(r.ingest_error ?? "");
    return err.length > 0;
  });

  console.log(`\nLast ${days} day(s): ${rows.length} call(s), ${failed.length} carrying an ingest_error.`);

  if (failed.length === 0) {
    console.log(`\nNothing to recover. Note this is "no failures recorded", not proof every`);
    console.log(`call processed: a call whose bot has not finished carries no error yet.\n`);
    return;
  }

  // Print the shape of one failed row once. Retry accounting may live in a
  // column rather than in the error text, and guessing which would be the same
  // mistake this script is about.
  const sample = failed[0];
  const shape = Object.entries(sample)
    .filter(([k, v]) => v !== null && /retry|retries|attempt|ingest|extract|status/i.test(k))
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
  if (shape.length > 0) {
    console.log(`\nRetry-related columns on a failed row: ${shape.join("  ")}`);
    console.log(`If retries are counted in a column rather than in ingest_error, clearing the`);
    console.log(`error alone will not restore the budget. Check the above before trusting --apply.`);
  }

  const recoverable: Array<Record<string, unknown>> = [];
  const capture: Array<Record<string, unknown>> = [];
  const content: Array<Record<string, unknown>> = [];

  for (const r of failed) {
    const err = String(r.ingest_error ?? "");
    // Capture is tested first: "no media" is a capture failure even though the
    // word timeout appears in it, and treating it as recoverable would queue a
    // re-run that can never succeed.
    if (CAPTURE.test(err)) capture.push(r);
    else if (RECOVERABLE.test(err) || KILLED.test(err)) recoverable.push(r);
    else content.push(r);
  }

  const show = async (label: string, list: Array<Record<string, unknown>>, note: string) => {
    if (list.length === 0) return;
    console.log(`\n${"=".repeat(80)}\n${label}  (${list.length})\n${note}\n${"=".repeat(80)}`);
    for (const r of list) {
      const callId = String(r.id);
      const t = await db.from("transcripts").select("id").eq("call_id", callId).maybeSingle();
      const hasTranscript = Boolean(t.data);
      console.log(`\n${String(r.title ?? "(no title)")}`);
      console.log(`  when       ${formatMeetingTime(String(r.scheduled_start ?? r.call_date ?? ""))}`);
      console.log(`  call id    ${callId}`);
      console.log(`  outcome    ${String(r.outcome ?? "(none)")}`);
      console.log(`  transcript ${hasTranscript ? "stored, so this is fully recoverable" : "NOT stored; re-running will not help"}`);
      console.log(`  error      ${String(r.ingest_error ?? "").slice(0, 220)}`);
    }
  };

  await show(
    "LOST TO THE OUTAGE, NOT TO THEIR CONTENT",
    recoverable,
    "Provider, billing, timeout or a killed run. These should never have consumed a retry.",
  );
  await show(
    "NEVER CAPTURED",
    capture,
    "The bot was refused, or the media never arrived. Re-running extraction cannot help.\n" +
      "The remedy is re-inviting the bot, or the host's own Teams recording.",
  );
  await show(
    "FAILED ON THEIR OWN CONTENT",
    content,
    "A human should look at these. Do not bulk reset them.",
  );

  if (recoverable.length === 0) {
    console.log(`\nNo outage-attributable failures in this window.\n`);
    return;
  }

  if (!apply) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`Dry run. --apply clears ingest_error on the ${recoverable.length} recoverable call(s)`);
    console.log(`so the next transcript-sync picks them up. It touches nothing else, and it does`);
    console.log(`not reset any retry counter that lives in its own column.\n`);
    return;
  }

  for (const r of recoverable) {
    const upd = await db.from("calls").update({ ingest_error: null }).eq("id", String(r.id));
    console.log(
      upd.error
        ? `  FAILED ${String(r.title)}: ${upd.error.message}`
        : `  cleared ${String(r.title)}`,
    );
  }
  console.log(`\nCleared. Watch the next transcript-sync run rather than assuming it took.\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
