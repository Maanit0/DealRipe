/**
 * Read-only preview of what auto-join WOULD do. Creates nothing, joins nothing.
 * For every connected calendar it lists the external customer meetings and
 * shows, per meeting, whether it's already a pilot deal or would be
 * auto-created (and the deal it would create). Internal-only meetings are
 * counted but not listed.
 *
 * Run this BEFORE enabling auto-join (AUTO_JOIN_REP_EMAILS env) to confirm it
 * picks the right calls and skips internal ones.
 *
 *   npx tsx scripts/preview-auto-join.ts            # next 14 days
 *   npx tsx scripts/preview-auto-join.ts --days 7
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { listUpcomingMeetings } from "../lib/microsoft-graph";
import {
  accountFromDomain,
  autoDealExternalId,
  firstExternalDomain,
  isAutoJoinRep,
  matchPilotDomain,
  matchPilotSubject,
} from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SLUG = "magaya";

function fmt(dt: string | undefined, tz: string | undefined): string {
  if (!dt) return "(no start)";
  const raw = tz === "UTC" && !dt.endsWith("Z") ? dt + "Z" : dt;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return dt;
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

  for (const c of conns.data ?? []) {
    const upn = c.user_principal_name ?? c.id;
    const auto = isAutoJoinRep(c.user_principal_name);
    console.log("");
    console.log(`=== ${upn} — auto-join currently ${auto ? "ON" : "off"} (next ${days} day(s)) ===`);

    let events;
    try {
      events = await listUpcomingMeetings(c.id, days);
    } catch (err) {
      console.log(`  (skipped: ${err instanceof Error ? err.message : String(err)})`);
      continue;
    }

    const live = events
      .filter((e) => !e.isCancelled && Boolean(e.joinUrl))
      .sort((a, b) => (a.start?.dateTime ?? "").localeCompare(b.start?.dateTime ?? ""));

    let pilot = 0;
    let wouldCreate = 0;
    let internal = 0;
    for (const e of live) {
      const emails = e.attendees.map((a) => a.email).filter((x): x is string => !!x);
      const match = matchPilotDomain(emails) ?? matchPilotSubject(e.subject);
      if (match) {
        pilot += 1;
        console.log(`  [pilot: ${match.dealExternalId}]  ${fmt(e.start?.dateTime, e.start?.timeZone)}  |  ${e.subject ?? ""}`);
        continue;
      }
      const dom = firstExternalDomain(emails);
      if (!dom) {
        internal += 1;
        continue;
      }
      wouldCreate += 1;
      console.log(
        `  [AUTO -> ${autoDealExternalId(dom)} (${accountFromDomain(dom)})]  ${fmt(e.start?.dateTime, e.start?.timeZone)}  |  ${e.subject ?? ""}  |  ${dom}`,
      );
    }
    console.log(`  ${pilot} already pilot, ${wouldCreate} would auto-create, ${internal} internal (skipped)`);
  }
  console.log("");
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
