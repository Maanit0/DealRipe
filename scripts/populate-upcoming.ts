/**
 * Populate the "Next call" data locally WITHOUT dispatching bots.
 *
 * Reads each connected rep calendar, finds upcoming pilot meetings (by domain
 * or subject), and upserts a calls row with scheduled_start so the pipeline /
 * deal UI show the next-call time and briefing-send estimate on localhost,
 * where the Vercel crons don't run.
 *
 * This does NOT create Recall bots. When the real calendar-sync cron runs
 * (deployed), it sees these rows have no bot yet and dispatches one, so this is
 * compatible with the live flow.
 *
 *   npx tsx scripts/populate-upcoming.ts            # next 7 days
 *   npx tsx scripts/populate-upcoming.ts --days 14
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import type { Json } from "../lib/database.types";
import { listUpcomingMeetings, type NormalizedMeeting } from "../lib/microsoft-graph";
import { matchPilotDomain, matchPilotSubject } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SLUG = "magaya";

function startToIso(start: NormalizedMeeting["start"]): string | null {
  if (!start) return null;
  const raw =
    start.timeZone === "UTC" && !start.dateTime.endsWith("Z")
      ? start.dateTime + "Z"
      : start.dateTime;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

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
    console.error(`connections query failed: ${conns.error.message}`);
    process.exit(1);
  }

  let wrote = 0;
  for (const c of conns.data ?? []) {
    let events;
    try {
      events = await listUpcomingMeetings(c.id, days);
    } catch (err) {
      console.warn(`skip ${c.user_principal_name ?? c.id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const ev of events) {
      if (ev.isCancelled || !ev.joinUrl) continue;
      const emails = ev.attendees.map((a) => a.email).filter((e): e is string => !!e);
      const match = matchPilotDomain(emails) ?? matchPilotSubject(ev.subject);
      if (!match) continue;
      const iso = startToIso(ev.start);
      if (!iso) continue;

      const dealRow = await db
        .from("deals")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("external_id", match.dealExternalId)
        .maybeSingle();
      if (dealRow.error || !dealRow.data) {
        console.warn(`  no deal for '${match.dealExternalId}' (event ${ev.eventId})`);
        continue;
      }

      const up = await db.from("calls").upsert(
        {
          tenant_id: tenantId,
          deal_id: dealRow.data.id,
          external_id: ev.eventId,
          call_date: iso.slice(0, 10),
          scheduled_start: iso,
          participants: ev.attendees as unknown as Json,
          source: "recall_ai",
        },
        { onConflict: "deal_id,external_id" },
      );
      if (up.error) {
        console.warn(`  upsert failed (${match.dealExternalId}): ${up.error.message}`);
        continue;
      }
      wrote += 1;
      console.log(`  ${match.dealExternalId}  ${iso}  ${ev.subject ?? ""}`);
    }
  }

  console.log("");
  console.log(`Populated ${wrote} upcoming call(s). No bots were dispatched.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
