/**
 * Fill calls.organizer_email for meetings that already happened.
 *
 * calendar-sync records the organizer going forward, which leaves every past
 * call blank, including the ten captures lost between 2026-08-07 and 08-13.
 * Nine of those were bots that reached a waiting room and were never admitted,
 * and the fix depends entirely on whose waiting room it was: a Teams policy
 * change if Magaya organized, bot presentation and rep habit if the customer
 * did. Asking the reps answers it for the calls they remember, which is not the
 * same set as the calls that failed.
 *
 * Graph still holds those events on each rep's calendar, calls.external_id
 * carries the iCalUId, and listMeetingsBetween already takes an arbitrary
 * window. So this is a match, not an integration.
 *
 * Dry run by default: it prints what it would write and writes nothing.
 *
 *   npx tsx scripts/backfill-call-organizer.ts --from 2026-08-01 --to 2026-08-15
 *   npx tsx scripts/backfill-call-organizer.ts --from 2026-08-01 --to 2026-08-15 --apply
 *   npx tsx scripts/backfill-call-organizer.ts --from 2026-08-01 --to 2026-08-15 --failures-only
 *
 * Only fills rows where organizer_email is null. A value already recorded by
 * calendar-sync came from the same source and is not second-guessed here.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { listMeetingsBetween, type NormalizedMeeting } from "../lib/microsoft-graph";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * calendar-sync keys a call as `${iCalUId}:${YYYY-MM-DD}` so two occurrences of
 * a series get their own rows, and older rows carry the bare iCalUId or a
 * per-mailbox event id. Strip the date suffix to recover the series id.
 *
 * The suffix is exactly ten characters of digits and dashes, so this only
 * strips something that looks like a date rather than anything after the last
 * colon: a Graph event id can contain colons of its own.
 */
function seriesKeyOf(externalId: string): string {
  const m = externalId.match(/^(.*):(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : externalId;
}

async function main(): Promise<void> {
  const from = arg("--from");
  const to = arg("--to");
  const apply = process.argv.includes("--apply");
  const failuresOnly = process.argv.includes("--failures-only");
  if (!from || !to) {
    console.log("\nPass --from YYYY-MM-DD and --to YYYY-MM-DD.\n");
    process.exit(1);
  }
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T23:59:59Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    console.log("\nDates must be YYYY-MM-DD.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  // ---------------------------------------------------------------
  // Every event across every connected calendar in the window.
  // ---------------------------------------------------------------
  const conns = await db
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  if (conns.error) throw new Error(conns.error.message);
  const connections = conns.data ?? [];
  if (connections.length === 0) {
    console.log("\nNo connected calendars, so nothing can be looked up.\n");
    return;
  }

  const byKey = new Map<string, NormalizedMeeting>();
  let calendarsRead = 0;
  const skipped: string[] = [];

  for (const c of connections) {
    try {
      const events = await listMeetingsBetween(c.id, start, end);
      calendarsRead++;
      for (const ev of events) {
        // Index under both identifiers calendar-sync may have keyed on.
        if (ev.iCalUId) byKey.set(ev.iCalUId, ev);
        byKey.set(ev.eventId, ev);
      }
    } catch (err) {
      // A revoked token is a calendar we could not read, not a calendar with no
      // meetings. Any call belonging to this rep will report "not on any
      // calendar we could read" rather than being silently left blank.
      skipped.push(
        `${c.user_principal_name ?? c.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(`\nRead ${calendarsRead} of ${connections.length} calendar(s), ${byKey.size} event key(s) indexed.`);
  for (const s of skipped) console.log(`  COULD NOT READ  ${s}`);

  // ---------------------------------------------------------------
  // Calls in the same window with no organizer recorded.
  // ---------------------------------------------------------------
  let q = db
    .from("calls")
    .select("id, external_id, title, outcome, scheduled_start, organizer_email, deals!inner(account, rep_email)")
    .eq("tenant_id", tenantId)
    .is("organizer_email", null)
    .gte("scheduled_start", start.toISOString())
    .lte("scheduled_start", end.toISOString())
    .order("scheduled_start", { ascending: false });
  if (failuresOnly) q = q.eq("outcome", "capture_failed");

  const callsRes = await q;
  if (callsRes.error) throw new Error(callsRes.error.message);
  const calls = (callsRes.data ?? []) as unknown as Array<{
    id: string;
    external_id: string | null;
    title: string | null;
    outcome: string | null;
    scheduled_start: string | null;
    deals: { account: string; rep_email: string | null };
  }>;

  if (calls.length === 0) {
    console.log(`\nNo calls in that window are missing an organizer.\n`);
    return;
  }

  console.log(`\n${apply ? "APPLYING." : "Dry run. Nothing will be written."}`);
  console.log(`${calls.length} call(s) with no organizer recorded.\n`);

  let matched = 0;
  let unmatched = 0;
  let magaya = 0;
  let customer = 0;

  for (const c of calls) {
    const label = `${c.deals.account.padEnd(22)} ${(c.scheduled_start ?? "").slice(0, 10)}  ${c.outcome ?? "(no outcome)"}`;
    const ext = c.external_id;
    const ev = ext ? (byKey.get(seriesKeyOf(ext)) ?? byKey.get(ext)) : undefined;

    if (!ev) {
      unmatched++;
      console.log(`  ${label}   NOT ON ANY CALENDAR WE COULD READ`);
      continue;
    }
    const organizer = ev.organizerEmail;
    if (!organizer) {
      unmatched++;
      console.log(`  ${label}   event found, but Graph returned no organizer`);
      continue;
    }

    const side = organizer.toLowerCase().endsWith("@magaya.com") ? "MAGAYA" : "CUSTOMER";
    if (side === "MAGAYA") magaya++;
    else customer++;
    matched++;
    console.log(`  ${label}   ${side.padEnd(8)} ${organizer}`);

    if (apply) {
      const upd = await db.from("calls").update({ organizer_email: organizer }).eq("id", c.id);
      if (upd.error) console.log(`      WRITE FAILED: ${upd.error.message}`);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${matched} matched   ${unmatched} not matched`);
  if (matched > 0) {
    console.log(`  ${magaya} organized by Magaya, ${customer} organized by the customer`);
    console.log("");
    if (customer === 0) {
      console.log(`  Every one of these was Magaya's own lobby. A Teams policy change`);
      console.log(`  covers all of them at once and asks nothing of the reps.`);
    } else if (magaya === 0) {
      console.log(`  Every one was the customer's lobby. Magaya cannot configure those,`);
      console.log(`  so the levers are the bot's name and reps owning the invite.`);
    } else {
      console.log(`  Split, so both fixes are needed and neither alone closes the gap.`);
    }
  }
  if (unmatched > 0) {
    console.log(`\n  ${unmatched} could not be resolved. That is missing information, not`);
    console.log(`  evidence about who hosted, and should not be counted either way.`);
  }
  if (!apply) console.log(`\n  Re-run with --apply to write these.`);
  console.log(`${"=".repeat(70)}\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  let cause: unknown = (e as { cause?: unknown })?.cause;
  while (cause) {
    const c = cause as { message?: string; code?: string; cause?: unknown };
    console.error(`  caused by: ${c.code ?? ""} ${c.message ?? String(cause)}`);
    cause = c.cause;
  }
  console.error("");
  process.exit(1);
});
