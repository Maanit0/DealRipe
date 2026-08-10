/**
 * Run one calendar sync now, printing every decision.
 *
 * The cron does this on a schedule in production. This exists for the case
 * where a rep has just connected and their first meeting is sooner than the
 * next cron run: Alexandra and Daniel connected an hour after the onboarding
 * call, with meetings the following morning and no deals, no bots and no
 * briefings until a sync happened.
 *
 * NOT read-only. It creates deals, calls rows and real Recall bots, and can
 * cancel bots for meetings that moved. That is the whole point, but it is why
 * --apply is required and why the decision log prints in full.
 *
 *   npx tsx scripts/run-calendar-sync.ts            # refuses, explains
 *   npx tsx scripts/run-calendar-sync.ts --apply
 *
 * Check scripts/dry-run-join-gate.ts first if you want to know what it will
 * decide before it decides it.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runCalendarSync, type CalendarSyncDecision } from "../lib/calendar-sync";

function describe(d: CalendarSyncDecision): string | null {
  const subject = "subject" in d ? (d.subject ?? "(untitled)") : "";
  switch (d.kind) {
    case "created":
      return `  BOT CREATED     ${subject}   (${d.recallBotId.slice(0, 8)})`;
    case "rescheduled":
      return `  RESCHEDULED     ${subject}   -> ${d.newBotId.slice(0, 8)}`;
    case "cancelled":
      return `  BOT CANCELLED   ${subject}`;
    case "auto-deal":
      return `  DEAL CREATED    ${subject}   ${d.dealExternalId}`;
    case "not-commercial":
      return `  declined        ${subject}   ${d.detail}`;
    case "vanished":
      return `  pruned          call ${d.callId} (meeting gone from the calendar)`;
    case "error":
      return `  ERROR           ${subject}   [${d.phase}] ${d.message}`;
    case "no-deal":
      return `  no deal         ${subject}   ${d.dealExternalId}`;
    // Quiet outcomes: no join link, internal-only, already correct.
    default:
      return null;
  }
}

async function main(): Promise<void> {
  if (!process.argv.includes("--apply")) {
    console.log("");
    console.log("This creates deals, calls rows and real Recall bots on live customer meetings.");
    console.log("Run scripts/dry-run-join-gate.ts first to see what it would decide, then");
    console.log("re-run this with --apply.");
    console.log("");
    return;
  }

  console.log("");
  console.log("Running calendar sync...");
  console.log("");

  const counts = await runCalendarSync({
    onDecision: (d) => {
      const line = describe(d);
      if (line) console.log(line);
    },
  });

  console.log("");
  console.log("SUMMARY");
  console.log(`   events seen           ${counts.eventsSeen}`);
  console.log(`   matched to a deal     ${counts.matched}`);
  console.log(`   deals auto-created    ${counts.autoCreated}`);
  console.log(`   bots created          ${counts.botsCreated}`);
  console.log(`   rescheduled           ${counts.rescheduled}`);
  console.log(`   cancelled             ${counts.cancelled}`);
  console.log(`   declined, not commercial  ${counts.skippedNotCommercial}`);
  console.log(`   calendars skipped     ${counts.connectionsSkipped}`);
  console.log(`   vanished, pruned      ${counts.reconciledVanished}`);
  console.log("");
  console.log("Now run scripts/check-call-dupes.ts to confirm one row per meeting,");
  console.log("and scripts/meeting-readiness.ts --briefing to see what the reps will get.");
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
