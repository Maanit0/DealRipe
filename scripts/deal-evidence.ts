/**
 * Dump the RAW evidence on one deal, with provenance and a verification state
 * on every fact. READ ONLY. Writes nothing, sends nothing.
 *
 *   npx tsx scripts/deal-evidence.ts --deal Ghy
 *   npx tsx scripts/deal-evidence.ts --deal Ghy --json
 *
 * WHY THIS EXISTS.
 *
 * The weekly digest and the pipeline review are OUTPUTS. When they disagree
 * with each other, reading them harder cannot settle which is right, and
 * picking the field that looks more plausible is how a wrong number becomes
 * canonical. This prints what the sources actually say, so a conflict is
 * resolved against evidence rather than against the more confident renderer.
 *
 * Every line carries where it came from and one of three states:
 *
 *   VERIFIED   a record exists that directly establishes the fact
 *   UNVERIFIED the fact is claimed somewhere but nothing establishes it
 *   INFERRED   derived from something else, and said so
 *
 * All relative time is computed here from timestamps. Nothing in this file asks
 * a model what "26 days silent" means, because that is arithmetic and a model
 * that gets it wrong is indistinguishable from one that gets it right.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

/** Outcomes that mean a row exists but no conversation happened on it. */
const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled", "placeholder", "capture_failed"]);

type V = "VERIFIED" | "UNVERIFIED" | "INFERRED" | "UNABLE TO VERIFY";

const DAY = 86_400_000;
const now = Date.now();
const daysAgo = (iso: string | null | undefined): number | null =>
  iso && Number.isFinite(Date.parse(iso)) ? Math.floor((now - Date.parse(iso)) / DAY) : null;
const d = (iso: string | null | undefined): string =>
  iso && Number.isFinite(Date.parse(iso))
    ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : "(none)";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * What a call row actually establishes.
 *
 * A calendar invite proves a meeting was SCHEDULED and nothing more. A stored
 * transcript proves it happened. A recorded no-show proves it did not. A lobby
 * timeout is undecidable and always will be: a bot outside the room cannot see
 * whether anyone is inside it, so "nobody came" and "nobody admitted the bot"
 * produce identical histories.
 */
function meetingState(c: {
  scheduled_start: string | null;
  outcome: string | null;
  capture_class: string | null;
  capture_sub_code: string | null;
  transcriptChars: number;
}): { state: string; verification: V; why: string } {
  const past = c.scheduled_start ? Date.parse(c.scheduled_start) < now : false;
  if (c.transcriptChars > 0 && !(c.outcome && NO_CONTENT.has(c.outcome))) {
    // A no-show still produces a transcript: joining noise, "okay", "I'll be on
    // the line", about a thousand characters of nothing. It passes any length
    // check, which is why outcome is the real filter. Where outcome is silent
    // and the body is this short, say so rather than calling it a conversation.
    if (c.transcriptChars < 2000) {
      return {
        state: "RAN_BUT_NO_CONVERSATION",
        verification: "UNABLE TO VERIFY",
        why: `transcript is only ${c.transcriptChars} chars, which is the size of joining noise rather than a conversation`,
      };
    }
    return { state: "COMPLETED", verification: "VERIFIED", why: `transcript stored, ${c.transcriptChars} chars` };
  }
  if (c.capture_class === "no_show" || c.outcome === "no_show") {
    return { state: "NO_SHOW", verification: "VERIFIED", why: `capture_class=${c.capture_class ?? "-"} outcome=${c.outcome ?? "-"}` };
  }
  if (c.capture_class === "lobby_timeout") {
    return {
      state: "UNABLE_TO_VERIFY",
      verification: "UNABLE TO VERIFY",
      why: "bot never admitted; a lobby timeout cannot distinguish a meeting that ran from one that did not",
    };
  }
  if (c.capture_class === "lobby_refused") {
    // Someone was inside the room to press deny, so the meeting demonstrably
    // RAN. That is a different fact from a lobby timeout, where nobody may have
    // been there at all. The content is unknown; the occurrence is not.
    return {
      state: "RAN_CONTENT_UNKNOWN",
      verification: "VERIFIED",
      why: "bot was refused entry, which proves a human was in the meeting; content not captured",
    };
  }
  if (c.outcome === "capture_failed" || c.capture_class === "never_joined" || c.capture_class === "media_lost") {
    return {
      state: "UNABLE_TO_VERIFY",
      verification: "UNABLE TO VERIFY",
      why: `capture did not produce a transcript (${c.capture_class ?? c.outcome})`,
    };
  }
  if (!past) return { state: "SCHEDULED", verification: "VERIFIED", why: "future calendar event" };
  return {
    state: "UNABLE_TO_VERIFY",
    verification: "UNABLE TO VERIFY",
    why: "date has passed and no capture evidence of any kind exists on the row",
  };
}

async function main(): Promise<void> {
  const q = (arg("--deal") ?? "").trim();
  if (!q) {
    console.log("Usage: --deal <account fragment> [--json]");
    process.exit(1);
  }
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  const { data: deals } = await db
    .from("deals")
    .select("id, account, stage_key, rep_forecast_probability, rep_forecast_close_date, arr, rep_email, outcome_label, rolldog_opportunity_id, salesforce_account_id, updated_at")
    .eq("tenant_id", tenantId)
    .ilike("account", `%${q}%`);
  if (!deals?.length) {
    console.log(`NO DEAL matching ${q}`);
    process.exit(1);
  }

  for (const deal of deals) {
    console.log("\n" + "=".repeat(78));
    console.log(`DEAL  ${deal.account}   rep=${deal.rep_email ?? "?"}   id=${deal.id}`);
    console.log("=".repeat(78));

    console.log("\n-- CRM (authoritative for what the REP entered, not for customer reality)");
    console.log(`   stage_key            ${deal.stage_key}                      [VERIFIED  source=deals]`);
    console.log(`   rep close date       ${d(deal.rep_forecast_close_date)}     [VERIFIED  source=deals.rep_forecast_close_date]`);
    console.log(`   arr (annualised)     ${deal.arr ?? "(none)"}                [VERIFIED  source=deals.arr]`);
    console.log(`   outcome_label        ${deal.outcome_label ?? "(none)"}`);
    console.log(`   rolldog opp          ${deal.rolldog_opportunity_id ?? "(none)"}`);
    console.log(`   salesforce account   ${deal.salesforce_account_id ?? "(none)"}`);

    const { data: calls } = await db
      .from("calls")
      .select("id, title, scheduled_start, call_date, outcome, capture_class, capture_sub_code, capture_detail, recall_bot_id, participants, organizer_email, ingest_error")
      .eq("deal_id", deal.id)
      .order("scheduled_start", { ascending: true });

    const ids = (calls ?? []).map((c) => c.id);
    const txChars = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 100) {
      const { data: tx } = await db.from("transcripts").select("call_id, body").in("call_id", ids.slice(i, i + 100));
      for (const t of tx ?? []) txChars.set(t.call_id, String(t.body ?? "").length);
    }

    console.log(`\n-- MEETINGS (${calls?.length ?? 0}). Calendar proves SCHEDULED; only capture proves what happened.`);
    let lastVerifiedConversation: string | null = null;
    for (const c of calls ?? []) {
      const chars = txChars.get(c.id) ?? 0;
      const ms = meetingState({ ...c, transcriptChars: chars });
      if (ms.state === "COMPLETED") {
        const when = c.call_date ?? c.scheduled_start;
        if (when && (!lastVerifiedConversation || when > lastVerifiedConversation)) lastVerifiedConversation = when;
      }
      const when = c.scheduled_start ?? c.call_date;
      console.log(
        `   ${d(when)}  ${String(ms.state).padEnd(17)} [${ms.verification}]  ${(c.title ?? "(untitled)").slice(0, 52)}`,
      );
      console.log(`        why: ${ms.why}`);
      if (c.capture_sub_code) console.log(`        sub_code: ${c.capture_sub_code}`);
      if (c.ingest_error) console.log(`        ingest_error: ${String(c.ingest_error).slice(0, 110)}`);
    }

    const { data: msgs } = await db
      .from("deal_messages")
      .select("direction, sent_at, from_email, subject, customer_side, is_calendar_response")
      .eq("deal_id", deal.id)
      .order("sent_at", { ascending: false })
      .limit(40);
    const real = (msgs ?? []).filter((m) => !m.is_calendar_response);
    const lastCust = real.find((m) => m.customer_side === true || m.direction === "inbound");
    const lastRep = real.find((m) => m.customer_side === false || m.direction === "outbound");

    console.log(`\n-- EMAIL (${real.length} non-calendar messages)`);
    console.log(`   last customer msg    ${d(lastCust?.sent_at)}  ${lastCust ? `(${daysAgo(lastCust.sent_at)}d ago)` : ""}  [${lastCust ? "VERIFIED" : "UNVERIFIED"}  source=deal_messages]`);
    console.log(`   last rep msg         ${d(lastRep?.sent_at)}   ${lastRep ? `(${daysAgo(lastRep.sent_at)}d ago)` : ""}`);
    const since = lastCust?.sent_at ? Date.parse(lastCust.sent_at) : 0;
    const repSince = real.filter((m) => (m.customer_side === false || m.direction === "outbound") && Date.parse(m.sent_at ?? "") > since).length;
    console.log(`   rep follow-ups since customer last wrote: ${repSince}   [computed from timestamps]`);
    for (const m of real.slice(0, 6)) {
      console.log(`     ${d(m.sent_at)}  ${(m.customer_side ? "CUSTOMER" : "rep     ")}  ${(m.subject ?? "").slice(0, 58)}`);
    }

    console.log("\n-- DERIVED (deterministic, not model output)");
    console.log(`   last VERIFIED customer conversation  ${d(lastVerifiedConversation)}  ${lastVerifiedConversation ? `(${daysAgo(lastVerifiedConversation)}d ago)` : "[none ever]"}`);
    const lastAny =
      ([lastVerifiedConversation, lastCust?.sent_at ?? null].filter((x): x is string => Boolean(x)).sort().pop()) ?? null;
    console.log(`   last VERIFIED customer activity      ${d(lastAny)}  ${lastAny ? `(${daysAgo(lastAny)}d ago)` : "[none ever]"}`);
    const future = (calls ?? []).filter((c) => c.scheduled_start && Date.parse(c.scheduled_start) > now);
    console.log(`   future scheduled meetings            ${future.length ? future.map((f) => `${d(f.scheduled_start)} ${(f.title ?? "").slice(0, 40)}`).join("; ") : "(none)  -> next step is NOT booked"}`);

    const { data: snaps } = await db
      .from("deal_signal_snapshots")
      .select("snapshot_date, dealripe_forecast, rep_commit")
      .eq("deal_id", deal.id)
      .order("snapshot_date", { ascending: false })
      .limit(3);
    console.log("\n-- SNAPSHOTS (prior weekly state)");
    for (const s of snaps ?? []) console.log(`   ${s.snapshot_date}  dealripe=${JSON.stringify(s.dealripe_forecast)?.slice(0, 60) ?? "-"}  rep=${s.rep_commit ?? "-"}`);
  }
  console.log("");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
