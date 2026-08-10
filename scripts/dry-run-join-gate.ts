/**
 * What would DealRipe join, and what would it decline?
 *
 * Prints the join gate's verdict for every upcoming meeting on every connected
 * calendar, without creating a bot, a deal, or a row of any kind. Run this
 * before switching auto-join on for a rep whose calendar you have never seen.
 *
 * Read the JOIN column first, then read the DECLINE list and ask, for each one,
 * "would I have wanted a notetaker in that?". A false decline costs a recap. A
 * false join puts a bot in a 1-on-1 or a candidate interview.
 *
 *   npx tsx scripts/dry-run-join-gate.ts
 *   npx tsx scripts/dry-run-join-gate.ts --days 14
 *   npx tsx scripts/dry-run-join-gate.ts --rep jlopez@magaya.com
 *
 * READ ONLY. Calls Graph, Salesforce and the classifier. Writes nothing.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { shouldJoinAutoMeeting } from "../lib/join-gate";
import { listUpcomingMeetings } from "../lib/microsoft-graph";
import { autoDealExternalIdForAddress, firstExternalAddress, isAutoJoinRep, isFreeMailDomain } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { formatMeetingTime } from "../lib/graph-time";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Rendered in the rep's timezone, not the reader's. See lib/graph-time.ts. */
const when = formatMeetingTime;

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 7);
  const onlyRep = arg("--rep")?.toLowerCase() ?? null;

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();
  const conns = await db
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  if (conns.error) throw new Error(conns.error.message);

  const joins: string[] = [];
  const declines: string[] = [];

  console.log("");
  console.log(`Join-gate dry run · next ${days} days · nothing is written`);
  console.log("");

  for (const c of conns.data ?? []) {
    const rep = (c.user_principal_name ?? "").toLowerCase();
    if (!rep || (onlyRep && rep !== onlyRep)) continue;

    if (!isAutoJoinRep(rep)) {
      console.log(`${rep}  ·  not on AUTO_JOIN_REP_EMAILS, skipping\n`);
      continue;
    }

    let meetings;
    try {
      meetings = await listUpcomingMeetings(c.id, days);
    } catch (e) {
      console.log(`${rep}  ·  calendar error: ${e instanceof Error ? e.message : String(e)}\n`);
      continue;
    }

    console.log(`${rep}  ·  ${meetings.length} meeting(s)`);

    for (const m of meetings) {
      const emails = (m.attendees ?? [])
        .map((a) => a.email)
        .filter((e): e is string => typeof e === "string" && e.length > 0);
      const address = firstExternalAddress(emails);
      if (!address) continue; // internal-only; the gate never sees these

      const domain = address.split("@")[1] ?? "";
      const verdict = await shouldJoinAutoMeeting({
        tenantId,
        dealExternalId: autoDealExternalIdForAddress(address),
        domain,
        address,
        isFreeMail: isFreeMailDomain(domain),
        subject: m.subject ?? null,
        attendeeEmails: emails,
        sellerName: "Magaya",
      });

      const line = `   ${verdict.join ? "JOIN   " : "decline"}  ${when(m.start?.dateTime)}  ${(m.subject ?? "(untitled)").slice(0, 58).padEnd(58)}  ${verdict.detail}`;
      console.log(line);
      (verdict.join ? joins : declines).push(`${rep}  ${m.subject ?? "(untitled)"}  ·  ${verdict.detail}`);
    }
    console.log("");
  }

  console.log("=".repeat(78));
  console.log(`${joins.length} would be joined, ${declines.length} declined.`);
  if (declines.length > 0) {
    console.log("");
    console.log("DECLINED. Check each one: is there a real sales call in here?");
    for (const d of declines) console.log(`   ${d}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
