/**
 * Retire deals keyed to a consumer-mail DOMAIN rather than a person.
 *
 * "auto:icloud.com" is Apple's mail domain, not a customer. Deals like it were
 * created before free-mail addresses were keyed per person (see
 * resolveMeetingDeal in lib/pilot-config.ts, which is now correct). They sit
 * alongside the real person-keyed deal and collect every unrelated attendee on
 * that provider, so one meeting shows twice: on 2026-08-11 Luke Rousselle's
 * single no-show appeared as two rows in Meetings, one titled "Icloud", and as
 * two cards in the CRO's weekly digest.
 *
 * Left alone this gets worse rather than better: every future gmail.com customer
 * lands on the same shell.
 *
 * WHAT IT DOES
 *
 * For each shell deal, every call on it is checked against the person-keyed
 * deals for the same meeting, matched on the calendar key or on the exact start
 * instant. A call with a twin elsewhere is marked outcome='duplicate', which is
 * already excluded from coverage, digests and extraction counts. A call with NO
 * twin is left alone and reported loudly, because that is a real meeting whose
 * only home is the shell and moving it is a judgement call.
 *
 *   npx tsx scripts/retire-freemail-shells.ts
 *   npx tsx scripts/retire-freemail-shells.ts --apply
 *
 * Deletes nothing. The shell deal and its rows stay; the duplicate calls stop
 * being counted.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { isConsumerMailShell } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

/** Strip any ":YYYY-MM-DD" occurrence suffix so a shell row and a person row
 *  for the same meeting compare equal. */
function seriesKey(externalId: string | null): string {
  return String(externalId ?? "").replace(/(:\d{4}-\d{2}-\d{2})+$/, "");
}

/** Subjects compared loosely: reps re-send invites with "Confirmed -" and
 *  similar prefixes, and punctuation drifts between copies. */
function normTitle(t: string | null | undefined): string {
  return String(t ?? "")
    .toLowerCase()
    .replace(/^\s*(confirmed|placeholder|updated|re|fwd)\s*[-:]\s*/g, "")
    .replace(/[^a-z0-9]/g, "");
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);
  const deals = (dealsRes.data ?? []) as Array<{ id: string; account: string; external_id: string | null }>;

  const shells = deals.filter((d) => isConsumerMailShell(d.external_id));
  console.log("");
  if (shells.length === 0) {
    console.log("No consumer-mail shell deals. Every free-mail customer is keyed to a person.\n");
    return;
  }
  console.log(`${shells.length} shell deal(s) keyed to a mail provider rather than a customer:`);
  for (const s of shells) console.log(`  ${s.account}  (${s.external_id})`);
  console.log("");
  console.log(apply ? "APPLYING." : "Dry run. Nothing will change.");

  const callsRes = await db
    .from("calls")
    .select("id, deal_id, title, external_id, scheduled_start, outcome, recall_bot_id")
    .eq("tenant_id", tenantId);
  if (callsRes.error) throw new Error(callsRes.error.message);
  const calls = callsRes.data ?? [];

  const shellIds = new Set(shells.map((s) => s.id));
  const elsewhere = calls.filter((c) => c.deal_id && !shellIds.has(String(c.deal_id)));
  const nameById = new Map(deals.map((d) => [d.id, d.account] as const));

  let marked = 0;
  let orphans = 0;

  for (const s of shells) {
    const mine = calls.filter((c) => String(c.deal_id) === s.id);
    console.log(`\n${s.account}  ·  ${mine.length} call(s)`);
    if (mine.length === 0) {
      console.log(`  Nothing attached. The shell is inert; leave it or delete it by hand.`);
      continue;
    }

    for (const c of mine) {
      const key = seriesKey(c.external_id);
      const start = Date.parse(String(c.scheduled_start ?? ""));
      const title = normTitle(c.title);

      // Exact-instant matching is too strict for this. A repaired row can carry
      // the time its recording was persisted rather than the time the meeting
      // began, which put the Luke Rousselle pair 46 minutes apart and made the
      // shell's copy look like a meeting of its own. Same day and the same
      // subject is the same meeting; a customer does not hold two identically
      // titled calls four hours apart.
      const SAME_MEETING_MS = 4 * 60 * 60 * 1000;
      const twin = elsewhere.find((o) => {
        if (key && seriesKey(o.external_id) === key) return true;
        const ot = Date.parse(String(o.scheduled_start ?? ""));
        if (!Number.isFinite(start) || !Number.isFinite(ot)) return false;
        if (Math.abs(ot - start) > SAME_MEETING_MS) return false;
        return title.length > 0 && normTitle(o.title) === title;
      });

      const when = formatMeetingTime(c.scheduled_start);
      if (!twin) {
        orphans += 1;
        console.log(`  KEEP  ${when}  ${String(c.title ?? "").slice(0, 40)}`);
        console.log(`        No copy on a person-keyed deal. This meeting only exists here, so`);
        console.log(`        marking it duplicate would lose it. Re-point it by hand if it matters.`);
        continue;
      }

      console.log(`  DUPE  ${when}  ${String(c.title ?? "").slice(0, 40)}`);
      console.log(`        also on "${nameById.get(String(twin.deal_id)) ?? "?"}" as ${twin.id}`);
      if (c.outcome === "duplicate") {
        console.log(`        already marked`);
        continue;
      }
      if (!apply) continue;
      const upd = await db.from("calls").update({ outcome: "duplicate" } as never).eq("id", c.id);
      if (upd.error) console.log(`        FAILED: ${upd.error.message}`);
      else {
        marked += 1;
        console.log(`        marked duplicate`);
      }
    }
  }

  console.log("");
  console.log(`${marked} call(s) marked duplicate. ${orphans} left alone for a human.`);
  if (!apply) console.log("Re-run with --apply.");
  console.log("");
  console.log("Deal creation itself is already fixed: resolveMeetingDeal keys a free-mail");
  console.log("customer to their address, not their provider. These shells predate that.");
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
