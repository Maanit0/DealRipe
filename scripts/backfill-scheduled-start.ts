/**
 * Backfill scheduled_start on existing calls rows that are missing it.
 *
 * The add-scheduled-start migration added the column as nullable and did not
 * backfill, so any calls row written before it (e.g. by an early calendar-sync
 * that created a bot) has scheduled_start = null. The deal UI hides null-start
 * rows, so those meetings showed as "none scheduled". This reads each connected
 * calendar, matches pilot meetings, and stamps the real start onto any existing
 * row whose scheduled_start is still null.
 *
 * Read-then-write, best-effort, idempotent. Rows that already have a start are
 * left untouched. Doubles as a diagnostic: it prints every matched event and
 * whether a null-start row existed for it.
 *
 *   npx tsx scripts/backfill-scheduled-start.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

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
  const days = di !== -1 ? Number(argv[di + 1]) || 14 : 14;

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

  let filled = 0;
  let alreadySet = 0;
  let noRow = 0;
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
      if (dealRow.error || !dealRow.data) continue;

      const existing = await db
        .from("calls")
        .select("id, scheduled_start")
        .eq("deal_id", dealRow.data.id)
        .eq("external_id", ev.eventId)
        .maybeSingle();
      if (existing.error) {
        console.warn(`  ${match.dealExternalId}: calls lookup failed: ${existing.error.message}`);
        continue;
      }
      if (!existing.data) {
        noRow += 1;
        console.log(`  ${match.dealExternalId}: no calls row for event yet (${ev.subject ?? ""})`);
        continue;
      }
      if (existing.data.scheduled_start) {
        alreadySet += 1;
        continue;
      }

      const upd = await db
        .from("calls")
        .update({ scheduled_start: iso })
        .eq("id", existing.data.id);
      if (upd.error) {
        console.warn(`  ${match.dealExternalId}: update failed: ${upd.error.message}`);
        continue;
      }
      filled += 1;
      console.log(`  filled ${match.dealExternalId}  ${iso}  ${ev.subject ?? ""}`);
    }
  }

  console.log("");
  console.log(`Backfilled ${filled} row(s). ${alreadySet} already had a start, ${noRow} matched events had no row yet.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
