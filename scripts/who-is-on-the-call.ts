/**
 * Who is on each upcoming call, and where will the recap and draft actually go?
 *
 * A rep double-booked at the same hour is only a problem if they are the ONLY
 * Magaya person on both invites. If a colleague is on one of them, that meeting
 * runs, someone admits the bot, and the call is captured normally. The
 * scheduling grid cannot tell those two situations apart; the attendee list can.
 *
 * The consequence that survives either way is routing. recipientsForCall sends
 * the recap to every connected rep on the invite, but the follow-up draft is
 * written to the OWNER's mailbox alone, because "someone will send the proposal"
 * is how a proposal does not get sent. So when the owner is not the person who
 * actually ran the call, the draft lands in the wrong drafts folder. That is
 * invisible until a rep goes looking for it.
 *
 *   npx tsx scripts/who-is-on-the-call.ts --days 2
 *   npx tsx scripts/who-is-on-the-call.ts --rep asuntrup@magaya.com
 *
 * READ ONLY. Uses recipientsForCall itself, so it cannot drift from the routing
 * it is reporting on.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { recipientsForCall } from "../lib/call-recipients";
import { formatMeetingTime } from "../lib/graph-time";
import { isAutoJoinRep } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";
const SELLER_DOMAIN = "magaya.com";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Participant = { email?: string | null; name?: string | null };

function short(email: string): string {
  return email.split("@")[0];
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 2);
  const onlyRep = arg("--rep")?.toLowerCase() ?? null;

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const horizon = new Date(Date.now() + days * 86_400_000).toISOString();
  const calls = await db
    .from("calls")
    .select("id, deal_id, title, scheduled_start, recall_bot_id, participants")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", new Date().toISOString())
    .lte("scheduled_start", horizon)
    .order("scheduled_start", { ascending: true });
  if (calls.error) throw new Error(calls.error.message);

  const deals = await db.from("deals").select("id, account, rep_email").eq("tenant_id", tenantId);
  if (deals.error) throw new Error(deals.error.message);
  const dealById = new Map((deals.data ?? []).map((d) => [d.id, d]));

  const conns = await db
    .from("microsoft_connections")
    .select("user_principal_name")
    .eq("tenant_id", tenantId);
  if (conns.error) throw new Error(conns.error.message);
  const connectedMailboxes = new Set(
    (conns.data ?? []).map((c) => (c.user_principal_name ?? "").toLowerCase()).filter(Boolean),
  );

  console.log("");

  for (const c of calls.data ?? []) {
    const deal = dealById.get(c.deal_id);
    const ownerEmail = deal?.rep_email ?? null;
    if (onlyRep && (ownerEmail ?? "").toLowerCase() !== onlyRep) continue;

    // The real routing, from the real function.
    const r = await recipientsForCall(tenantId, c.id, ownerEmail);

    const raw = Array.isArray(c.participants) ? (c.participants as Participant[]) : [];
    const sellerSide = raw
      .map((p) => (p?.email ?? "").toLowerCase())
      .filter((e) => e.endsWith(`@${SELLER_DOMAIN}`));
    // Enrolled is not the same as reachable. recipientsForCall requires BOTH
    // isAutoJoinRep AND a live microsoft_connection, so a rep who is enrolled
    // but has never connected a calendar is on the invite, in the room, and
    // silently excluded from the recap.
    const enrolled = sellerSide.filter((e) => isAutoJoinRep(e));
    const notEnrolled = sellerSide.filter((e) => !isAutoJoinRep(e));
    const unreachable = enrolled.filter((e) => !connectedMailboxes.has(e));

    console.log(`${formatMeetingTime(c.scheduled_start)}   ${(c.title ?? "(untitled)").slice(0, 56)}`);
    console.log(`   deal        ${deal?.account ?? "?"}`);
    console.log(`   bot         ${c.recall_bot_id ? String(c.recall_bot_id).slice(0, 8) : "none"}`);

    if (raw.length === 0) {
      // Distinguishable from "no Magaya colleagues": we have no attendee list at
      // all, so anything said about who is in the room would be invented.
      console.log(`   magaya side ATTENDEE LIST EMPTY, cannot say who else is on this invite`);
    } else {
      console.log(
        `   attendees   ${sellerSide.length === 0 ? "(no magaya attendees listed)" : sellerSide.map(short).join(", ")}` +
          (notEnrolled.length > 0 ? `   [not enrolled: ${notEnrolled.map(short).join(", ")}]` : ""),
      );
    }

    console.log(`   recap to    ${r.all.length > 0 ? r.all.map(short).join(", ") : "(nobody)"}`);
    console.log(`   draft to    ${r.owner ? short(r.owner) : "(nobody)"}${r.coSold ? "   co-sold" : ""}`);

    // Enrolled, on the invite, and still gets nothing.
    if (unreachable.length > 0) {
      console.log(
        `   NO RECAP    ${unreachable.map(short).join(", ")} on the invite but has no connected calendar, so is excluded from the recap.`,
      );
    }

    // Deliberately NOT called "misrouted". calls.participants is populated from
    // ev.attendees alone and Graph reports the organizer separately, so a rep
    // who ORGANIZED the meeting never appears here. The first version of this
    // script read that absence as "the owner is not on this invite" and flagged
    // five of Alexandra's own meetings as misrouted. Absence from the attendee
    // list is not absence from the meeting.
    if (raw.length > 0 && r.owner && !sellerSide.includes(r.owner)) {
      console.log(
        `   note        owner ${short(r.owner)} is not in the ATTENDEE list. Usually means they organized it; only a real mismatch if they did not.`,
      );
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
