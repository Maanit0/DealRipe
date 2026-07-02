/**
 * Find a rep's next upcoming meeting that matches a customer domain and
 * dispatch the DealRipe Notetaker (Recall bot) to it. Pulls the Teams
 * join URL straight from the connected calendar, so no copy-paste needed.
 *
 *   npx tsx scripts/join-meeting-by-domain.ts aquagulf.com
 *   npx tsx scripts/join-meeting-by-domain.ts aquagulf.com --upn ebencomo@magaya.com
 *
 * If no meeting matches the domain, it lists every upcoming meeting so you
 * can see what's on the calendar and grab a URL manually.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  GraphApiError,
  GraphConfigError,
  listUpcomingMeetings,
  type NormalizedMeeting,
} from "../lib/microsoft-graph";
import { createBot } from "../lib/recall";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const PILOT_TENANT_SLUG = "magaya";
const LOOKAHEAD_DAYS = 1;

function meetingMatchesDomain(m: NormalizedMeeting, domain: string): boolean {
  const d = domain.toLowerCase();
  if ((m.subject ?? "").toLowerCase().includes(d)) return true;
  if ((m.organizerEmail ?? "").toLowerCase().includes(d)) return true;
  for (const a of m.attendees) {
    if ((a.email ?? "").toLowerCase().includes(d)) return true;
  }
  return false;
}

function domainsOf(m: NormalizedMeeting): string {
  const emails = [m.organizerEmail, ...m.attendees.map((a) => a.email)]
    .filter((e): e is string => typeof e === "string" && e.includes("@"))
    .map((e) => e.split("@")[1].toLowerCase());
  return Array.from(new Set(emails)).join(", ") || "(none)";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const domain = argv.find((a) => !a.startsWith("--"));
  const upnIdx = argv.indexOf("--upn");
  const upn = upnIdx !== -1 ? argv[upnIdx + 1] : null;

  if (!domain) {
    console.error("Usage: npx tsx scripts/join-meeting-by-domain.ts <domain> [--upn <upn>]");
    process.exit(1);
  }
  if (!process.env.RECALL_API_KEY) {
    console.error("RECALL_API_KEY is not set in .env.local.");
    process.exit(1);
  }

  const tenantId = await resolveTenantId(PILOT_TENANT_SLUG);
  const db = supabaseAdmin();

  let q = db
    .from("microsoft_connections")
    .select("id, user_principal_name, connected_at")
    .eq("tenant_id", tenantId)
    .order("connected_at", { ascending: false });
  if (upn) q = q.eq("user_principal_name", upn);

  const conn = await q.limit(1).maybeSingle();
  if (conn.error) {
    console.error(`Failed to read microsoft_connections: ${conn.error.message}`);
    process.exit(1);
  }
  if (!conn.data) {
    console.error(upn ? `No connection for UPN ${upn}.` : "No connections found for magaya.");
    process.exit(1);
  }

  console.log("");
  console.log(`Rep calendar:   ${conn.data.user_principal_name ?? conn.data.id}`);
  console.log(`Looking for:    a meeting involving "${domain}" in the next ${LOOKAHEAD_DAYS} day(s)`);
  console.log("");

  let meetings: NormalizedMeeting[];
  try {
    meetings = await listUpcomingMeetings(conn.data.id, LOOKAHEAD_DAYS);
  } catch (err) {
    if (err instanceof GraphApiError) console.error(`Graph API error: ${err.message}`);
    else if (err instanceof GraphConfigError) console.error(`Graph config error: ${err.message}`);
    else console.error(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const live = meetings.filter((m) => !m.isCancelled);
  const matches = live
    .filter((m) => meetingMatchesDomain(m, domain) && m.joinUrl)
    .sort((a, b) => (a.start?.dateTime ?? "").localeCompare(b.start?.dateTime ?? ""));

  if (matches.length === 0) {
    console.log(`No upcoming meeting matched "${domain}" with a join link. Here's what's on the calendar:`);
    console.log("");
    for (const m of live) {
      const start = m.start ? m.start.dateTime : "(no start)";
      console.log(`  ${start} | ${m.subject ?? "(no subject)"} | domains: ${domainsOf(m)} | joinUrl: ${m.joinUrl ? "yes" : "no"}`);
    }
    console.log("");
    console.log("If the meeting is there, re-run with a domain that appears above, or dispatch by URL:");
    console.log('  npx tsx scripts/test-recall-bot.ts "<teams-join-url>"');
    process.exit(1);
  }

  const target = matches[0];
  console.log("Dispatching DealRipe Notetaker to:");
  console.log(`  Subject: ${target.subject ?? "(no subject)"}`);
  console.log(`  Start:   ${target.start ? target.start.dateTime + " (" + target.start.timeZone + ")" : "(unknown)"}`);
  console.log(`  Domains: ${domainsOf(target)}`);
  console.log("");

  const bot = await createBot({ meetingUrl: target.joinUrl! });
  console.log(`  Bot dispatched. botId: ${bot.id}`);
  console.log("");
  console.log('  It will appear in the meeting as "DealRipe Notetaker".');
  console.log("  Have the rep ADMIT it from the Teams lobby.");
  console.log("");
  console.log("  After the call, pull the transcript with:");
  console.log(`    npx tsx scripts/test-recall-bot.ts --bot-id ${bot.id}`);
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
