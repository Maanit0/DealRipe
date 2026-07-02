/**
 * Microsoft Graph calendar smoke test.
 *
 * By default, picks the most recent microsoft_connections row for the
 * magaya tenant. Pass --upn <email> to select a specific user's
 * connection instead (case-insensitive match on user_principal_name).
 *
 * Prints one line per event in the window:
 *   start | subject | attendee emails | joinUrl present yes/no
 *
 * Exits 1 with a clear message if no connection exists or the Graph
 * call fails.
 *
 * Run: npm run test:graph
 *      npm run test:graph -- --upn elosada@magaya.com
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

function parseArgs(argv: string[]): { upn: string | null } {
  let upn: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--upn") {
      const v = argv[i + 1];
      if (!v) {
        console.error("--upn requires an email argument (e.g. --upn elosada@magaya.com)");
        process.exit(1);
      }
      upn = v;
      i++;
    } else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(1);
    }
  }
  return { upn };
}

async function main(): Promise<void> {
  const { upn } = parseArgs(process.argv.slice(2));

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
  // If --upn was passed, select that specific connection (case-insensitive
  // on user_principal_name, since Microsoft normalizes to lowercase but
  // callers may type mixed case). Otherwise fall back to the most
  // recently-connected user for the tenant (existing default).
  const baseQuery = db
    .from("microsoft_connections")
    .select("id, user_principal_name, last_synced_at, connected_at")
    .eq("tenant_id", tenantId)
    .order("connected_at", { ascending: false })
    .limit(1);
  const conn = upn
    ? await baseQuery.ilike("user_principal_name", upn).maybeSingle()
    : await baseQuery.maybeSingle();

  if (conn.error) {
    console.error(`Failed to query microsoft_connections: ${conn.error.message}`);
    process.exit(1);
  }
  if (!conn.data) {
    if (upn) {
      console.error(
        `No Microsoft connection found for '${upn}' in tenant 'magaya'.\n` +
          "That user needs to complete /auth/microsoft/connect first.",
      );
    } else {
      console.error(
        "No Microsoft connection found for tenant 'magaya'.\n" +
          "Run the Connect flow first at /auth/microsoft/connect, then re-run this script.",
      );
    }
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
