/**
 * List upcoming meetings for every connected rep calendar (Magaya tenant),
 * with start time, subject, attendee domains, and whether the meeting matches
 * a pilot deal (i.e. the bot will auto-join it).
 *
 *   npx tsx scripts/next-meetings.ts            # next 7 days
 *   npx tsx scripts/next-meetings.ts --days 2
 *
 * Read-only. Requires Supabase + the reps' Microsoft connections.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { listUpcomingMeetings } from "../lib/microsoft-graph";
import { matchPilotDomain, matchPilotSubject } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { formatMeetingTime } from "../lib/graph-time";

const SLUG = "magaya";

/** Rendered in the rep's timezone, not the reader's. See lib/graph-time.ts. */
const fmt = (dt: string | undefined, _tz?: string | undefined): string =>
  formatMeetingTime(dt);

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const di = argv.indexOf("--days");
  const days = di !== -1 ? Number(argv[di + 1]) || 7 : 7;

  const tenantId = await resolveTenantId(SLUG);
  const db = supabaseAdmin();
  const conns = await db
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  if (conns.error) {
    console.error(`query failed: ${conns.error.message}`);
    process.exit(1);
  }

  for (const c of conns.data ?? []) {
    const upn = c.user_principal_name ?? c.id;
    console.log("");
    console.log(`=== ${upn} (next ${days} day(s)) ===`);
    let events;
    try {
      events = await listUpcomingMeetings(c.id, days);
    } catch (err) {
      console.log(`  (skipped: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const live = events
      .filter((e) => !e.isCancelled)
      .sort((a, b) => (a.start?.dateTime ?? "").localeCompare(b.start?.dateTime ?? ""));
    if (live.length === 0) {
      console.log("  (no meetings)");
      continue;
    }
    for (const e of live) {
      const emails = e.attendees.map((a) => a.email).filter((x): x is string => !!x);
      const domains = Array.from(
        new Set(emails.filter((x) => x.includes("@")).map((x) => x.split("@")[1].toLowerCase())),
      );
      const dMatch = matchPilotDomain(emails);
      const sMatch = dMatch ? null : matchPilotSubject(e.subject);
      const match = dMatch ?? sMatch;
      const via = dMatch ? "domain" : sMatch ? "subject" : "";
      const hasLink = Boolean(e.joinUrl);
      let tag = "";
      if (match) {
        tag = hasLink
          ? `  <-- PILOT (${match.dealExternalId}, via ${via}), bot will join`
          : `  <-- PILOT (${match.dealExternalId}, via ${via}) but NO TEAMS LINK, won't join`;
      }
      console.log(`  ${fmt(e.start?.dateTime, e.start?.timeZone)}  |  ${e.subject ?? "(no subject)"}  |  ${domains.join(", ") || "(none)"}  |  link: ${hasLink ? "yes" : "no"}${tag}`);
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
