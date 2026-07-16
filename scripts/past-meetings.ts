/**
 * Look BACKWARD over the reps' calendars and replay the old pilot scope
 * (domains-only, auto-join OFF) to answer one question: in the past N days, was
 * there any meeting the bot SHOULD have joined under the original scope? If the
 * count is zero, nothing was missed. Read-only.
 *
 *   npx tsx scripts/past-meetings.ts            # past 14 days
 *   npx tsx scripts/past-meetings.ts --days 21
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { listMeetingsBetween } from "../lib/microsoft-graph";
import { resolveMeetingDeal } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const INTERNAL = new Set(["magaya.com"]);

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? "14");
  const tenantId = await resolveTenantId("magaya");
  const conns = await supabaseAdmin()
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);

  const now = new Date();
  const start = new Date(now.getTime() - days * 86_400_000);
  console.log(`Window: ${start.toISOString()}  ->  ${now.toISOString()}  (past ${days} days)\n`);

  let pilotMatches = 0;

  for (const c of conns.data ?? []) {
    console.log(`=== ${c.user_principal_name} ===`);
    let events;
    try {
      events = await listMeetingsBetween(c.id, start, now);
    } catch (err) {
      console.log(`  (calendar read failed: ${err instanceof Error ? err.message : String(err)})\n`);
      continue;
    }

    // Only external customer meetings with a join link are candidates the bot
    // could act on. Show them all; mark which the OLD scope would have joined.
    const candidates = events.filter((e) => {
      if (!e.joinUrl || e.isCancelled) return false;
      const domains = new Set(
        e.attendees.map((a) => a.email?.split("@")[1]?.toLowerCase()).filter(Boolean) as string[],
      );
      return [...domains].some((d) => !INTERNAL.has(d));
    });

    if (candidates.length === 0) {
      console.log("  no external customer meetings with a join link in this window\n");
      continue;
    }

    for (const e of candidates) {
      const emails = e.attendees.map((a) => a.email).filter((x): x is string => !!x);
      // Old scope = pilot domains only, auto-join OFF.
      const resolved = resolveMeetingDeal(emails, e.subject, false);
      const oldScopeMatch = resolved && !resolved.isAuto;
      if (oldScopeMatch) pilotMatches += 1;
      const domains = [
        ...new Set(e.attendees.map((a) => a.email?.split("@")[1]).filter(Boolean)),
      ].join(",");
      console.log(
        `  ${(e.start?.dateTime ?? "?").padEnd(22)} ${oldScopeMatch ? "SHOULD-HAVE-JOINED" : "out-of-scope     "} [${domains}]  ${e.subject ?? ""}`,
      );
      if (oldScopeMatch) console.log(`      -> matched pilot deal '${resolved!.dealExternalId}'`);
    }
    console.log("");
  }

  console.log("====================================================");
  console.log(`Meetings the bot SHOULD have joined under the OLD scope (past ${days}d): ${pilotMatches}`);
  if (pilotMatches === 0) {
    console.log("Zero. No pilot-domain customer call happened, so nothing was missed and there is no error to report.");
  } else {
    console.log("Non-zero: these were in scope and, if the pipeline was live, should have been joined. Investigate.");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
