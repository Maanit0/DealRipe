/**
 * Every call the pilot failed to capture, with Recall's own reason for each.
 *
 * These are invisible by design everywhere else. capture_failed is filtered out
 * of the Activity view, the weekly digest, impact, attendance and deal context,
 * so a lost call leaves no mark in any place a person looks. That is correct for
 * scoring (a call we failed to record should not count against a rep) and wrong
 * for operations: the two failures we know about were found by accident, days
 * later, while chasing something unrelated.
 *
 * For each failure this reports what actually happened, because the fixes have
 * nothing in common:
 *
 *   never admitted     the bot sat in a waiting room until Recall timed it out.
 *                      Usually means it arrived at the wrong time, or nobody
 *                      let it in.
 *   recorded then lost  the bot reached in_call_recording and the media is gone.
 *                      That is Recall's side and worth raising with them.
 *   never joined       the bot never got into the meeting at all: a dead join
 *                      URL, a cancelled meeting, or an account problem.
 *
 * It also reports the bot's arrival time against the scheduled start, since a
 * bot that behaves perfectly at the wrong hour is the failure mode that cost us
 * Green Java and it is invisible unless the two are printed together.
 *
 * READ ONLY.
 *
 *   npx tsx scripts/capture-failures.ts
 *   npx tsx scripts/capture-failures.ts --days 90
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getBot, type BotResource } from "../lib/recall";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { formatMeetingTime } from "../lib/graph-time";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Verdict = {
  label: string;
  detail: string;
  /** Minutes between the bot's first action and the scheduled start. */
  arrivalDelta: number | null;
};

/**
 * Read the bot's status history into one of the three failure shapes.
 *
 * An empty history is reported as unknown rather than as "never joined". Recall
 * not telling us and the bot doing nothing look identical here and are opposite
 * conclusions, and guessing produced a diagnostic that confidently misreported
 * two healthy deals once already.
 */
function classify(bot: BotResource, scheduledStart: string | null): Verdict {
  const raw = bot.raw as { status_changes?: unknown };
  const changes = Array.isArray(raw?.status_changes) ? raw.status_changes : [];
  const codes = changes
    .map((c) => (typeof c === "object" && c !== null ? (c as { code?: unknown }).code : null))
    .filter((c): c is string => typeof c === "string");

  let arrivalDelta: number | null = null;
  const startMs = scheduledStart === null ? null : Date.parse(scheduledStart);
  const first = changes[0] as { created_at?: unknown } | undefined;
  if (first && typeof first.created_at === "string" && startMs !== null && !Number.isNaN(startMs)) {
    const ms = Date.parse(first.created_at);
    if (!Number.isNaN(ms)) arrivalDelta = Math.round((ms - startMs) / 60_000);
  }

  const subCodes = changes
    .map((c) => (typeof c === "object" && c !== null ? (c as { sub_code?: unknown }).sub_code : null))
    .filter((s): s is string => typeof s === "string");
  const reason = subCodes.length > 0 ? subCodes[subCodes.length - 1] : (bot.statusSubCode ?? null);

  if (codes.length === 0) {
    return {
      label: "UNKNOWN",
      detail: "Recall returned no status history. That is a gap in what we can see, not proof the bot did nothing.",
      arrivalDelta,
    };
  }
  if (codes.includes("in_call_recording")) {
    return {
      label: "RECORDED THEN LOST",
      detail: `the bot recorded and the media is gone${reason ? ` (${reason})` : ""}. Recall's side; raise it with them citing bot ${bot.id}.`,
      arrivalDelta,
    };
  }
  if (codes.includes("in_waiting_room")) {
    return {
      label: "NEVER ADMITTED",
      detail: `sat in the waiting room and was never let in${reason ? ` (${reason})` : ""}.`,
      arrivalDelta,
    };
  }
  return {
    label: "NEVER JOINED",
    detail: `never got into the meeting${reason ? ` (${reason})` : ""}. Check the join URL and whether the meeting happened.`,
    arrivalDelta,
  };
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? "60");
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const res = await db
    .from("calls")
    .select("id, title, scheduled_start, call_date, recall_bot_id, ingest_error, organizer_email, deal_id, deals!inner(account, rep_email)")
    .eq("tenant_id", tenantId)
    .eq("outcome", "capture_failed")
    .gte("scheduled_start", since)
    .order("scheduled_start", { ascending: false });
  if (res.error) throw new Error(res.error.message);

  const rows = (res.data ?? []) as unknown as Array<{
    id: string;
    title: string | null;
    scheduled_start: string | null;
    call_date: string | null;
    recall_bot_id: string | null;
    ingest_error: string | null;
    organizer_email: string | null;
    deals: { account: string; rep_email: string | null };
  }>;

  /**
   * Whose lobby the bot was waiting in. Unrecorded is its own answer: a row
   * written before organizer_email existed cannot say, and reporting that as
   * "customer hosted" would send you to fix the wrong thing.
   */
  const hostSide = (organizer: string | null): string => {
    if (organizer === null) return "host not recorded";
    return organizer.toLowerCase().endsWith("@magaya.com")
      ? `MAGAYA hosted (${organizer})`
      : `CUSTOMER hosted (${organizer})`;
  };

  console.log(`\n${"=".repeat(78)}`);
  console.log(`CAPTURE FAILURES, last ${days} days`);
  console.log(`${"=".repeat(78)}`);

  if (rows.length === 0) {
    console.log(`\nNone. Every call in this window was captured.\n`);
    return;
  }

  const byLabel = new Map<string, number>();
  let earlyArrivals = 0;

  for (const r of rows) {
    const when = r.scheduled_start ?? r.call_date;
    console.log(`\n${r.deals.account}   ${formatMeetingTime(when)}   ${r.deals.rep_email ?? "(no rep)"}`);
    console.log(`  ${r.title ?? "(no title)"}`);
    console.log(`  ${hostSide(r.organizer_email)}`);

    if (!r.recall_bot_id) {
      console.log(`  NO BOT: the call was marked capture_failed with no bot id, so nothing was ever dispatched.`);
      byLabel.set("NO BOT", (byLabel.get("NO BOT") ?? 0) + 1);
      continue;
    }

    let bot: BotResource;
    try {
      bot = await getBot(r.recall_bot_id);
    } catch (err) {
      // Could not ask. Say so; do not fold it in with the real verdicts.
      console.log(`  COULD NOT CHECK bot ${r.recall_bot_id}: ${err instanceof Error ? err.message : String(err)}`);
      byLabel.set("COULD NOT CHECK", (byLabel.get("COULD NOT CHECK") ?? 0) + 1);
      continue;
    }

    const v = classify(bot, r.scheduled_start);
    byLabel.set(v.label, (byLabel.get(v.label) ?? 0) + 1);
    console.log(`  ${v.label}: ${v.detail}`);
    if (v.arrivalDelta !== null) {
      const early = v.arrivalDelta < -10;
      if (early) earlyArrivals++;
      console.log(
        `  bot arrived ${Math.abs(v.arrivalDelta)} min ${v.arrivalDelta < 0 ? "BEFORE" : "after"} the scheduled start` +
          (early ? "   <-- booked against a stale time" : ""),
      );
    }
    if (r.ingest_error) console.log(`  recorded reason: ${r.ingest_error}`);
  }

  // The count of failures means nothing without the denominator. Ten losses out
  // of two hundred meetings is a nuisance; ten out of twenty is the pilot not
  // working. Meetings that never had a conversation to capture are excluded from
  // both sides, since a no-show is not a capture failure.
  const allRes = await db
    .from("calls")
    .select("outcome")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", since)
    .lte("scheduled_start", new Date().toISOString());
  const NOT_ATTEMPTED = new Set(["placeholder", "duplicate", "discarded", "rescheduled", "no_show", "no_conversation"]);
  const attempted =
    allRes.error === null
      ? (allRes.data ?? []).filter((c) => !NOT_ATTEMPTED.has(String((c as { outcome: unknown }).outcome ?? ""))).length
      : null;

  console.log(`\n${"=".repeat(78)}`);
  if (attempted === null) {
    console.log(`Could not read the total call count, so no capture rate. That is not a rate of 100%.`);
  } else if (attempted > 0) {
    const rate = Math.round(((attempted - rows.length) / attempted) * 100);
    console.log(`CAPTURE RATE: ${attempted - rows.length} of ${attempted} meetings captured  (${rate}%)`);
  }
  console.log(`${rows.length} lost call(s):`);
  for (const [k, v] of [...byLabel.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(3)}  ${k}`);
  }
  if (earlyArrivals > 0) {
    console.log(
      `\n${earlyArrivals} bot(s) arrived more than 10 minutes early, which means they were booked\n` +
        `against a meeting time that later changed. That is the calendar-sync bug fixed on\n` +
        `2026-08-13; any of these from before that date are explained by it.`,
    );
  }
  console.log(`${"=".repeat(78)}\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  let cause: unknown = (e as { cause?: unknown })?.cause;
  while (cause) {
    const c = cause as { message?: string; code?: string; cause?: unknown };
    console.error(`  caused by: ${c.code ?? ""} ${c.message ?? String(cause)}`);
    cause = c.cause;
  }
  console.error("");
  process.exit(1);
});
