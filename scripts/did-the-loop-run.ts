/**
 * For calls that have already happened: did the whole loop actually run?
 *
 * Written after an hour spent trying to ask Recall whether a bot was pointed at
 * the right meeting. Recall's bot resource returns null for every URL field and
 * "unknown" for every status, so that question has no answer from that side. But
 * it never needed one. A bot in the wrong meeting produces no transcript, and a
 * transcript is a fact we already store. The downstream question, did the rep
 * get anything, is answerable the same way.
 *
 * So this walks today's completed calls and reports the five things in order,
 * each as a fact rather than an inference:
 *
 *   TRANSCRIPT  the bot was in the room and captured audio
 *   EXTRACTED   the framework was filled from that transcript
 *   RECAP       an email was archived in sent_messages for this call
 *   DRAFT       a follow-up draft was archived for this call
 *   ROLLDOG     the write target resolves and authorizes
 *
 * A blank in an early column explains every blank after it, so read left to
 * right and stop at the first gap. That ordering is the whole point: without it
 * a missing recap looks like a mail problem when it is really a capture problem.
 *
 *   npx tsx scripts/did-the-loop-run.ts
 *   npx tsx scripts/did-the-loop-run.ts --hours 24
 *   npx tsx scripts/did-the-loop-run.ts --deal Beeimagine
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const yes = (b: boolean) => (b ? "yes" : "NO ");

async function main(): Promise<void> {
  const hours = Number(arg("--hours") ?? 12);
  const dealFilter = arg("--deal")?.toLowerCase() ?? null;

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const since = new Date(Date.now() - hours * 3_600_000).toISOString();
  const now = new Date().toISOString();

  const calls = await db
    .from("calls")
    .select(
      "id, deal_id, title, scheduled_start, created_at, recall_bot_id, transcript_id, has_been_extracted, outcome, ingest_error, briefing_sent_at",
    )
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", since)
    .lte("scheduled_start", now)
    .order("scheduled_start", { ascending: true });
  if (calls.error) throw new Error(calls.error.message);

  const deals = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence, rep_email")
    .eq("tenant_id", tenantId);
  if (deals.error) throw new Error(deals.error.message);
  const dealById = new Map((deals.data ?? []).map((d) => [d.id, d]));

  const rows = (calls.data ?? []).filter((c) => {
    if (!dealFilter) return true;
    const d = dealById.get(c.deal_id);
    return (d?.account ?? "").toLowerCase().includes(dealFilter);
  });

  if (rows.length === 0) {
    console.log(`\nNo calls in the last ${hours} hours.\n`);
    return;
  }

  // One query for every archived message on these calls, rather than one per
  // call. Absence here means no row was archived, which is not quite the same
  // as "no mail was sent", since recordSentMessage swallows its own errors. Say
  // so rather than promoting it to a verdict.
  // Transcripts live in their own table keyed by call_id. `calls.transcript_id`
  // is a different field and is mostly null, so the first version of this
  // script reported "no transcript" for a call whose full transcript was
  // sitting in Supabase and rendering in the UI. Ask the table that holds the
  // thing, not a column that happens to be named after it.
  const trs = await db
    .from("transcripts")
    .select("call_id")
    .eq("tenant_id", tenantId)
    .in("call_id", rows.map((r) => r.id));
  const haveTranscript = new Set((trs.data ?? []).map((t) => String(t.call_id)));

  const msgs = await db
    .from("sent_messages")
    .select("call_id, kind, to_email, subject")
    .eq("tenant_id", tenantId)
    .in("call_id", rows.map((r) => r.id));
  const byCall = new Map<string, Array<{ kind: string; to: string }>>();
  if (!msgs.error) {
    for (const m of msgs.data ?? []) {
      if (!m.call_id) continue;
      const l = byCall.get(m.call_id) ?? [];
      l.push({ kind: String(m.kind), to: String(m.to_email ?? "") });
      byCall.set(m.call_id, l);
    }
  }

  console.log("");
  console.log(`Calls in the last ${hours} hours, ${rows.length} of them.`);
  if (msgs.error) {
    console.log(`sent_messages could not be read (${msgs.error.message}), so RECAP and DRAFT below are UNKNOWN, not "no".`);
  }
  console.log("");

  for (const c of rows) {
    const d = dealById.get(c.deal_id);
    const sent = byCall.get(c.id) ?? [];
    const recap = sent.filter((m) => /recap/i.test(m.kind));
    const draft = sent.filter((m) => /draft|follow/i.test(m.kind));

    // The real function, given the real deal row. Not a restatement of its
    // rules: a checker that can disagree with the code it checks will.
    const target = d
      ? resolveWriteTarget(d)
      : { authorized: false as const, reason: "deal row not found", opportunityId: null };

    console.log(`${formatMeetingTime(c.scheduled_start)}   ${(c.title ?? "(untitled)").slice(0, 54)}`);
    console.log(`   deal        ${d?.account ?? "?"}   rep ${(d?.rep_email ?? "?").split("@")[0]}`);
    // Print the id. Two rows for one meeting is common enough here that any
    // finding stated without it cannot be matched up against another script's
    // output, which is how "the briefing failed" and "the briefing went to the
    // other row" get confused for each other.
    console.log(`   call id     ${c.id}   row created ${formatMeetingTime(c.created_at)}`);
    // transcript_id is NOT the capture signal, which this script learned the
    // embarrassing way: the Gezairi call had a null transcript_id and had
    // nonetheless extracted, sent a recap and written a draft. The id is not
    // always persisted, so reading its absence as "nothing was captured" is the
    // same false negative this codebase keeps producing. Capture is evidenced by
    // outcome, by extraction, or by the id, in that order of reliability.
    // Briefing first, because it happens first. Leaving it out let a call read
    // as a clean success when the briefing had actually gone to a different row
    // for the same meeting, which is the state Gezairi was in.
    console.log(
      `   briefing    ${c.briefing_sent_at ? `sent ${formatMeetingTime(c.briefing_sent_at)}` : "NO"}`,
    );

    const transcriptStored = haveTranscript.has(c.id);
    const captured =
      transcriptStored || c.outcome === "captured" || Boolean(c.has_been_extracted);
    console.log(
      `   transcript  ${yes(transcriptStored)}` +
        (trs.error ? "  (transcripts table unreadable, this is unknown not no)" : "") +
        (c.outcome ? `   outcome ${c.outcome}` : "   outcome not set yet") +
        (c.ingest_error ? `\n   ingest err  ${c.ingest_error}` : ""),
    );
    console.log(`   extracted   ${yes(Boolean(c.has_been_extracted))}`);
    console.log(
      `   recap       ${msgs.error ? "unknown" : recap.length > 0 ? `yes -> ${recap.map((m) => m.to.split("@")[0]).join(", ")}` : "NO"}`,
    );
    console.log(
      `   draft       ${msgs.error ? "unknown" : draft.length > 0 ? `yes -> ${draft.map((m) => m.to.split("@")[0]).join(", ")}` : "NO"}`,
    );
    console.log(
      `   rolldog     ${target.authorized ? `authorized, opp ${target.opportunityId}` : `not authorized: ${target.reason}`}`,
    );

    // Only explain the blanks when there is genuinely no sign of capture AND
    // nothing downstream ran. Printing this line under a call that had already
    // extracted and mailed was worse than printing nothing: it handed you a
    // confident causal story for an event that did not happen.
    const anythingDownstream = Boolean(c.has_been_extracted) || recap.length > 0 || draft.length > 0;
    if (!captured && !anythingDownstream) {
      const age = Date.now() - Date.parse(String(c.scheduled_start ?? ""));
      console.log(
        Number.isFinite(age) && age < 90 * 60_000
          ? `   -> Nothing yet, but this call ended recently. Transcription and the 5 minute cron mean this is normal for up to about an hour. Not a failure yet.`
          : `   -> No sign of capture and nothing downstream. This one is worth looking at.`,
      );
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
