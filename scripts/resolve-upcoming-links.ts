/**
 * Find the CRM record for every deal with a meeting coming up, before the call.
 *
 * The gap this closes: rolldog-relink only considers deals that already have a
 * CAPTURED call, because it was built to backfill an opportunity created after
 * the fact. So a deal with a meeting on Thursday and no call yet is never
 * searched for at all. On 2026-08-11 three of a newly onboarded rep's deals
 * showed "no Rolldog opportunity" two days before their calls, and the only way
 * to find out whether that was true was to email him.
 *
 * This runs on the other side of the call and records what it tried, so
 * "searched and found nothing" stops being indistinguishable from "never
 * looked". See lib/upcoming-links.ts for the rules and why it refuses to guess.
 *
 *   npx tsx scripts/resolve-upcoming-links.ts                 # report only
 *   npx tsx scripts/resolve-upcoming-links.ts --days 14
 *   npx tsx scripts/resolve-upcoming-links.ts --apply         # store confident matches
 *
 * Without --apply it stores no links. It always records the attempt, because an
 * unrecorded search is the thing this exists to stop.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { resolveUpcomingLinks, type DealLinkOutcome } from "../lib/upcoming-links";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function line(o: DealLinkOutcome): string {
  const rd = o.rolldog.status === "linked" ? o.rolldog.note : o.rolldog.status;
  const sf = o.salesforce.status === "linked" ? o.salesforce.note : o.salesforce.status;
  return `  ${formatMeetingTime(o.meetingAt).padEnd(24)} ${o.account.padEnd(22)} rolldog: ${rd.padEnd(34)} salesforce: ${sf}`;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 7);
  const apply = process.argv.includes("--apply");

  console.log("");
  console.log(`Resolving deals with a meeting in the next ${days} day(s). ${apply ? "APPLYING confident matches." : "Report only."}`);

  const out = await resolveUpcomingLinks({ tenantSlug: "magaya", days, apply });
  if (out.length === 0) {
    console.log("\nNo upcoming meetings in that window.\n");
    return;
  }

  const already = out.filter((o) => o.alreadyWritable);
  const searched = out.filter((o) => !o.alreadyWritable);
  const linked = searched.filter((o) => o.rolldog.status === "linked" || o.salesforce.status === "linked");
  const decide = searched.filter(
    (o) => o.rolldog.status === "needs_decision" || o.salesforce.status === "needs_decision",
  );
  const nothing = searched.filter(
    (o) =>
      o.rolldog.status === "no_candidates" &&
      o.salesforce.status === "no_candidates",
  );
  const broke = searched.filter(
    (o) => o.rolldog.status === "unavailable" || o.salesforce.status === "unavailable",
  );

  console.log("");
  console.log(`  ${already.length} already had somewhere to write, nothing searched`);
  console.log(`  ${searched.length} searched`);
  console.log("");

  if (linked.length > 0) {
    console.log(`FOUND A MATCH  (${linked.length})`);
    for (const o of linked) console.log(line(o));
    console.log("");
  }

  if (decide.length > 0) {
    console.log(`NEEDS A HUMAN  (${decide.length})`);
    console.log(`Candidates exist but none is unambiguous. Linking the wrong one writes a`);
    console.log(`customer's qualification onto another customer's record, so these stop here.`);
    console.log("");
    for (const o of decide) {
      console.log(`  ${o.account}  ·  ${formatMeetingTime(o.meetingAt)}  ·  ${o.repEmail ?? "no rep"}`);
      if (o.rolldog.status === "needs_decision") {
        console.log(`      rolldog: ${o.rolldog.note}   searched: ${o.rolldog.queries.join(", ")}`);
        for (const c of o.rolldog.candidates) console.log(`        ${c.id}  ${c.label}`);
      }
      if (o.salesforce.status === "needs_decision") console.log(`      salesforce: ${o.salesforce.note}`);
    }
    console.log("");
  }

  if (nothing.length > 0) {
    console.log(`GENUINELY NEW  (${nothing.length})`);
    console.log(`Both CRMs answered and neither has this customer. Nothing to link, and no`);
    console.log(`reason to ask the rep. This is a real answer, not a gap.`);
    console.log("");
    for (const o of nothing) {
      console.log(`  ${formatMeetingTime(o.meetingAt).padEnd(24)} ${o.account.padEnd(22)} searched: ${o.rolldog.queries.join(", ")}`);
    }
    console.log("");
  }

  if (broke.length > 0) {
    console.log(`COULD NOT CHECK  (${broke.length})`);
    console.log(`Not the same as "not there". Re-run before treating these as new.`);
    console.log("");
    for (const o of broke) {
      console.log(`  ${o.account}`);
      if (o.rolldog.status === "unavailable") console.log(`      rolldog: ${o.rolldog.note}`);
      if (o.salesforce.status === "unavailable") console.log(`      salesforce: ${o.salesforce.note}`);
    }
    console.log("");
  }

  if (!apply && linked.length > 0) {
    console.log(`Re-run with --apply to store the confident matches.`);
    console.log("");
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
