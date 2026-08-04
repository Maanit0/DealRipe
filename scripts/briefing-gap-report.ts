/**
 * Why did a pre-call briefing not send?
 *
 * briefing-sync only fires in a narrow window (0 < minutesUntil <= 35) and it
 * requires a calls row to already exist, because that row carries the
 * briefing_sent_at idempotency marker. calendar-sync creates that row, and both
 * crons run every 5 minutes, so they race. If the event only appears on the
 * calendar late (invite accepted last-minute, Teams link added after the fact),
 * the row is created inside or after the window and briefing-sync skips every
 * tick it had, silently.
 *
 * calls.created_at settles which failure happened, without digging in Vercel
 * logs: compare it to scheduled_start.
 *
 *   lead time > 35 min   -> the row was ready in time, so a briefing that is
 *                           still missing failed during generation or send
 *   lead time 0..35 min  -> the row landed inside the window; the briefing had
 *                           only the remaining cron ticks to fire
 *   lead time <= 0       -> the row was created after the meeting started, so a
 *                           briefing was never possible
 *
 *   npx tsx scripts/briefing-gap-report.ts
 *   npx tsx scripts/briefing-gap-report.ts --days 30 --all
 *
 * Read only. Runs on your Mac (the sandbox cannot reach Supabase).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { repName } from "../lib/display-names";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";
/** Must match LEAD_MAX_MINUTES in lib/briefing-sync.ts. */
const LEAD_MAX_MINUTES = 35;
const CRON_EVERY_MIN = 5;

function num(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  const v = Number(process.argv[i + 1]);
  return i >= 0 && Number.isFinite(v) && v > 0 ? v : fallback;
}

type Row = {
  id: string;
  external_id: string | null;
  scheduled_start: string | null;
  call_date: string | null;
  created_at: string;
  briefing_sent_at: string | null;
  title: string | null;
  meeting_type: string | null;
  deals: { account: string; external_id: string | null; rep_email: string | null } | null;
};

async function main(): Promise<void> {
  const days = num("--days", 30);
  const showAll = process.argv.includes("--all");
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data, error } = await db
    .from("calls")
    .select(
      "id, external_id, scheduled_start, call_date, created_at, briefing_sent_at, title, meeting_type, deals!inner(account, external_id, rep_email)",
    )
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", since)
    .order("scheduled_start", { ascending: false });
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as unknown as Row[];
  if (rows.length === 0) {
    console.log(`\nNo calls with a scheduled_start in the last ${days} days.\n`);
    return;
  }

  type Verdict = "sent" | "not-due" | "row-late-hard" | "row-late-soft" | "row-ready" | "no-start";
  const nowMs = Date.now();
  const verdictOf = (r: Row): { v: Verdict; leadMin: number | null } => {
    if (!r.scheduled_start) return { v: "no-start", leadMin: null };
    const lead = Math.round((Date.parse(r.scheduled_start) - Date.parse(r.created_at)) / 60_000);
    if (r.briefing_sent_at) return { v: "sent", leadMin: lead };
    // A meeting that has not started yet is PENDING, not missing. Same guard as
    // scoreStep in lib/meeting-coverage.ts. Without it every future meeting on
    // the calendar reads as a failure, which buries the real ones.
    if (Date.parse(r.scheduled_start) > nowMs) return { v: "not-due", leadMin: lead };
    if (lead <= 0) return { v: "row-late-hard", leadMin: lead };
    if (lead <= LEAD_MAX_MINUTES) return { v: "row-late-soft", leadMin: lead };
    return { v: "row-ready", leadMin: lead };
  };

  const buckets: Record<Verdict, Row[]> = {
    sent: [], "not-due": [], "row-late-hard": [], "row-late-soft": [], "row-ready": [], "no-start": [],
  };
  const leadByRow = new Map<string, number | null>();
  for (const r of rows) {
    const { v, leadMin } = verdictOf(r);
    buckets[v].push(r);
    leadByRow.set(r.id, leadMin);
  }

  const missing = rows.length - buckets.sent.length - buckets["not-due"].length;
  console.log(`\nBRIEFING GAP REPORT  .  last ${days} days  .  ${rows.length} scheduled meetings`);
  console.log(`  briefing sent:                     ${buckets.sent.length}`);
  console.log(`  not yet due (future meetings):     ${buckets["not-due"].length}`);
  console.log(`  MISSING:                           ${missing}\n`);

  const explain: Record<Exclude<Verdict, "sent">, string> = {
    "not-due": "meeting has not started yet, so no briefing is expected.",
    "row-late-hard":
      "calls row created AFTER the meeting started. A briefing was never possible.\n" +
      "    Cause: the event reached the calendar late. Fix is upstream of briefing-sync.",
    "row-late-soft":
      `calls row created INSIDE the ${LEAD_MAX_MINUTES}-min window, so briefing-sync had only\n` +
      `    the remaining ticks (one every ${CRON_EVERY_MIN} min) and lost the race.`,
    "row-ready":
      "calls row existed well before the window, so the row was NOT the problem.\n" +
      "    The send itself failed: getDealContext null, Anthropic generation, or mailer.\n" +
      "    These are the ones worth checking in the Vercel logs.",
    "no-start": "no scheduled_start on the row, so the window could not be evaluated.",
  };

  for (const v of ["row-ready", "row-late-soft", "row-late-hard", "no-start"] as const) {
    const list = buckets[v];
    if (list.length === 0) continue;
    console.log(`${v.toUpperCase()}  (${list.length})`);
    console.log(`    ${explain[v]}`);
    for (const r of list) {
      const lead = leadByRow.get(r.id) ?? null;
      const when = r.scheduled_start ? r.scheduled_start.replace("T", " ").slice(0, 16) : "(no start)";
      const rep = repName(r.deals?.rep_email ?? null);
      const leadStr = lead === null ? "n/a" : `${lead >= 0 ? "+" : ""}${lead}m lead`;
      console.log(`    ${when}  ${(r.deals?.account ?? "?").padEnd(22)} ${rep.padEnd(10)} ${leadStr.padStart(12)}  ${r.title ?? ""}`);
    }
    console.log("");
  }

  if (showAll && buckets.sent.length > 0) {
    console.log(`SENT  (${buckets.sent.length})`);
    for (const r of buckets.sent) {
      const lead = leadByRow.get(r.id) ?? null;
      const when = r.scheduled_start ? r.scheduled_start.replace("T", " ").slice(0, 16) : "";
      console.log(`    ${when}  ${(r.deals?.account ?? "?").padEnd(22)} ${lead === null ? "" : `${lead}m lead`}`);
    }
    console.log("");
  }

  // The actionable summary: which fix addresses the most misses.
  const lateTotal = buckets["row-late-hard"].length + buckets["row-late-soft"].length;
  console.log("WHAT WOULD FIX THE MOST");
  console.log(`  ${lateTotal} miss(es) caused by the calls row arriving late.`);
  console.log(`    -> briefing-sync should create the row itself instead of bailing,`);
  console.log(`       and keep a short grace period past the meeting start.`);
  console.log(`  ${buckets["row-ready"].length} miss(es) where the row was ready and the send failed.`);
  console.log(`    -> needs generation/mail error surfacing, not a window change.\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
