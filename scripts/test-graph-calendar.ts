/**
 * Microsoft Graph calendar smoke test.
 *
 * Picks the most recent microsoft_connections row for the magaya tenant,
 * lists the next 7 days of events via the Graph client, and prints one
 * line per event:
 *
 *   start | subject | attendee emails | joinUrl present yes/no
 *
 * Exits 1 with a clear message if no connection exists or the Graph
 * call fails.
 *
 * Run: npm run test:graph
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  GraphApiError,
  GraphConfigError,
  listUpcomingMeetings,
} from "../lib/microsoft-graph";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const PILOT_TENANT_SLUG = "magaya";
const DAYS = 7;

async function main(): Promise<void> {
  let tenantId: string;
  try {
    tenantId = await resolveTenantId(PILOT_TENANT_SLUG);
  } catch (err) {
    console.error(
      `Tenant '${PILOT_TENANT_SLUG}' not found. Run \`npm run seed:magaya\` first.`,
    );
    process.exit(1);
  }

  const db = supabaseAdmin();
  const conn = await db
    .from("microsoft_connections")
    .select("id, user_principal_name, last_synced_at, connected_at")
    .eq("tenant_id", tenantId)
    .order("connected_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (conn.error) {
    console.error(`Failed to query microsoft_connections: ${conn.error.message}`);
    process.exit(1);
  }
  if (!conn.data) {
    console.error(
      "No Microsoft connection found for tenant 'magaya'.\n" +
        "Run the Connect flow first at /auth/microsoft/connect, then re-run this script.",
    );
    process.exit(1);
  }

  console.log("");
  console.log(`Tenant:          ${PILOT_TENANT_SLUG}`);
  console.log(`Connection:      ${conn.data.id}`);
  console.log(`UPN:             ${conn.data.user_principal_name ?? "(unknown)"}`);
  console.log(`Connected at:    ${conn.data.connected_at}`);
  console.log(`Last synced at:  ${conn.data.last_synced_at ?? "(never)"}`);
  console.log("");
  console.log(`Listing upcoming meetings (next ${DAYS} days)...`);
  console.log("");

  let meetings;
  try {
    meetings = await listUpcomingMeetings(conn.data.id, DAYS);
  } catch (err) {
    if (err instanceof GraphApiError) {
      console.error(`Graph API error: ${err.message}`);
    } else if (err instanceof GraphConfigError) {
      console.error(`Graph config error: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`Unexpected error: ${err.message}`);
    } else {
      console.error(`Unexpected error: ${String(err)}`);
    }
    process.exit(1);
  }

  if (meetings.length === 0) {
    console.log("(no events in the window)");
    console.log("");
    return;
  }

  for (const m of meetings) {
    const start = m.start ? `${m.start.dateTime} (${m.start.timeZone})` : "(no start)";
    const subject = m.subject ?? "(no subject)";
    const attendeeEmails =
      m.attendees
        .map((a) => a.email)
        .filter((e): e is string => typeof e === "string" && e !== "")
        .join(", ") || "(none)";
    const joinPresent = m.joinUrl ? "yes" : "no";
    console.log(`${start} | ${subject} | ${attendeeEmails} | joinUrl: ${joinPresent}`);
  }
  console.log("");
  console.log(`Total: ${meetings.length} event(s)`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
