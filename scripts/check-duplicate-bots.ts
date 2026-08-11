/**
 * Will two bots join the same meeting?
 *
 * Calls are keyed on iCalUId, which correctly collapses ONE calendar event that
 * appears on two reps' calendars into a single bot. It does nothing about the
 * other case: two SEPARATE calendar events for the same real meeting. A
 * placeholder hold and the confirmed invite that supersedes it are different
 * events with different iCalUIds, so both pass the dedupe and both get a bot,
 * and two DealRipe bots walk into the customer's call.
 *
 * That is not a hypothetical. "Confirmed - FTZ Question Connect" and
 * "Placeholder FTZ Question Connect" sit at the same 11:00 slot on the same
 * rep's calendar with the same attendee.
 *
 * So this groups upcoming calls by rep and start time and reports any slot
 * holding more than one bot-scheduled call.
 *
 *   npx tsx scripts/check-duplicate-bots.ts
 *   npx tsx scripts/check-duplicate-bots.ts --days 3
 *
 * READ ONLY. It cancels nothing; it only tells you where to look.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** A placeholder hold, by the naming convention the reps actually use. */
function looksLikePlaceholder(title: string): boolean {
  return /^\s*placeholder\b|\bplaceholder\b/i.test(title);
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 7);
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const horizon = new Date(Date.now() + days * 86_400_000).toISOString();
  const calls = await db
    .from("calls")
    .select("id, deal_id, title, scheduled_start, recall_bot_id, external_id")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", new Date().toISOString())
    .lte("scheduled_start", horizon)
    .order("scheduled_start", { ascending: true });
  if (calls.error) throw new Error(calls.error.message);

  // The rep lives on the deal, not the call, and the iCalUId is the call's
  // external_id. Both matter: two rows for one meeting are only worth reporting
  // when they belong to the same rep, and the external_id is what shows whether
  // the dedupe had any chance of catching them.
  const deals = await db
    .from("deals")
    .select("id, account, rep_email")
    .eq("tenant_id", tenantId);
  if (deals.error) throw new Error(deals.error.message);
  const dealById = new Map((deals.data ?? []).map((d) => [d.id, d]));

  const rows = (calls.data ?? []).map((c) => ({
    ...c,
    rep_email: dealById.get(c.deal_id)?.rep_email ?? null,
    account: dealById.get(c.deal_id)?.account ?? null,
  }));

  // Group by rep + exact start. Same rep cannot be in two customer meetings at
  // the same instant, so any group above one is the same real meeting recorded
  // twice, whatever the titles say.
  const slots = new Map<string, typeof rows>();
  for (const c of rows) {
    const key = `${(c.rep_email ?? "").toLowerCase()}|${c.scheduled_start ?? ""}`;
    const list = slots.get(key) ?? [];
    list.push(c);
    slots.set(key, list);
  }

  const collisions = [...slots.values()].filter((g) => g.length > 1);

  console.log("");
  if (collisions.length === 0) {
    console.log(`No slot in the next ${days} days holds more than one call. No duplicate bots.`);
    console.log("");
    return;
  }

  console.log(`${collisions.length} time slot(s) hold more than one call.`);
  console.log("");

  for (const g of collisions) {
    const withBots = g.filter((c) => c.recall_bot_id);
    const rep = (g[0].rep_email ?? "?").split("@")[0];
    console.log(`${formatMeetingTime(g[0].scheduled_start)}   ${rep}`);
    for (const c of g) {
      const tag = c.recall_bot_id ? `BOT ${String(c.recall_bot_id).slice(0, 8)}` : "no bot";
      const ph = looksLikePlaceholder(c.title ?? "") ? "  <- placeholder" : "";
      console.log(`   ${tag.padEnd(14)} ${(c.title ?? "(untitled)").slice(0, 58)}${ph}`);
      console.log(`   ${" ".repeat(14)} call ${c.id}  key ${String(c.external_id ?? "").slice(0, 24)}`);
    }
    // Only a slot with two BOTS actually sends two bots into the room. One bot
    // plus one unbotted duplicate is untidy, not customer-visible, and saying
    // otherwise would be the same overstatement this codebase keeps making.
    if (withBots.length > 1) {
      console.log(`   ${withBots.length} BOTS WILL JOIN THIS MEETING. Cancel all but one.`);
    } else {
      console.log(`   Only ${withBots.length} bot scheduled, so one bot joins. Duplicate row is cosmetic.`);
    }
    console.log("");
  }

  const real = collisions.filter((g) => g.filter((c) => c.recall_bot_id).length > 1).length;
  console.log(
    real > 0
      ? `${real} meeting(s) would be joined by more than one bot.`
      : "No meeting would be joined by more than one bot.",
  );
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
