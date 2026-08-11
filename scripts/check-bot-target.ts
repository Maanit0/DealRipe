/**
 * Is the bot pointed at the meeting the rep will actually be in?
 *
 * A bot exists and a bot is in the right room are different facts, and every
 * dashboard we have shows only the first. When a rep holds a placeholder and
 * then accepts a confirmed invite for the same slot, we end up with two call
 * rows, and the bot may be attached to the one nobody is going to join. Nothing
 * errors. The bot dials a dead link, the call is never captured, and the first
 * sign of trouble is a rep asking where their recap is.
 *
 * So this compares, for one rep's upcoming meetings, the URL Recall is dialing
 * against the join URLs currently on that rep's calendar.
 *
 *   npx tsx scripts/check-bot-target.ts --rep asuntrup@magaya.com
 *   npx tsx scripts/check-bot-target.ts --rep asuntrup@magaya.com --days 1
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime, graphIso } from "../lib/graph-time";
import { listUpcomingMeetings } from "../lib/microsoft-graph";
import { getBot } from "../lib/recall";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Teams join URLs carry a stable conference id; compare on that, not on the
 *  whole string, because tenant and tracking query params differ per copy of
 *  the same invite. */
function conferenceKey(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /19%3ameeting_[A-Za-z0-9_-]+|19:meeting_[A-Za-z0-9_-]+/.exec(url);
  if (m) return m[0].toLowerCase().replace("%3a", ":");
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.toLowerCase();
  } catch {
    return url.slice(0, 80).toLowerCase();
  }
}

/**
 * What Recall says about a bot.
 *
 * The first version of this returned a bare `string | null`, and the caller
 * rendered null as "DIFFERENT MEETING URL". So a parse failure printed as a
 * confident claim that eight bots were dialing the wrong meetings, including
 * ones whose titles matched their calendar entries exactly. In a script whose
 * entire purpose was to separate "did not check" from "no". Hence the explicit
 * `unparsed` case: if we cannot read a URL out of the payload we say so, and we
 * print the keys we did get so the next person can fix the parser.
 */
type BotTarget =
  | { kind: "url"; value: string }
  | { kind: "unparsed"; keys: string[] }
  | { kind: "error"; message: string };

/** Recall renders meeting_url as a plain string on some platforms and as an
 *  object (meeting_id, tenant_id, organizer_id) on Teams. Handle both. */
function meetingUrlFrom(raw: unknown): BotTarget {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const u = obj.meeting_url;
  if (typeof u === "string" && u.length > 0) return { kind: "url", value: u };
  if (u && typeof u === "object") {
    const o = u as Record<string, unknown>;
    // Order matters. On Teams, `thread_id` carries the 19:meeting_...@thread.v2
    // conference id, which is the thing a calendar join URL also contains and
    // therefore the only field here that is comparable. `meeting_id` exists but
    // came back non-string on every live bot, which is what made the first
    // version report "unparsed" for all eight.
    for (const k of ["thread_id", "meeting_id", "url", "join_url"]) {
      const v = o[k];
      if (typeof v === "string" && v.length > 0) return { kind: "url", value: v };
    }
    return { kind: "unparsed", keys: Object.keys(o).map((k) => `meeting_url.${k}`) };
  }
  return { kind: "unparsed", keys: Object.keys(obj).slice(0, 14) };
}

async function main(): Promise<void> {
  const rep = arg("--rep")?.toLowerCase();
  const days = Number(arg("--days") ?? 1);
  if (!rep) {
    console.log("\nUsage: --rep <email> [--days N]\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const conn = await db
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  if (conn.error) throw new Error(conn.error.message);
  const mine = (conn.data ?? []).find((c) => (c.user_principal_name ?? "").toLowerCase() === rep);
  if (!mine) {
    console.log(`\nNo Microsoft connection for ${rep}.\n`);
    process.exit(1);
  }

  const meetings = await listUpcomingMeetings(mine.id, days);

  const horizon = new Date(Date.now() + days * 86_400_000).toISOString();
  const calls = await db
    .from("calls")
    .select("id, title, scheduled_start, recall_bot_id, deal_id")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", new Date().toISOString())
    .lte("scheduled_start", horizon);
  if (calls.error) throw new Error(calls.error.message);

  console.log("");
  console.log(`${rep}, next ${days} day(s)`);
  console.log("");

  for (const m of meetings) {
    if (!m.joinUrl) continue;
    const startIso = graphIso(m.start?.dateTime);
    const calendarKey = conferenceKey(m.joinUrl);

    // Compare instants, never strings. Supabase renders a timestamptz as
    // "...+00:00" and graphIso renders "...Z"; both are the same moment and
    // string equality says they are not. That mismatch made this script report
    // "0 call rows" for meetings that check-duplicate-bots had just listed two
    // rows for, which is the exact class of confidently wrong diagnostic this
    // codebase keeps producing.
    const target = startIso ? Date.parse(startIso) : NaN;
    const atSlot = (calls.data ?? []).filter((c) => {
      const t = c.scheduled_start ? Date.parse(c.scheduled_start) : NaN;
      return Number.isFinite(t) && Number.isFinite(target) && t === target;
    });
    const botted = atSlot.filter((c) => c.recall_bot_id);

    console.log(`${formatMeetingTime(m.start?.dateTime)}   ${(m.subject ?? "(untitled)").slice(0, 58)}`);

    if (botted.length === 0) {
      console.log(`   NO BOT for this calendar entry (${atSlot.length} call row(s) at this time).`);
      console.log("");
      continue;
    }

    for (const c of botted) {
      const id = String(c.recall_bot_id);
      let bot;
      try {
        bot = await getBot(id);
      } catch (e) {
        console.log(`   bot ${id.slice(0, 8)}  COULD NOT READ Recall: ${e instanceof Error ? e.message : String(e)}`);
        console.log(`      Not a verdict. We did not check.`);
        continue;
      }

      // Live status settles it for a call in progress far better than any URL
      // comparison: a bot that is recording is, definitionally, in the room.
      console.log(`   bot ${id.slice(0, 8)}  status ${bot.status} (${bot.rawStatusCode})  row: ${(c.title ?? "").slice(0, 36)}`);

      const target = meetingUrlFrom(bot.raw);
      if (target.kind === "unparsed") {
        console.log(`      meeting URL not readable from Recall's payload; keys seen: ${target.keys.join(", ") || "(none)"}`);
        console.log(`      This says nothing about whether the bot is in the right meeting.`);
        continue;
      }
      if (target.kind === "error") {
        console.log(`      ${target.message}`);
        continue;
      }
      const botKey = conferenceKey(target.value);
      if (!botKey || !calendarKey) {
        console.log(`      could not derive a comparable conference id, so no verdict.`);
        continue;
      }
      console.log(`      ${botKey === calendarKey ? "TARGETS THIS MEETING" : "DIFFERENT MEETING"}`);
      if (botKey !== calendarKey) {
        console.log(`      calendar ${calendarKey}`);
        console.log(`      bot      ${botKey}`);
      }
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
