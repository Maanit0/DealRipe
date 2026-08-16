/**
 * Capture health, per rep and overall, over any window.
 *
 * The number this produces goes to a CRO, so the rules it counts by have to be
 * the rules production decides by. It imports classifyCapture and
 * verdictFromOutcome from lib/capture-classify.ts and computes nothing of its
 * own. A checker that can disagree with the code it checks will, and it will
 * do so confidently: that has already happened twice in this codebase, once
 * reporting two healthy running deals as nonexistent and once reporting four
 * writable deals as blocked on the day one of them wrote.
 *
 * Six categories plus one that is not a category:
 *
 *   captured        a conversation was recorded and extracted
 *   no-show         the bot got in and there was nothing to capture. Not a
 *                   failure. Counting these as failures understates the
 *                   product, which is the reason this script exists
 *   lobby timeout   the bot was never admitted, and Recall cannot tell us
 *                   whether the meeting ran without it or never happened.
 *                   Reported as itself, never folded into either side
 *   bot refused     a human denied the bot entry. Counted as a loss only when
 *                   the CUSTOMER organized the meeting. In one of ours the hand
 *                   on the deny button was Magaya's, and a rep keeping a
 *                   conversation private is the product working
 *   never joined    the join link was unusable
 *   media failure   the bot recorded and the recording is gone
 *   unknown         with the reason we cannot say. NEVER folded into a failure
 *                   category, and printed with its reason so the gap is
 *                   visible rather than absorbed
 *
 * Capture rate is reported three ways on purpose. One number that silently
 * picks a side for the undecidable calls is the thing this replaces.
 *
 * READ ONLY.
 *
 *   npx tsx scripts/capture-health.ts
 *   npx tsx scripts/capture-health.ts --days 30
 *   npx tsx scripts/capture-health.ts --days 14 --detail
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  classifyCapture,
  hostSideOf,
  verdictFromOutcome,
  type CaptureCategory,
  type FailureVerdict,
  type CaptureStatusChange,
  type CaptureVerdict,
} from "../lib/capture-classify";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { formatMeetingTime } from "../lib/graph-time";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Outcomes that were never an attempt to capture anything: a placeholder, a
 * duplicate row, a meeting that moved. They are out of both the numerator and
 * the denominator because including them would make the rate a measure of how
 * tidy the calendar is.
 */
const NOT_AN_ATTEMPT = new Set(["placeholder", "duplicate", "discarded", "rescheduled"]);

const LABEL: Record<CaptureCategory, string> = {
  captured: "captured",
  no_show: "no-show",
  lobby_timeout: "lobby timeout",
  lobby_refused: "bot refused",
  never_joined: "never joined",
  media_lost: "media failure",
  unknown: "unknown",
};

/** Print order, so the eye lands on the same row every time. */
const ORDER: CaptureCategory[] = [
  "captured",
  "no_show",
  "lobby_timeout",
  "lobby_refused",
  "never_joined",
  "media_lost",
  "unknown",
];

type Row = {
  id: string;
  title: string | null;
  scheduled_start: string | null;
  call_date: string | null;
  outcome: string | null;
  recall_bot_id: string | null;
  has_been_extracted: boolean;
  organizer_email: string | null;
  capture_evidence: string | null;
  capture_class: string | null;
  capture_sub_code: string | null;
  capture_detail: string | null;
  capture_status_changes: unknown;
  deals: { account: string; rep_email: string | null };
};

type Tally = {
  counts: Map<CaptureCategory, number>;
  /** The verdicts as the classifier gave them. The rate is computed from these. */
  verdicts: Map<FailureVerdict, number>;
  /** Unknowns keep their reasons. A count of unknowns with no reasons is useless. */
  unknownReasons: string[];
  /** And so do the decidable-looking categories that turned out not to be. */
  undecidableReasons: string[];
  total: number;
};

function emptyTally(): Tally {
  return {
    counts: new Map(),
    verdicts: new Map(),
    unknownReasons: [],
    undecidableReasons: [],
    total: 0,
  };
}

/**
 * The verdict for one stored call.
 *
 * Order of preference, and the reason for it:
 *
 *   1. What the outcome already establishes. A captured call has a transcript;
 *      there is nothing for the classifier to add.
 *   2. The stored evidence, run through the production classifier. Not the
 *      stored capture_class: re-deriving from the observations means a change
 *      to the classifier shows up here without a backfill, and means this
 *      script cannot silently disagree with production about the same bytes.
 *   3. Unknown, saying which of "not checked" and "unavailable" it is.
 */
function verdictFor(r: Row): CaptureVerdict {
  const fromOutcome = verdictFromOutcome(r.outcome);
  if (fromOutcome) return fromOutcome;

  if (r.capture_evidence === "observed" && Array.isArray(r.capture_status_changes)) {
    return classifyCapture({
      evidence: {
        state: "observed",
        statusChanges: r.capture_status_changes as CaptureStatusChange[],
        // Stored only for bots that produced no media; a bot with media never
        // reaches the failure path that writes these columns.
        hasMedia: false,
        recordingCount: 0,
      },
      hostSide: hostSideOf(r.organizer_email, "magaya.com"),
    });
  }

  if (r.capture_evidence === "unavailable") {
    return classifyCapture({
      evidence: {
        state: "unavailable",
        reason: r.capture_detail ?? "Recall could not be read for this call",
        expired: (r.capture_detail ?? "").includes("no longer has"),
      },
    });
  }

  return classifyCapture({
    evidence: { state: "not_checked", reason: notCheckedReason(r) },
  });
}

/**
 * Why we cannot say, in words that name what to go and fix.
 *
 * "outcome carries no capture verdict" is true and useless. The three ways a
 * call ends up here need three different people to do three different things,
 * and the first of them was invisible until this script existed: a row whose
 * bot was never dispatched is not polled by transcript-sync (its main loop
 * filters on recall_bot_id not null), is not listed by capture-failures.ts
 * (which queries outcome='capture_failed'), and carries no ingest_error. It
 * sits untouched forever, and the createBot failure that produced it survives
 * only as a log line.
 *
 * calendar-sync does retry a row with no bot, but only while the meeting is
 * still ahead of it on the calendar. Once the meeting is in the past the event
 * leaves the lookahead window and the row is orphaned.
 */
function notCheckedReason(r: Row): string {
  if (r.outcome === "capture_failed") {
    return "marked capture_failed before diagnostics were recorded; run scripts/backfill-capture-diagnostics.ts";
  }
  if (r.recall_bot_id === null) {
    // calendar-sync records the dispatch failure on the row now. Rows orphaned
    // before it did get the generic sentence, which is still the truth: it
    // says we do not know why, rather than inventing a reason.
    return r.capture_detail !== null
      ? `${r.capture_detail}. Whether the meeting happened is unknown.`
      : "no bot was ever dispatched for this meeting, so nothing was attempted and nothing polls it. " +
          "calendar-sync created the row and bot creation never landed, before the reason was recorded anywhere durable. " +
          "Whether the meeting happened is unknown.";
  }
  if (!r.has_been_extracted) {
    return `a bot was dispatched and transcript-sync has not resolved it; outcome is still unset ${
      r.outcome === null ? "(null)" : `('${r.outcome}')`
    }`;
  }
  return `the call was marked extracted but no outcome was recorded ${
    r.outcome === null ? "(null)" : `('${r.outcome}')`
  }, so what it produced is not established`;
}

function add(t: Tally, v: CaptureVerdict): void {
  t.counts.set(v.category, (t.counts.get(v.category) ?? 0) + 1);
  // Counted from the verdict, never re-derived from the category. Whether a
  // refusal is a loss depends on whose meeting it was, and that decision lives
  // in lib/capture-classify.ts. Reading it off the category here is how this
  // script would come to disagree with production about the same rows.
  t.verdicts.set(v.countsAsCaptureFailure, (t.verdicts.get(v.countsAsCaptureFailure) ?? 0) + 1);
  t.total += 1;
  if (v.category === "unknown") t.unknownReasons.push(v.detail);
  if (v.countsAsCaptureFailure === "undecidable" && v.category !== "unknown") {
    t.undecidableReasons.push(v.detail);
  }
}

/**
 * Three rates, because there is no single honest one while lobby timeouts
 * exist.
 *
 *   floor    every undecidable counted as a loss
 *   ceiling  every undecidable counted as not our loss
 *   known    undecidables excluded from both sides
 *
 * When floor and ceiling are far apart, that gap is the finding: it is the
 * number of calls whose fate we genuinely cannot establish, and closing it
 * needs evidence from outside Recall.
 */
function rates(t: Tally): { floor: number; ceiling: number; known: number; denominator: number } | null {
  const captured = t.counts.get("captured") ?? 0;
  // 'no' covers captured plus no-shows; a no-show had no conversation to
  // capture and belongs in neither half, so it is subtracted back out rather
  // than counted as a success.
  const definiteLoss = t.verdicts.get("yes") ?? 0;
  const undecidable = t.verdicts.get("undecidable") ?? 0;

  const denominator = captured + definiteLoss + undecidable;
  if (denominator === 0) return null;

  const knownDenominator = captured + definiteLoss;
  return {
    floor: Math.round((captured / denominator) * 100),
    ceiling: Math.round(((captured + undecidable) / denominator) * 100),
    known: knownDenominator === 0 ? 0 : Math.round((captured / knownDenominator) * 100),
    denominator,
  };
}

function printTally(heading: string, t: Tally, indent = ""): void {
  console.log(`${indent}${heading}`);
  for (const c of ORDER) {
    const n = t.counts.get(c) ?? 0;
    if (n === 0) continue;
    console.log(`${indent}  ${String(n).padStart(4)}  ${LABEL[c]}`);
  }
  const r = rates(t);
  if (r === null) {
    console.log(`${indent}  no calls that attempted a capture, so no rate. That is not a rate of 100%.`);
    return;
  }
  const undecidable = t.verdicts.get("undecidable") ?? 0;
  if (undecidable === 0) {
    console.log(`${indent}  capture rate ${r.floor}% of ${r.denominator}`);
  } else {
    console.log(
      `${indent}  capture rate between ${r.floor}% and ${r.ceiling}% of ${r.denominator}, ` +
        `${r.known}% of the ${r.denominator - undecidable} we can decide`,
    );
    console.log(
      `${indent}  ${undecidable} call(s) undecidable, so the true figure sits inside that range`,
    );
  }
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? "14");
  const detail = process.argv.includes("--detail");
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const res = await db
    .from("calls")
    .select(
      "id, title, scheduled_start, call_date, outcome, recall_bot_id, has_been_extracted, organizer_email, capture_evidence, capture_class, capture_sub_code, capture_detail, capture_status_changes, deals!inner(account, rep_email)",
    )
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", since)
    .lte("scheduled_start", new Date().toISOString())
    .order("scheduled_start", { ascending: false });
  if (res.error) throw new Error(res.error.message);

  const all = (res.data ?? []) as unknown as Row[];
  const rows = all.filter((r) => !NOT_AN_ATTEMPT.has(String(r.outcome ?? "")));

  const overall = emptyTally();
  const byRep = new Map<string, Tally>();
  const detailRows: Array<{ row: Row; verdict: CaptureVerdict }> = [];

  for (const r of rows) {
    const v = verdictFor(r);
    add(overall, v);
    const rep = r.deals.rep_email ?? "(no rep on the deal)";
    if (!byRep.has(rep)) byRep.set(rep, emptyTally());
    add(byRep.get(rep) as Tally, v);
    if (v.category !== "captured") detailRows.push({ row: r, verdict: v });
  }

  console.log(`\n${"=".repeat(78)}`);
  console.log(`CAPTURE HEALTH, last ${days} days`);
  console.log(
    `${rows.length} call(s) that attempted a capture; ` +
      `${all.length - rows.length} placeholder, duplicate or moved and excluded from both sides.`,
  );
  console.log(`${"=".repeat(78)}\n`);

  printTally("OVERALL", overall);

  console.log(`\n${"-".repeat(78)}\nPER REP\n${"-".repeat(78)}`);
  const reps = [...byRep.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [rep, t] of reps) {
    console.log("");
    printTally(rep, t, "  ");
  }

  if (overall.unknownReasons.length > 0) {
    console.log(`\n${"-".repeat(78)}`);
    console.log(`UNKNOWN, WITH THE REASON  (${overall.unknownReasons.length})`);
    console.log(
      `Not failures and not successes. Each of these is a call whose fate we cannot\n` +
        `establish, listed so the gap stays visible instead of being absorbed into a\n` +
        `number that looks complete.`,
    );
    console.log(`${"-".repeat(78)}`);
    const grouped = new Map<string, number>();
    for (const reason of overall.unknownReasons) {
      grouped.set(reason, (grouped.get(reason) ?? 0) + 1);
    }
    for (const [reason, n] of [...grouped.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}  ${reason}`);
    }
  }

  if (detail && detailRows.length > 0) {
    console.log(`\n${"-".repeat(78)}\nEVERY CALL THAT DID NOT PRODUCE A TRANSCRIPT\n${"-".repeat(78)}`);
    for (const { row, verdict } of detailRows) {
      console.log(
        `\n${row.deals.account}   ${formatMeetingTime(row.scheduled_start ?? row.call_date)}   ${
          row.deals.rep_email ?? "(no rep)"
        }`,
      );
      console.log(`  ${row.title ?? "(no title)"}`);
      console.log(`  ${LABEL[verdict.category].toUpperCase()}  (${verdict.basis} evidence)`);
      console.log(`  ${verdict.detail}`);
    }
  }

  console.log(`\n${"=".repeat(78)}\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
