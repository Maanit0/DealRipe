/**
 * What is actually on a rep's calendar, with the attendee list that the
 * external/internal decision is made from.
 *
 * preflight-reps reports "11 meetings, none external" for Daniel Blitstein.
 * That single sentence covers two different situations: every attendee really is
 * @magaya.com, or Graph returned no attendees at all and an empty list filtered
 * to false. The report cannot tell them apart, which is the failure this
 * codebase exists to avoid, so this prints the raw material and lets a person
 * decide.
 *
 * READ ONLY.
 *
 *   npx tsx scripts/rep-meetings.ts --rep dblitstein
 *   npx tsx scripts/rep-meetings.ts --rep dblitstein --days 14
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { listUpcomingMeetings } from "../lib/microsoft-graph";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { formatMeetingTime } from "../lib/graph-time";

const HOME = "magaya.com";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const who = (arg("--rep") ?? "").toLowerCase();
  const days = Number(arg("--days") ?? "7");
  if (!who) {
    console.log("\nPass --rep <email or fragment>.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const res = await db
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  if (res.error) throw new Error(res.error.message);

  const conns = (res.data ?? []).filter((c) =>
    String(c.user_principal_name ?? "").toLowerCase().includes(who),
  ) as Array<{ id: string; user_principal_name: string }>;

  if (conns.length === 0) {
    console.log(`\nNo Microsoft connection whose user_principal_name matches "${who}".`);
    console.log(`That is not "this rep has no calendar": it means no connection row matched.\n`);
    return;
  }

  for (const conn of conns) {
    const meetings = await listUpcomingMeetings(conn.id, days);
    console.log(`\n${"=".repeat(84)}`);
    console.log(`${conn.user_principal_name}  ·  next ${days} days  ·  ${meetings.length} meeting(s)`);
    console.log(`${"=".repeat(84)}`);

    let external = 0;
    let internal = 0;
    let unknown = 0;

    for (const m of meetings) {
      const raw = (m as { attendees?: Array<{ email?: string | null; name?: string | null }> }).attendees ?? [];
      const emails = raw
        .map((a) => (a.email ?? "").trim().toLowerCase())
        .filter((e) => e.includes("@"));
      const domains = [...new Set(emails.map((e) => e.split("@")[1]).filter(Boolean))];
      const outside = domains.filter((d) => d !== HOME);

      // Three states, deliberately. "No attendee carried an address" is not the
      // same answer as "every attendee was internal", and folding them together
      // is exactly what makes this report unreadable today.
      const verdict = emails.length === 0 ? "UNKNOWN" : outside.length > 0 ? "EXTERNAL" : "internal";
      if (verdict === "EXTERNAL") external += 1;
      else if (verdict === "internal") internal += 1;
      else unknown += 1;

      // NormalizedMeeting carries start as Graph's naive {dateTime,timeZone},
      // not an ISO string. Reading a field that does not exist printed "(no
      // time)" on every row, which is the same class of quiet wrong answer this
      // script was written to expose.
      console.log(`\n${verdict.padEnd(9)} ${formatMeetingTime(m.start?.dateTime ?? null)}  ${m.subject ?? "(no subject)"}`);
      const organizer = (m as { organizerEmail?: string | null }).organizerEmail ?? null;
      console.log(`          organiser  ${organizer ?? "(not returned)"}`);
      if (raw.length === 0) {
        console.log(`          attendees  NONE RETURNED BY GRAPH`);
      } else {
        console.log(`          attendees  ${raw.length} entr(y/ies), ${emails.length} with an address`);
        for (const a of raw.slice(0, 12)) {
          console.log(`             ${(a.email ?? "(no address)").padEnd(38)} ${a.name ?? ""}`);
        }
        if (raw.length > 12) console.log(`             ... and ${raw.length - 12} more`);
      }
      if (outside.length > 0) console.log(`          outside    ${outside.join(", ")}`);
    }

    console.log(`\n${"-".repeat(84)}`);
    console.log(`EXTERNAL ${external}   internal ${internal}   UNKNOWN ${unknown}`);
    if (unknown > 0) {
      console.log(
        `\n${unknown} meeting(s) carried no attendee address at all. preflight counts those as\n` +
          `not-external, which is why the report reads "none external". That is a reporting\n` +
          `bug, not a rep with an empty week.`,
      );
    } else if (external === 0) {
      console.log(
        `\nEvery meeting had attendee addresses and all of them were @${HOME}.\n` +
          `The report is correct: this rep genuinely has no customer calls in the window.`,
      );
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
