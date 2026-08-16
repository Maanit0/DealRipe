/**
 * Recover why each lost call was lost, while Recall still remembers.
 *
 * Every call marked capture_failed before 2026-08-16 carries the sentence "bot
 * done but media unavailable" and nothing else. That sentence is a conclusion,
 * it was drawn from the wrong array element, and for thirteen of the fourteen
 * calls in the Magaya pilot it is wrong: those bots never recorded anything, so
 * there was never any media to be unavailable. They were refused entry.
 *
 * Recall still holds the status history that says so. It will not hold it
 * forever. This re-fetches each bot and stores the observations, so the answer
 * survives Recall forgetting.
 *
 * What it will not do:
 *
 *   - guess. A bot Recall has forgotten is recorded as evidence no longer
 *     available, with capture_class 'unknown'. Never a null, which the next
 *     reader would take for "no reason", and never a plausible cause inferred
 *     from the calls around it.
 *   - overwrite evidence with the absence of it. A row already carrying
 *     capture_evidence='observed' is left alone unless --refresh is passed,
 *     because re-asking later can only ever downgrade it.
 *   - decide a lobby timeout. See lib/capture-classify.ts: a bot that waited
 *     outside the room cannot tell whether anyone was inside it.
 *
 * Reclassification is separate and opt-in. --reclassify moves a call whose
 * evidence shows the bot got in and nobody came from capture_failed to
 * no_conversation, because that is a no-show and not our failure. It fires no
 * follow-up and writes to no CRM: those are live-pipeline side effects and the
 * meetings are days old.
 *
 * Dry run by default.
 *
 *   npx tsx scripts/backfill-capture-diagnostics.ts
 *   npx tsx scripts/backfill-capture-diagnostics.ts --days 90
 *   npx tsx scripts/backfill-capture-diagnostics.ts --apply        # WRITES
 *   npx tsx scripts/backfill-capture-diagnostics.ts --apply --reclassify
 *   npx tsx scripts/backfill-capture-diagnostics.ts --apply --refresh
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  captureColumns,
  classifyCapture,
  hostSideOf,
  readCaptureEvidence,
  type CaptureEvidence,
  type CaptureVerdict,
} from "../lib/capture-classify";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { formatMeetingTime } from "../lib/graph-time";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Row = {
  id: string;
  title: string | null;
  scheduled_start: string | null;
  call_date: string | null;
  recall_bot_id: string | null;
  outcome: string | null;
  capture_evidence: string;
  organizer_email: string | null;
  deals: { account: string; rep_email: string | null };
};

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? "60");
  const apply = process.argv.includes("--apply");
  const refresh = process.argv.includes("--refresh");
  const reclassify = process.argv.includes("--reclassify");
  const classifySuccesses = process.argv.includes("--classify-successes");
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  if (classifySuccesses) {
    await classifySuccessfulCaptures(tenantId, db, apply);
    return;
  }

  const res = await db
    .from("calls")
    .select(
      "id, title, scheduled_start, call_date, recall_bot_id, outcome, capture_evidence, organizer_email, deals!inner(account, rep_email)",
    )
    .eq("tenant_id", tenantId)
    .eq("outcome", "capture_failed")
    .gte("scheduled_start", since)
    .order("scheduled_start", { ascending: false });
  if (res.error) throw new Error(res.error.message);

  const rows = (res.data ?? []) as unknown as Row[];

  console.log(`\n${"=".repeat(78)}`);
  console.log(`CAPTURE DIAGNOSTIC BACKFILL, last ${days} days`);
  console.log(`${apply ? "APPLY: this writes to the calls table." : "Dry run. Pass --apply to write."}`);
  console.log(`${"=".repeat(78)}`);

  if (rows.length === 0) {
    console.log(`\nNo capture_failed calls in this window.\n`);
    return;
  }

  const byClass = new Map<string, number>();
  let expired = 0;
  let skipped = 0;
  let written = 0;
  let reclassified = 0;
  const stillUndecidable: Row[] = [];

  for (const r of rows) {
    const when = formatMeetingTime(r.scheduled_start ?? r.call_date);
    console.log(`\n${r.deals.account}   ${when}   ${r.deals.rep_email ?? "(no rep)"}`);
    console.log(`  ${r.title ?? "(no title)"}`);

    // Already established. Re-asking Recall can only lose information.
    if (r.capture_evidence === "observed" && !refresh) {
      console.log(`  already has observed evidence; leaving it. Pass --refresh to re-read it.`);
      skipped++;
      continue;
    }

    const evidence: CaptureEvidence = await readCaptureEvidence(r.recall_bot_id);
    const verdict: CaptureVerdict = classifyCapture({
      evidence,
      // Whose lobby the bot was in. Decides whether a refusal was a loss or a
      // rep keeping a conversation private.
      hostSide: hostSideOf(r.organizer_email, "magaya.com"),
    });

    byClass.set(verdict.category, (byClass.get(verdict.category) ?? 0) + 1);
    if (evidence.state === "unavailable" && evidence.expired) expired++;
    if (verdict.countsAsCaptureFailure === "undecidable") stillUndecidable.push(r);

    console.log(`  evidence   ${evidence.state}`);
    if (evidence.state === "observed") {
      console.log(
        `  history    ${evidence.statusChanges
          .map((c) => `${c.code}${c.subCode ? `(${c.subCode})` : ""}`)
          .join(" -> ")}`,
      );
    }
    console.log(`  verdict    ${verdict.category.toUpperCase()}: ${verdict.detail}`);
    console.log(
      `  counts as a capture failure: ${verdict.countsAsCaptureFailure}` +
        (verdict.countsAsCaptureFailure === "undecidable"
          ? "   <-- reported as itself, folded into neither side"
          : ""),
    );

    const cols = captureColumns(evidence, verdict);

    // A bot that got in and found nobody there is a no-show. That is the
    // meeting not happening, not the product failing, and it should not be in
    // the number reported to a CRO as a loss.
    const isNoShow = verdict.category === "no_show";
    if (isNoShow) {
      console.log(
        `  RECLASSIFY: the bot was admitted and no conversation took place, so this is a no-show` +
          (reclassify ? " and outcome moves to no_conversation." : ". Pass --reclassify to move it."),
      );
    }

    if (!apply) continue;

    const upd = await db
      .from("calls")
      .update(
        isNoShow && reclassify
          ? { ...cols, capture_status_changes: cols.capture_status_changes as never, outcome: "no_conversation" }
          : { ...cols, capture_status_changes: cols.capture_status_changes as never },
      )
      .eq("id", r.id);
    if (upd.error) {
      console.log(`  WRITE FAILED: ${upd.error.message}`);
      continue;
    }
    written++;
    if (isNoShow && reclassify) reclassified++;
    console.log(`  written.`);
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(`${rows.length} capture_failed call(s) in the window.`);
  for (const [k, v] of [...byClass.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(3)}  ${k}`);
  }
  if (skipped > 0) {
    console.log(`\n${skipped} already carried observed evidence and were left alone.`);
  }
  if (expired > 0) {
    console.log(
      `\n${expired} bot(s) are gone from Recall. Those are recorded as evidence no longer\n` +
        `available and will never be explainable. Nothing was guessed for them.`,
    );
  }
  if (stillUndecidable.length > 0) {
    console.log(
      `\n${stillUndecidable.length} call(s) remain undecidable. That is the honest answer, not a\n` +
        `gap in this script: a bot that sat in a lobby cannot see whether the meeting ran\n` +
        `without it. Deciding these needs a signal from outside Recall, such as the rep\n` +
        `being asked, or Graph showing the meeting was attended.`,
    );
  }
  if (apply) {
    console.log(`\n${written} row(s) written, ${reclassified} reclassified as no_conversation.`);
  } else {
    console.log(`\nNothing was written. Pass --apply.`);
  }
  console.log(`${"=".repeat(78)}\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});


// ====================================================================
// Successful captures
// ====================================================================

/**
 * Classify the calls that WORKED.
 *
 * The failure backfill leaves capture_class null on every successful call,
 * which makes capture rate uncomputable from capture_class alone: the numerator
 * is classified and the denominator is not. That number goes to Magaya's CRO,
 * and deriving it from `outcome` instead would put two sources under one fact,
 * which is what this whole diagnostic set was written to remove.
 *
 * These need no Recall round trip. A call with a stored transcript was captured
 * by definition, so it goes through classifyCapture with `local` evidence, and
 * capture_evidence honestly stays 'not_checked' because we never asked Recall.
 *
 * Duplicates are skipped rather than classified. A duplicate row is not a call
 * that was captured or missed; it is bookkeeping, and counting it either way
 * would move the rate.
 *
 * Dry run by default, like every other pass here.
 */
async function classifySuccessfulCaptures(
  tenantId: string,
  db: ReturnType<typeof supabaseAdmin>,
  apply: boolean,
): Promise<void> {
  console.log(`\n${"=".repeat(78)}`);
  console.log(`CLASSIFY SUCCESSFUL CAPTURES`);
  console.log(`${apply ? "APPLY: this writes to the calls table." : "Dry run. Pass --apply to write."}`);
  console.log(`${"=".repeat(78)}\n`);

  const res = await db
    .from("calls")
    .select("id, title, scheduled_start, outcome, capture_class, deals!inner(account)")
    .eq("tenant_id", tenantId)
    .is("capture_class", null)
    .lt("scheduled_start", new Date().toISOString())
    .order("scheduled_start", { ascending: false });
  if (res.error) throw new Error(res.error.message);

  const rows = (res.data ?? []) as unknown as Array<{
    id: string;
    title: string | null;
    scheduled_start: string | null;
    outcome: string | null;
    deals: { account: string };
  }>;

  let written = 0;
  let skippedDuplicate = 0;
  const needsRecall: typeof rows = [];

  for (const r of rows) {
    if (r.outcome === "duplicate") {
      skippedDuplicate += 1;
      continue;
    }

    const tr = await db.from("transcripts").select("body").eq("call_id", r.id).maybeSingle();
    const chars = tr.data?.body?.length ?? 0;
    if (chars === 0) {
      // No transcript means local state cannot tell a lobby timeout from a
      // no-show from a media loss. That is Recall's question, not ours.
      needsRecall.push(r);
      continue;
    }

    const verdict = classifyCapture({
      evidence: {
        state: "local",
        transcriptChars: chars,
        reason: `outcome=${r.outcome ?? "null"}`,
      },
    });

    console.log(`  ${r.deals.account.padEnd(24)} ${verdict.category}  (${chars} chars)`);
    if (apply) {
      const upd = await db
        .from("calls")
        .update({
          capture_class: verdict.category,
          capture_detail: verdict.detail,
        })
        .eq("id", r.id);
      if (upd.error) {
        console.log(`      NOT written: ${upd.error.message}`);
      } else {
        written += 1;
      }
    }
  }

  console.log(`\nSUMMARY`);
  console.log(`   classified as captured   ${rows.length - skippedDuplicate - needsRecall.length}`);
  console.log(`   duplicates skipped       ${skippedDuplicate}`);
  console.log(`   no transcript, need Recall to say why   ${needsRecall.length}`);
  if (apply) console.log(`   rows written             ${written}`);
  if (needsRecall.length > 0) {
    console.log(
      `\nThe ${needsRecall.length} without a transcript are NOT failures by default. Local state cannot`,
    );
    console.log(`say why they are empty. Run the main backfill against them to ask Recall:`);
    for (const r of needsRecall.slice(0, 10)) {
      console.log(`   ${r.scheduled_start}  ${r.deals.account}  outcome=${r.outcome ?? "null"}`);
    }
  }
  if (!apply) console.log(`\nRe-run with --apply --classify-successes to write.`);
}
