/**
 * The evidence pack: what DealRipe has actually done at Magaya, in numbers a
 * person can be asked to defend.
 *
 * This exists for an investor conversation, so it obeys one rule above every
 * other: EVERY FIGURE IS COMPUTED FROM THE DATABASE OR FROM A LIVE CRM READ,
 * AND ANYTHING NOT MEASURABLE PRINTS AS "not measured" WITH THE REASON. There
 * are no estimates, no illustrative numbers, no rounding up to a story. A
 * missing number is a fact about our instrumentation and is more useful in a
 * room than a plausible one, because a plausible one gets challenged and
 * cannot be defended.
 *
 * Two things it therefore refuses to print:
 *
 *   The forecast-accuracy tile in lib/forecast-room.ts (90% against the rep's
 *   63%, 184 deals trained on) is a hardcoded constant for the demo tenant. It
 *   has never been computed from a Magaya outcome. It is not in this pack.
 *
 *   A probability-weighted pipeline number. The pilot forecasts in categories,
 *   not probabilities, and the category-to-probability map in forecast-room is
 *   a demo device. Weighting by it would manufacture a dollar figure.
 *
 * Every rule it counts by is imported from the code that produced the rows:
 * classifyCapture from lib/capture-classify.ts, getPipelineChanges from
 * lib/pipeline-changes.ts, getActivityLog from lib/activity-log.ts,
 * autoJoinRepEmails from lib/pilot-config.ts. Nothing here restates a rule. A
 * checker that can disagree with the code it checks will, and it will do so
 * confidently.
 *
 * READ ONLY. Writes nothing, ever, to Supabase or to either CRM.
 *
 *   npx tsx scripts/evidence-pack.ts
 *   npx tsx scripts/evidence-pack.ts --days 30
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getActivityLog, type ActivityEntry } from "../lib/activity-log";
import {
  classifyCapture,
  hostSideOf,
  verdictFromOutcome,
  type CaptureCategory,
  type CaptureStatusChange,
  type CaptureVerdict,
  type FailureVerdict,
} from "../lib/capture-classify";
import type { Tristate } from "../lib/database.types";
import { getPipelineChanges, type DealChangeRecord } from "../lib/pipeline-changes";
import { autoJoinRepEmails } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { adoptionRate, readAdoptionForWindow, summarise } from "../lib/draft-adoption";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

/** Go-live: the first meeting DealRipe ever joined at Magaya. Printed as
 *  context for the window, never used as a filter. */
const GO_LIVE = "2026-07-16";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// =====================================================================
// Printing
// =====================================================================

const W = 78;
const rule = (c = "=") => c.repeat(W);

function heading(n: number, title: string): void {
  console.log(`\n${rule()}`);
  console.log(`${n}. ${title}`);
  console.log(`${rule()}\n`);
}

/**
 * The output this script exists to make possible.
 *
 * A number we did not measure is printed as this, never as zero and never as a
 * range that implies we looked. Every integration in this codebase fails by
 * returning nothing rather than by throwing, so "0" and "we never checked"
 * arrive at the caller looking identical, and the whole pack is worthless if
 * one of them is read as the other in front of an investor.
 */
function notMeasured(label: string, why: string): void {
  console.log(`  ${label}: NOT MEASURED`);
  console.log(`      ${why}`);
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function date10(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "no date recorded";
}

/** Wrap prose to the report width so the whole thing reads aloud cleanly. */
function say(text: string, indent = "  "): void {
  const words = text.split(/\s+/).filter(Boolean);
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > W - indent.length) {
      console.log(indent + line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) console.log(indent + line);
}

// =====================================================================
// 1. Coverage
// =====================================================================

/**
 * Outcomes that were never an attempt to capture anything. Mirrors the set in
 * scripts/capture-health.ts deliberately: both scripts must put the same rows
 * in the denominator or they will quote different capture rates from the same
 * table on the same day.
 */
const NOT_AN_ATTEMPT = new Set(["placeholder", "duplicate", "discarded", "rescheduled"]);

const CATEGORY_LABEL: Record<CaptureCategory, string> = {
  captured: "captured",
  no_show: "no-show (bot got in, nobody to record)",
  lobby_timeout: "never admitted, lobby timed out",
  lobby_refused: "never admitted, a human denied the bot",
  never_joined: "never admitted, the join link was unusable",
  media_lost: "media unavailable",
  unknown: "unknown, with the reason",
};

const CATEGORY_ORDER: CaptureCategory[] = [
  "captured",
  "no_show",
  "lobby_timeout",
  "lobby_refused",
  "never_joined",
  "media_lost",
  "unknown",
];

type CallRow = {
  id: string;
  deal_id: string;
  title: string | null;
  scheduled_start: string | null;
  call_date: string | null;
  outcome: string | null;
  recall_bot_id: string | null;
  has_been_extracted: boolean;
  organizer_email: string | null;
  capture_evidence: string | null;
  capture_detail: string | null;
  capture_status_changes: unknown;
  meeting_type: string | null;
  call_subtype: string | null;
  followup_draft_state: string | null;
  deals: { account: string; rep_email: string | null };
};

/**
 * The verdict for one stored call, from the stored evidence run back through
 * the production classifier.
 *
 * Deliberately re-derived rather than read off the capture_class column, for
 * the same reason scripts/capture-health.ts does it: a change to the
 * classifier then shows up here without waiting for a backfill, and this
 * script cannot come to disagree with production about the same bytes. The
 * rules all live in lib/capture-classify.ts; this only shapes the row.
 */
function verdictFor(r: CallRow): CaptureVerdict {
  const fromOutcome = verdictFromOutcome(r.outcome);
  if (fromOutcome) return fromOutcome;

  if (r.capture_evidence === "observed" && Array.isArray(r.capture_status_changes)) {
    return classifyCapture({
      evidence: {
        state: "observed",
        statusChanges: r.capture_status_changes as CaptureStatusChange[],
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
    evidence: {
      state: "not_checked",
      reason:
        r.recall_bot_id === null
          ? (r.capture_detail ?? "no bot was ever dispatched for this meeting") +
            ". Whether the meeting happened is unknown."
          : `a bot was dispatched and transcript-sync has not resolved it (outcome ${
              r.outcome === null ? "null" : `'${r.outcome}'`
            })`,
    },
  });
}

async function sectionCoverage(
  tenantId: string,
  days: number,
  sinceIso: string,
  calls: CallRow[],
  attempts: CallRow[],
  totalDeals: number,
): Promise<void> {
  heading(1, "COVERAGE");

  const db = supabaseAdmin();

  // ---- Reps live, and since when ----
  // autoJoinRepEmails() is exported by lib/pilot-config.ts precisely so a
  // diagnostic reports the real list instead of re-parsing the env var.
  const reps = autoJoinRepEmails();
  const connRes = await db
    .from("microsoft_connections")
    .select("user_principal_name, connected_at, last_synced_at")
    .eq("tenant_id", tenantId);
  if (connRes.error) {
    notMeasured(
      "Reps live",
      `the microsoft_connections read failed (${connRes.error.message}), so when each rep connected cannot be stated`,
    );
  } else {
    const conn = new Map(
      ((connRes.data ?? []) as Array<{
        user_principal_name: string | null;
        connected_at: string;
      }>).map((r) => [(r.user_principal_name ?? "").toLowerCase(), r.connected_at]),
    );
    console.log(`  Reps under coverage: ${reps.length}`);
    for (const rep of [...reps].sort()) {
      const at = conn.get(rep.toLowerCase());
      console.log(
        `    ${pad(rep, 30)} ${at ? `connected ${date10(at)}` : "NOT MEASURED: no connection row for this address"}`,
      );
    }
    console.log("");
    say(
      "Connection date is when the rep authorized their calendar. It is the date " +
        "from which DealRipe could see their meetings at all, so a rep who " +
        "connected late has fewer calls for a reason that is not about the product.",
    );
  }

  // ---- Deals and calls ----
  const dealsWithCalls = new Set(calls.map((c) => c.deal_id));
  console.log("");
  console.log(`  Deals in the tenant                    ${totalDeals}`);
  console.log(`  Deals with at least one call in window ${dealsWithCalls.size}`);
  console.log(`  Calls on the calendar in window        ${calls.length}`);
  console.log(
    `  Calls that attempted a capture         ${attempts.length}` +
      `   (${calls.length - attempts.length} placeholder, duplicate, discarded or moved, excluded from both sides)`,
  );

  // ---- The classifier ----
  const counts = new Map<CaptureCategory, number>();
  const verdicts = new Map<FailureVerdict, number>();
  const unknownReasons: string[] = [];
  for (const r of attempts) {
    const v = verdictFor(r);
    counts.set(v.category, (counts.get(v.category) ?? 0) + 1);
    verdicts.set(v.countsAsCaptureFailure, (verdicts.get(v.countsAsCaptureFailure) ?? 0) + 1);
    if (v.category === "unknown") unknownReasons.push(v.detail);
  }

  console.log("");
  console.log("  WHAT HAPPENED TO EACH CALL");
  for (const c of CATEGORY_ORDER) {
    const n = counts.get(c) ?? 0;
    if (n === 0) continue;
    console.log(`    ${String(n).padStart(4)}  ${CATEGORY_LABEL[c]}`);
  }

  const captured = counts.get("captured") ?? 0;
  const definiteLoss = verdicts.get("yes") ?? 0;
  const undecidable = verdicts.get("undecidable") ?? 0;
  const denominator = captured + definiteLoss + undecidable;

  console.log("");
  if (denominator === 0) {
    notMeasured(
      "Capture rate",
      "no call in this window attempted a capture, so there is no rate. That is not a rate of 100%.",
    );
  } else if (undecidable === 0) {
    console.log(`  Capture rate: ${Math.round((captured / denominator) * 100)}% of ${denominator}`);
  } else {
    const floor = Math.round((captured / denominator) * 100);
    const ceiling = Math.round(((captured + undecidable) / denominator) * 100);
    const knownDen = captured + definiteLoss;
    console.log(
      `  Capture rate: between ${floor}% and ${ceiling}% of ${denominator} calls, and ` +
        `${knownDen === 0 ? "not measurable" : `${Math.round((captured / knownDen) * 100)}%`} ` +
        `of the ${knownDen} we can decide.`,
    );
    console.log("");
    say(
      `${undecidable} of those ${denominator} calls are undecidable and the true figure sits ` +
        "inside that range. A bot waiting outside a meeting cannot see whether anyone " +
        "is inside it, so a meeting that ran without the bot and a meeting that never " +
        "happened produce identical histories. Quote the range, not one end of it.",
    );
  }

  // ---- The three failure categories the ask named ----
  const neverAdmitted =
    (counts.get("lobby_timeout") ?? 0) +
    (counts.get("lobby_refused") ?? 0) +
    (counts.get("never_joined") ?? 0);
  console.log("");
  console.log("  THE THREE FAILURE CATEGORIES, SEPARATELY");
  console.log(`    never admitted to the meeting   ${neverAdmitted}`);
  console.log(`      lobby timed out               ${counts.get("lobby_timeout") ?? 0}`);
  console.log(`      a human denied the bot        ${counts.get("lobby_refused") ?? 0}`);
  console.log(`      join link unusable            ${counts.get("never_joined") ?? 0}`);
  console.log(`    media unavailable               ${counts.get("media_lost") ?? 0}`);
  console.log(`    no-show                         ${counts.get("no_show") ?? 0}`);
  console.log("");
  say(
    "These three are not equivalent and must not be added together. A no-show is " +
      "not a failure: the bot was in the meeting and there was no conversation to " +
      "record. A lobby timeout is not a failure either, because it is undecidable. " +
      "Only a refused bot in the customer's own meeting and an unusable join link " +
      "count as losses.",
  );
  if ((counts.get("media_lost") ?? 0) === 0) {
    console.log("");
    say(
      "Media unavailable is zero, and that is a real zero rather than a gap. " +
        "DealRipe deletes the source recording on every successful capture to honour " +
        "the delete-after-pull commitment, so an absent recording is what success " +
        "looks like. Not one call in this window lost a conversation Recall had.",
    );
  }

  if (unknownReasons.length > 0) {
    console.log("");
    console.log(`  UNKNOWN, WITH THE REASON  (${unknownReasons.length})`);
    say(
      "Neither successes nor failures. Each is a call whose fate cannot be " +
        "established, listed so the gap stays visible instead of being absorbed into " +
        "a number that looks complete.",
      "    ",
    );
    const grouped = new Map<string, number>();
    for (const reason of unknownReasons) grouped.set(reason, (grouped.get(reason) ?? 0) + 1);
    for (const [reason, n] of [...grouped.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(3)}  ${reason}`);
    }
  }

  console.log("");
  say(`Window: last ${days} days, from ${date10(sinceIso)}. First call DealRipe ever joined at Magaya: ${GO_LIVE}.`);
}

// =====================================================================
// 2. What it produced
// =====================================================================

async function sectionProduced(
  tenantId: string,
  sinceMs: number,
  attempts: CallRow[],
  days: number,
): Promise<void> {
  heading(2, "WHAT IT PRODUCED");

  const db = supabaseAdmin();

  // ---- Emails, counted from sent_messages ----
  //
  // Counted here rather than from the activity log on purpose. getActivityLog
  // maps any kind it does not recognise onto "recap", so a link_escalation
  // mail is counted as a recap there. Three of them exist. The archive itself
  // carries the true kind.
  let draftsArchived: number | null = null;
  const sentRes = await db
    .from("sent_messages")
    .select("kind, sent_at")
    .eq("tenant_id", tenantId)
    .gte("sent_at", new Date(sinceMs).toISOString());
  if (sentRes.error) {
    notMeasured(
      "Briefings, recaps and drafts sent",
      `the sent_messages read failed (${sentRes.error.message})`,
    );
  } else {
    const byKind = new Map<string, number>();
    for (const r of (sentRes.data ?? []) as Array<{ kind: string }>) {
      byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    }
    draftsArchived = byKind.get("followup_draft") ?? 0;
    console.log("  DELIVERED TO REPS");
    const KIND_LABEL: Array<[string, string]> = [
      ["briefing", "pre-call briefings emailed"],
      ["recap", "post-call recaps emailed"],
      ["followup_draft", "follow-up drafts written into Outlook"],
      ["no_show_draft", "no-show follow-up drafts"],
      ["digest", "weekly CRO digests"],
      ["link_escalation", "account-link questions to reps"],
    ];
    for (const [kind, label] of KIND_LABEL) {
      console.log(`    ${String(byKind.get(kind) ?? 0).padStart(4)}  ${label}`);
    }
    for (const [kind, n] of byKind) {
      if (!KIND_LABEL.some(([k]) => k === kind)) {
        console.log(`    ${String(n).padStart(4)}  ${kind} (kind not named in this report)`);
      }
    }
  }

  // ---- Drafts, cross-checked against the call rows ----
  //
  // The cross-check matters. The archive and the per-call column are written
  // by different code on different paths, so where they disagree one of them
  // is not being written, and a number nobody cross-checked is exactly what
  // gets quoted and then challenged.
  const draftStates = new Map<string, number>();
  for (const c of attempts) {
    const s = c.followup_draft_state ?? "(column not set)";
    draftStates.set(s, (draftStates.get(s) ?? 0) + 1);
  }
  const archivedDrafts = draftsArchived;
  const columnDrafted = draftStates.get("drafted") ?? 0;
  console.log("");
  console.log("  FOLLOW-UP DRAFT STATE, per call, as the pipeline recorded it");
  for (const [s, n] of [...draftStates.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${s}`);
  }
  console.log("");
  say(
    "'held' is the product working, not a failure: the rep had already emailed the " +
      "customer, or a draft already existed, or nobody external was on the call. " +
      "'unavailable' means the mailbox could not be read, which is a did-not-check " +
      "and never a decision against writing one.",
    "    ",
  );
  if (archivedDrafts !== null && archivedDrafts !== columnDrafted) {
    console.log("");
    say(
      `These two sources disagree. The archive holds ${archivedDrafts} follow-up drafts and the ` +
        `per-call column records ${columnDrafted} as 'drafted', which means the column is not being ` +
        "written on the success path. Quote the archive figure: it is the record of a " +
        "draft that actually went into a rep's Outlook. The column is under-reporting, " +
        "not the drafts under-delivering.",
      "    ",
    );
  }

  // ---- DID THE REPS ACTUALLY SEND THEM ----
  //
  // The number the drafts are worth is not how many were written. Until now
  // the closest thing this pack could say was that a rep emailed the customer
  // after the call, which credits a rep who ignored the draft and wrote their
  // own. The Message-ID stored at draft creation makes the real question
  // answerable, and the answer is allowed to be uncomfortable: an adoption
  // figure nobody can challenge is worth more than a delivery count.
  console.log("");
  try {
    const { rows, notJoinable, scanned } = await readAdoptionForWindow({ tenantId, days });
    const counts = summarise(rows);
    const { adopted, decided, rate } = adoptionRate(rows);
    console.log("  DRAFTS THE REPS ACTUALLY SENT");
    console.log(`    ${String(scanned).padStart(4)}  drafts written in the window`);
    console.log(`    ${String(notJoinable).padStart(4)}  carry no message id, so nothing can be said about them either way`);
    console.log(`    ${String(counts.sent_ours).padStart(4)}  sent as written`);
    console.log(`    ${String(counts.sent_edited).padStart(4)}  sent after a rewrite`);
    console.log(`    ${String(counts.sent_own).padStart(4)}  rep wrote their own instead`);
    console.log(`    ${String(counts.not_sent).padStart(4)}  still sitting unsent, nothing else went out`);
    console.log(`    ${String(counts.unknown).padStart(4)}  could not tell`);
    console.log("");
    if (rate === null) {
      notMeasured(
        "Draft adoption",
        `no draft in the window could be decided (${notJoinable} carry no message id, ${counts.unknown} could not be read)`,
      );
    } else {
      console.log(`    Adoption ${Math.round(rate * 100)}% (${adopted} of ${decided} decidable drafts)`);
      say(
        "'Could not tell' sits outside both sides of that fraction. A mailbox we " +
          "could not read is not a rep who ignored us, and folding the two together " +
          "is how a delivery metric flatters itself. Note the denominator: most " +
          "drafts predate the id being stored, so this is a young measure and the " +
          "count matters more than the percentage until it grows.",
        "    ",
      );
    }
  } catch (err) {
    notMeasured(
      "Draft adoption",
      `the mailbox read failed (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  // ---- CRM writes ----
  let activity: ActivityEntry[];
  try {
    activity = await getActivityLog(tenantId);
  } catch (err) {
    console.log("");
    notMeasured(
      "CRM field writes",
      `the activity log read failed (${err instanceof Error ? err.message : String(err)}), so nothing about what reached either CRM can be stated`,
    );
    return;
  }

  const crm = activity.filter(
    (a) => (a.kind === "rolldog_write" || a.kind === "salesforce_write") && Date.parse(a.at) >= sinceMs,
  );
  const rolldog = crm.filter((a) => a.kind === "rolldog_write");
  const salesforce = crm.filter((a) => a.kind === "salesforce_write");
  const landed = (rows: ActivityEntry[]) => rows.filter((a) => !a.title.includes("did not land"));

  console.log("");
  console.log("  WRITES INTO THE CUSTOMER'S CRM");
  console.log(`    Rolldog     ${String(landed(rolldog).length).padStart(4)} write requests landed, of ${rolldog.length} permitted`);
  console.log(`    Salesforce  ${String(landed(salesforce).length).padStart(4)} write requests landed, of ${salesforce.length} permitted`);
  say(
    "'Permitted' and 'landed' are recorded separately because they are different " +
      "claims. A write the scope guard allowed can still be rejected by the CRM, and " +
      "the audit row records the rejection rather than the content it never received.",
    "    ",
  );

  // Field-level detail, from the values recorded at the moment of the write.
  const withValues = crm.filter((a) => a.values !== null);
  const withoutValues = crm.filter((a) => a.values === null);
  const byLabel = new Map<string, number>();
  const byMode = new Map<string, number>();
  let fieldWrites = 0;
  for (const a of withValues) {
    for (const v of a.values ?? []) {
      fieldWrites += 1;
      byLabel.set(v.label, (byLabel.get(v.label) ?? 0) + 1);
      byMode.set(v.mode ?? "(no mode recorded)", (byMode.get(v.mode ?? "(no mode recorded)") ?? 0) + 1);
    }
  }

  console.log("");
  console.log(`  FIELDS WRITTEN: ${fieldWrites}, across ${withValues.length} write requests`);
  for (const [label, n] of [...byLabel.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${label}`);
  }
  if (withoutValues.length > 0) {
    console.log("");
    say(
      `A further ${withoutValues.length} permitted write requests carry no record of which ` +
        "fields they touched. Those predate the column that stores it. They are not " +
        "counted above and must not be described as writes that did nothing: the " +
        "fields are simply not recorded.",
      "    ",
    );
  }

  // ---- The time-saved claim ----
  //
  // "Written with zero rep entry" is answerable only where the writer recorded
  // that the CRM field was blank when it wrote. That is exactly what mode
  // 'fill_blank' means, and it is set at write time by production. The other
  // modes cannot answer the question: 'overwrite' replaced whatever was there
  // without recording what it was, 'append' means the rep HAD something, and
  // 'create' made a new record rather than filling a field.
  const fillBlank = byMode.get("fill_blank") ?? 0;
  const append = byMode.get("append") ?? 0;
  const create = byMode.get("create") ?? 0;
  const overwrite = byMode.get("overwrite") ?? 0;
  const otherModes = fieldWrites - fillBlank - append - create - overwrite;

  console.log("");
  console.log("  FIELDS WRITTEN WITH ZERO REP ENTRY  (the time-saved claim)");
  console.log(`    ${String(fillBlank).padStart(4)}  the field was blank and DealRipe filled it. This is the claim, and it is the whole of it.`);
  console.log(`    ${String(append).padStart(4)}  the rep had written something and DealRipe added to it, so these are not zero-entry`);
  console.log(`    ${String(create).padStart(4)}  a new record was created rather than a field filled (contacts, tasks, activities)`);
  if (overwrite > 0 || otherModes > 0) {
    console.log("");
    notMeasured(
      `Zero rep entry on a further ${overwrite + otherModes} field writes`,
      "these were written in overwrite mode, which replaces the field without recording " +
        "what was there first. Whether the rep had entered anything is unrecoverable for " +
        "these, so they are not claimed either way.",
    );
  }
  console.log("");
  say(
    `Say ${fillBlank}, not ${fieldWrites}. The larger number is fields written; only the ` +
      "smaller one is fields a rep would otherwise have had to fill.",
    "    ",
  );

  // ---- Records created in the customer's CRM ----
  const created = (label: string) =>
    withValues.reduce(
      (n, a) => n + (a.values ?? []).filter((v) => v.label === label && v.mode === "create").length,
      0,
    );
  console.log("");
  console.log("  RECORDS CREATED IN THE CUSTOMER'S CRM");
  console.log(`    ${String(created("Contact")).padStart(4)}  contacts created in Salesforce`);
  console.log(`    ${String(created("Next step task")).padStart(4)}  next-step tasks created in Salesforce`);
  console.log(`    ${String(created("Next step")).padStart(4)}  next steps created in Rolldog`);
  console.log(`    ${String(created("Call activity")).padStart(4)}  call activities logged in Salesforce`);
}

// =====================================================================
// 3. Where it disagreed with the rep
// =====================================================================

/** Rank of a forecast category, for direction only. Mirrors the order the
 *  pipeline engine uses; nothing here decides a category. */
const ORDER: Record<string, number> = { omit: 0, omitted: 0, pipeline: 1, expect: 2, commit: 3 };
function rank(c: string | null): number | null {
  if (!c) return null;
  const l = c.toLowerCase().trim();
  for (const [k, v] of Object.entries(ORDER)) if (l.includes(k)) return v;
  return null;
}

/**
 * The one sentence DealRipe stated as the reason on this deal, taken verbatim
 * from the record rather than composed here.
 *
 * Preference order, and why: the commit_divergence flag is the engine's own
 * statement of why it reads a deal below the rep, so it wins. Failing that the
 * verdict, but ONLY where the verdict is about a disagreement. A 'confirmed'
 * verdict says the rep's own move is backed by the calls, which is not a
 * reason for reading the deal differently and was landing in the ranked table
 * as an unrecognised reason. Failing both, the first blocker, which the engine
 * orders by importance itself.
 */
const DISAGREEING_VERDICTS = new Set(["overstated", "risk", "lags"]);

function statedReason(d: DealChangeRecord): string {
  const divergence = d.flags.find((f) => f.kind === "commit_divergence");
  if (divergence) return divergence.text;
  if (DISAGREEING_VERDICTS.has(d.verdict.kind) && d.verdict.text) return d.verdict.text;
  if (d.blockers.length > 0) return d.blockers[0];
  if (d.verdict.text) return d.verdict.text;
  return "no reason was recorded on this deal";
}

/**
 * Group reasons that are the same reason with a different name in them.
 *
 * The engine writes "Brian (Decision Maker / Budget Owner), who signs off on a
 * purchase this size, has never been on a call." and "The economic buyer, who
 * signs off on a purchase this size, has never been on a call." Those are one
 * finding. Matching is on the engine's own literal templates, so a wording
 * change upstream shows up here as an unmatched reason printed verbatim
 * rather than as a silently wrong bucket.
 */
const REASON_TEMPLATES: Array<[RegExp, string]> = [
  // The blocker sentence carries "who signs off on a purchase this size"; the
  // commit_divergence sentence names the person and drops that clause. Both
  // are the same finding, so the match is on the part they share.
  [/has never been on a call/i, "The economic buyer has never been on a call"],
  [/budget is (not confirmed|unconfirmed)/i, "Budget is not confirmed on any call"],
  [/close date is not validated/i, "The close date is not validated by the customer"],
  [/no agreement or signature yet/i, "No agreement or signature yet"],
  [/decision process is not mapped/i, "The decision process is not mapped"],
  [/no competitor has been identified/i, "No competitor has been identified"],
  [/business driver \(why now\) is not established/i, "The business driver is not established"],
  [/no executive is engaged/i, "No executive is engaged"],
  [/single.?threaded/i, "Single-threaded on one relationship"],
  [/was a no-show/i, "The last meeting was a no-show"],
  [/stalled \d+ days/i, "Stalled in stage"],
  [/not on the calendar/i, "The agreed follow-up call was never booked"],
  [/calls show progress not yet in the forecast/i, "The calls show progress the forecast does not"],
];

function bucketOf(reason: string): string | null {
  for (const [re, label] of REASON_TEMPLATES) if (re.test(reason)) return label;
  return null;
}

type Disagreement = {
  deal: DealChangeRecord;
  rep: string;
  dr: string;
  direction: "softer" | "harder" | "sideways";
  usd: number;
  reason: string;
};

function sectionDisagreed(records: DealChangeRecord[]): Disagreement[] {
  heading(3, "WHERE IT DISAGREED WITH THE REP");

  const inRolldog = records.filter((d) => d.inRolldog);
  const withCategory = records.filter((d) => d.forecastCategory !== null);
  const readFailed = inRolldog.filter((d) => d.forecastCategory === null && d.stageName === null);

  // The guard that stops a Rolldog outage being reported as agreement.
  if (inRolldog.length > 0 && withCategory.length === 0) {
    notMeasured(
      "Forecast disagreement",
      `${inRolldog.length} deals carry a Rolldog opportunity and not one returned a forecast ` +
        "category, which means the CRM read failed rather than that the reps entered nothing. " +
        "No disagreement count can be stated from this run.",
    );
    return [];
  }

  console.log(`  Deals the pipeline engine assembled          ${records.length}`);
  console.log(`  Deals with a Rolldog opportunity             ${inRolldog.length}`);
  console.log(`  Deals where the rep has entered a forecast   ${withCategory.length}`);
  if (readFailed.length > 0) {
    console.log("");
    notMeasured(
      `The rep's forecast on ${readFailed.length} deals`,
      "these carry a Rolldog opportunity whose read returned nothing, so whether the rep " +
        "and DealRipe agree is unknown. They are excluded from both sides below.",
    );
  }
  const noOpp = records.length - inRolldog.length;
  if (noOpp > 0) {
    console.log("");
    notMeasured(
      `The rep's forecast on a further ${noOpp} deals`,
      "these are tracked from calls and have no Rolldog opportunity at all, so there is no " +
        "rep forecast to disagree with. DealRipe is ahead of the CRM on these rather than " +
        "at odds with it.",
    );
  }

  const disagreements: Disagreement[] = [];
  for (const d of withCategory) {
    const rep = d.forecastCategory as string;
    const dr = d.dealRipeCategory;
    if (!dr || dr.toLowerCase().trim() === rep.toLowerCase().trim()) continue;
    const a = rank(rep);
    const b = rank(dr);
    disagreements.push({
      deal: d,
      rep,
      dr,
      direction: a === null || b === null ? "sideways" : b < a ? "softer" : b > a ? "harder" : "sideways",
      usd: d.dealSizeAnnual ?? 0,
      reason: statedReason(d),
    });
  }

  console.log("");
  if (disagreements.length === 0) {
    console.log(`  DealRipe agrees with the rep on all ${withCategory.length} deals carrying a forecast.`);
    return [];
  }

  const softer = disagreements.filter((x) => x.direction === "softer");
  const harder = disagreements.filter((x) => x.direction === "harder");
  const sum = (xs: Disagreement[]) => xs.reduce((n, x) => n + x.usd, 0);
  const noAmount = disagreements.filter((x) => x.usd === 0).length;

  console.log(
    `  DEALRIPE DISAGREES WITH THE REP ON ${disagreements.length} OF ${withCategory.length} DEALS ` +
      `CARRYING A FORECAST`,
  );
  console.log("");
  console.log(`    total annualized value in dispute   ${money(sum(disagreements))}`);
  console.log(`    DealRipe reads it SOFTER than the rep on ${softer.length} deals, ${money(sum(softer))}`);
  console.log(`    DealRipe reads it HARDER than the rep on ${harder.length} deals, ${money(sum(harder))}`);
  if (noAmount > 0) {
    console.log("");
    notMeasured(
      `The amount on ${noAmount} of those deals`,
      "Rolldog carries no deal size on them, so they are counted in the deal counts and " +
        "contribute zero to the dollar totals. The dollar figures are floors, not totals.",
    );
  }

  // Both sides as category mixes, which is the only honest way to show "both
  // sides" without inventing a probability per category.
  console.log("");
  console.log("  THE SAME DEALS, AS EACH SIDE HAS THEM");
  const mix = (get: (x: Disagreement) => string) => {
    const m = new Map<string, { n: number; usd: number }>();
    for (const x of disagreements) {
      const k = get(x);
      const b = m.get(k) ?? { n: 0, usd: 0 };
      b.n += 1;
      b.usd += x.usd;
      m.set(k, b);
    }
    return [...m.entries()].sort((a, b) => (rank(b[0]) ?? -1) - (rank(a[0]) ?? -1));
  };
  console.log("    as the rep has them");
  for (const [cat, b] of mix((x) => x.rep)) {
    console.log(`      ${pad(cat, 14)} ${String(b.n).padStart(3)} deals   ${money(b.usd)}`);
  }
  console.log("    as DealRipe has them");
  for (const [cat, b] of mix((x) => x.dr)) {
    console.log(`      ${pad(cat, 14)} ${String(b.n).padStart(3)} deals   ${money(b.usd)}`);
  }
  console.log("");
  notMeasured(
    "A probability-weighted dollar value for either side",
    "the pilot forecasts in categories, not probabilities, and no probability is attached " +
      "to a category anywhere in Magaya's data. Weighting these would be an estimate.",
  );

  // ---- The ranked reasons ----
  console.log("");
  console.log("  WHY, RANKED. One primary reason per deal, so these sum to the total.");
  const primary = new Map<string, { n: number; usd: number }>();
  const unmatched: string[] = [];
  for (const x of disagreements) {
    const label = bucketOf(x.reason) ?? "(reason not recognised, printed below verbatim)";
    if (!bucketOf(x.reason)) unmatched.push(`${x.deal.account}: ${x.reason}`);
    const b = primary.get(label) ?? { n: 0, usd: 0 };
    b.n += 1;
    b.usd += x.usd;
    primary.set(label, b);
  }
  const primaryNoAmount = new Map<string, number>();
  for (const x of disagreements) {
    if (x.usd !== 0) continue;
    const label = bucketOf(x.reason) ?? "(reason not recognised, printed below verbatim)";
    primaryNoAmount.set(label, (primaryNoAmount.get(label) ?? 0) + 1);
  }
  const ranked = [...primary.entries()].sort((a, b) => b[1].n - a[1].n);
  for (const [label, b] of ranked) {
    const blank = primaryNoAmount.get(label) ?? 0;
    console.log(
      `    ${String(b.n).padStart(3)}  ${pad(label, 48)} ${
        blank === b.n ? "value NOT MEASURED" : money(b.usd)
      }` + (blank > 0 && blank < b.n ? `   (${blank} of them carry no amount)` : ""),
    );
  }
  if (ranked.length > 0) {
    const [topLabel, top] = ranked[0];
    const blank = primaryNoAmount.get(topLabel) ?? 0;
    console.log("");
    say(
      `The line to say out loud: ${top.n} of the ${disagreements.length} disagreements come down ` +
        `to one thing, "${topLabel.charAt(0).toLowerCase()}${topLabel.slice(1)}". ` +
        (blank > 0
          ? `${blank} of those ${top.n} deals carry no amount in Rolldog, so the ${money(top.usd)} ` +
            `behind them is what the remaining ${top.n - blank} are worth and not the whole of it.`
          : `${money(top.usd)} of annualized pipeline sits behind it.`),
    );
  }
  for (const u of unmatched) console.log(`    unrecognised reason  ${u}`);

  // Every blocker on the disagreeing deals, which overlaps and does not sum.
  console.log("");
  console.log("  EVERY BLOCKER RECORDED ON THOSE DEALS. A deal can carry several, so these overlap");
  console.log("  and deliberately do not sum to the total above.");
  const allBlockers = new Map<string, number>();
  for (const x of disagreements) {
    const seen = new Set<string>();
    for (const b of x.deal.blockers) {
      const label = bucketOf(b) ?? b;
      if (seen.has(label)) continue;
      seen.add(label);
      allBlockers.set(label, (allBlockers.get(label) ?? 0) + 1);
    }
  }
  for (const [label, n] of [...allBlockers.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${label}`);
  }

  console.log("");
  say(
    "One caveat to carry into the room. DealRipe reading a deal HARDER than the rep is " +
      "mostly a deal the rep has parked at Pipeline or Omitted while the calls have " +
      "confirmed real qualification. That is the engine notching one step, not a " +
      "prediction that the deal closes.",
  );

  return disagreements;
}

// =====================================================================
// 4. What it caught
// =====================================================================

function sectionCaught(
  records: DealChangeRecord[],
  attempts: CallRow[],
): void {
  heading(4, "WHAT IT CAUGHT");

  const usd = (ds: DealChangeRecord[]) => ds.reduce((n, d) => n + (d.dealSizeAnnual ?? 0), 0);
  const noAmount = (ds: DealChangeRecord[]) => ds.filter((d) => (d.dealSizeAnnual ?? 0) === 0).length;

  const withMoney = (label: string, ds: DealChangeRecord[]) => {
    const blank = noAmount(ds);
    // Every deal carrying no amount is a "we cannot value this", not a set of
    // deals worth nothing. Printing $0 for it would be the same substitution
    // of absence for zero the rest of this pack exists to avoid.
    const amount = ds.length > 0 && blank === ds.length ? "value NOT MEASURED" : money(usd(ds));
    console.log(`    ${String(ds.length).padStart(3)} deals   ${pad(amount, 12)} ${label}`);
    if (blank > 0 && blank < ds.length) {
      console.log(
        `        ${blank} of them carry no deal size in Rolldog, so that dollar figure is a floor`,
      );
    } else if (blank > 0) {
      console.log(
        `        Rolldog carries no deal size on any of them, so no dollar value can be stated`,
      );
    }
  };

  // ---- No-shows ----
  //
  // Counted from the capture classifier, NOT from the pipeline engine's
  // isNoShow. The engine's flag is a triage signal and its outcome set
  // includes capture_failed and rescheduled, so reading it as "the customer
  // did not turn up" would count every call where our own bot was never
  // admitted as a customer no-show. Those are the opposite finding: one is the
  // customer not showing, the other is us not getting in.
  const noShowDealIds = new Set<string>();
  let noShowCalls = 0;
  for (const r of attempts) {
    if (verdictFor(r).category !== "no_show") continue;
    noShowCalls += 1;
    noShowDealIds.add(r.deal_id);
  }
  const noShowDeals = records.filter((d) => noShowDealIds.has(d.dealId));
  console.log("  NO-SHOWS DETECTED");
  console.log(
    `    ${String(noShowCalls).padStart(3)} calls    the bot was in the meeting and no conversation happened`,
  );
  withMoney("with at least one such call in the window", noShowDeals);
  console.log("");
  say(
    "A no-show is caught the day it happens rather than at the end of the month, and " +
      "it is the cheapest signal in the pilot that a deal on the board is not live.",
    "    ",
  );

  // The engine's wider triage set, named as what it is so the two numbers are
  // never confused for each other in the room.
  const noConversation = records.filter((d) => d.isNoShow);
  console.log("");
  withMoney(
    "whose latest meeting produced no conversation for any reason",
    noConversation,
  );
  say(
    "That wider figure includes calls where DealRipe's own bot was never admitted, so " +
      "it is not a count of customers who failed to turn up. Quote the smaller number " +
      "for no-shows and this one only as deals whose last meeting yielded nothing.",
    "    ",
  );

  // ---- Commitment made, no follow-up booked ----
  console.log("");
  console.log("  A COMMITMENT WAS MADE ON A CALL AND NO FOLLOW-UP MEETING EXISTS");
  const owed = records.filter((d) => d.repOwedMeeting);
  withMoney("where a specific follow-up call was agreed and is not on any calendar", owed);
  if (owed.length > 0) {
    console.log("");
    for (const d of [...owed].sort((a, b) => (b.dealSizeAnnual ?? 0) - (a.dealSizeAnnual ?? 0)).slice(0, 8)) {
      console.log(`      ${pad(d.account, 34)} ${pad(money(d.dealSizeAnnual ?? 0), 10)} ${date10(d.lastConversationAt)}`);
      if (d.agreedNextStep) say(`agreed: ${d.agreedNextStep}`, "        ");
    }
    if (owed.length > 8) console.log(`      and ${owed.length - 8} more`);
  }
  console.log("");
  say(
    "This is checked against the rep's own calendar, so it is the absence of a booked " +
      "meeting rather than the absence of a note about one.",
    "    ",
  );

  // ---- Economic buyer never on a call ----
  console.log("");
  console.log("  NOBODY IDENTIFIED AS THE ECONOMIC BUYER HAS EVER ATTENDED A CALL");
  const hasEvidence = records.filter((d) => d.dealHealth !== "no_data");
  const buyerAbsent = hasEvidence.filter((d) => d.economicBuyer !== null && !d.economicBuyer.engaged);
  const namedButAbsent = buyerAbsent.filter((d) => d.economicBuyer?.name);
  const neverIdentified = buyerAbsent.filter((d) => !d.economicBuyer?.name);
  withMoney("in total", buyerAbsent);
  console.log("");
  withMoney("where the buyer is named on the deal and has still never joined a call", namedButAbsent);
  withMoney("where no economic buyer has been identified at all", neverIdentified);
  console.log("");
  say(
    "These are two different problems and are counted apart. A named buyer who never " +
      "joins is a deal the rep can fix this week. A buyer nobody has identified is a " +
      "deal where the rep does not yet know who signs.",
    "    ",
  );
  console.log("");
  console.log(`    Denominator: ${hasEvidence.length} deals where DealRipe has captured at least one call.`);
  const noData = records.length - hasEvidence.length;
  if (noData > 0) {
    console.log("");
    notMeasured(
      `The economic buyer on ${noData} deals`,
      "DealRipe has captured no call on them, so it has no basis to say who has or has not " +
        "attended one. They are excluded rather than counted as a gap.",
    );
  }
}

// =====================================================================
// 5. Follow-through, honestly
// =====================================================================

/**
 * What kind of call this was, as one label. Same shape as
 * scripts/prescription-report.ts: an existing customer is its own category
 * regardless of subtype, because a kickoff is not a sales call and a
 * new-business question aimed at one was wrong before the rep opened their
 * mouth.
 */
function callTypeOf(c: CallRow | undefined): string {
  if (!c) return "call row not found";
  if (c.meeting_type === "existing_customer") return "existing_customer";
  return c.call_subtype ?? c.meeting_type ?? "unclassified";
}

async function sectionFollowThrough(
  tenantId: string,
  sinceIso: string,
  callsById: Map<string, CallRow>,
): Promise<void> {
  heading(5, "FOLLOW-THROUGH, HONESTLY");

  const db = supabaseAdmin();
  const res = await db
    .from("prescribed_actions")
    .select("id, call_id, kind, followed, followed_evidence, scored_at, email_checked_at, issued_at")
    .eq("tenant_id", tenantId)
    .gte("issued_at", sinceIso);
  if (res.error) {
    notMeasured("Follow-through", `the prescription ledger read failed (${res.error.message})`);
    return;
  }
  const rows = (res.data ?? []) as Array<{
    call_id: string;
    kind: string;
    followed: Tristate;
    followed_evidence: string | null;
    scored_at: string | null;
    email_checked_at: string | null;
  }>;

  if (rows.length === 0) {
    notMeasured(
      "Follow-through",
      "no prescriptions were issued in this window, so there is nothing to score.",
    );
    return;
  }

  console.log(`  Prescriptions issued in window: ${rows.length}, across ${new Set(rows.map((r) => r.call_id)).size} calls.`);
  console.log("");
  console.log("  BY CALL TYPE. Deliberately not blended into one rate.");
  console.log("");
  console.log(`    ${pad("call type", 22)} ${pad("calls", 6)} ${pad("acted on", 10)} ${pad("not", 5)} ${pad("rate", 8)} not scored`);

  const byType = new Map<string, { yes: number; no: number; unknown: number; calls: Set<string> }>();
  for (const r of rows) {
    const t = callTypeOf(callsById.get(r.call_id));
    const b = byType.get(t) ?? { yes: 0, no: 0, unknown: 0, calls: new Set<string>() };
    b[r.followed] += 1;
    b.calls.add(r.call_id);
    byType.set(t, b);
  }

  const measured: string[] = [];
  const unmeasured: string[] = [];
  const ordered = [...byType.entries()].sort((a, b) => {
    const score = (v: { yes: number; no: number }) => (v.yes + v.no === 0 ? -1 : v.yes / (v.yes + v.no));
    return score(b[1]) - score(a[1]);
  });
  for (const [t, b] of ordered) {
    const decided = b.yes + b.no;
    if (decided === 0) {
      console.log(
        `    ${pad(t, 22)} ${pad(String(b.calls.size), 6)} ${pad("-", 10)} ${pad("-", 5)} ${pad("NOT MEASURED", 8)}  ${b.unknown}`,
      );
      unmeasured.push(t);
      continue;
    }
    measured.push(t);
    console.log(
      `    ${pad(t, 22)} ${pad(String(b.calls.size), 6)} ${pad(String(b.yes), 10)} ${pad(String(b.no), 5)} ${pad(
        `${Math.round((b.yes / decided) * 100)}%`,
        8,
      )}  ${b.unknown}`,
    );
  }

  console.log("");
  if (measured.length > 0) {
    say(`Measurable for: ${measured.join(", ")}.`, "    ");
  }
  if (unmeasured.length > 0) {
    console.log("");
    notMeasured(
      `Follow-through on ${unmeasured.join(", ")}`,
      "every prescription on those calls is unscored. A prescription is scored against the " +
        "transcript of the NEXT call on the deal, so one that has not had a next call yet is " +
        "'not checked' and is never counted as a rep who did nothing.",
    );
  }

  console.log("");
  say(
    "Do not average these. The spread is not a spread between reps, it is a spread " +
      "between call types, and the low end is evidence about the briefing rather than " +
      "about the rep. A demo that ended 'appreciate the demo' and an existing customer " +
      "mid implementation were both asked what is driving them to look at a new " +
      "solution. The reps were right not to ask it.",
  );

  // By kind, with the commitment caveat that changes how the number reads.
  console.log("");
  console.log("  BY KIND OF PRESCRIPTION");
  const byKind = new Map<string, { yes: number; no: number; unknown: number }>();
  for (const r of rows) {
    const b = byKind.get(r.kind) ?? { yes: 0, no: 0, unknown: 0 };
    b[r.followed] += 1;
    byKind.set(r.kind, b);
  }
  for (const [k, b] of byKind) {
    const decided = b.yes + b.no;
    console.log(
      `    ${pad(k, 20)} ${
        decided === 0 ? "NOT MEASURED" : `${Math.round((b.yes / decided) * 100)}% (${b.yes} of ${decided})`
      }${b.unknown > 0 ? `, ${b.unknown} not scored` : ""}`,
    );
  }
  const byEmail = rows.filter((r) => (r.followed_evidence ?? "").startsWith("[email]")).length;
  const commitments = rows.filter((r) => r.kind === "end_commitment");
  const uncheckedMail = commitments.filter((r) => r.followed === "no" && r.email_checked_at === null).length;
  if (commitments.length > 0) {
    console.log("");
    console.log(`    end commitments secured by email after the call: ${byEmail}`);
    if (uncheckedMail > 0) {
      console.log("");
      notMeasured(
        `Whether ${uncheckedMail} more commitments were secured in writing`,
        "the rep's mailbox has not been searched for them yet, either because the call is " +
          "still inside the settle window or the mailbox could not be read. Scoring a " +
          "commitment from the transcript alone records reps who did the work as reps who " +
          "did nothing.",
      );
    }
  }
}

// =====================================================================
// 6. Three named examples
// =====================================================================

function sectionExamples(disagreements: Disagreement[]): void {
  heading(6, "THREE NAMED EXAMPLES");

  if (disagreements.length === 0) {
    notMeasured("Named examples", "there are no disagreements in this window to draw them from.");
    return;
  }

  /**
   * Strongest first. Something having happened since is the top criterion,
   * because a disagreement a subsequent event bore out is the only one that
   * survives a hard question. Direction is next: DealRipe reading a deal
   * softer than the rep is the harder and more valuable claim. Then size.
   */
  const subsequent = (x: Disagreement): number => {
    let n = 0;
    if (x.deal.noShowInWindow) n += 3;
    if (x.deal.repChange) n += 2;
    if (x.deal.movement.moved) n += 2;
    if (x.deal.changes.length > 0) n += 1;
    return n;
  };
  const ranked = [...disagreements].sort((a, b) => {
    const s = subsequent(b) - subsequent(a);
    if (s !== 0) return s;
    const d = (b.direction === "softer" ? 1 : 0) - (a.direction === "softer" ? 1 : 0);
    if (d !== 0) return d;
    return b.usd - a.usd;
  });

  for (const x of ranked.slice(0, 3)) {
    const d = x.deal;
    console.log(rule("-"));
    console.log(`  ${d.account}`);
    console.log(rule("-"));
    console.log(`    Amount                ${d.dealSizeAnnual ? `${money(d.dealSizeAnnual)} annualized` : "no deal size in Rolldog"}`);
    console.log(`    Rep                   ${d.repName}${d.repEmail ? ` (${d.repEmail})` : ""}`);
    console.log(`    The rep has it at     ${x.rep}${d.stageName ? `, stage ${d.stageName}` : ""}`);
    console.log(`    DealRipe has it at    ${x.dr}   (DealRipe reads it ${x.direction} than the rep)`);
    console.log(`    Last conversation     ${date10(d.lastConversationAt)}`);
    if (d.closeDate) console.log(`    Rep's close date      ${date10(d.closeDate)}`);
    console.log("");
    console.log("    The exact stated reason, as DealRipe wrote it:");
    say(`"${x.reason}"`, "      ");
    if (d.repChange) {
      console.log("");
      console.log(
        `    What the rep changed  ${d.repChange.label}: ${d.repChange.from ?? "(unset)"} to ${d.repChange.to ?? "(unset)"}`,
      );
    }
    if (d.movement.moved) {
      console.log(`    What happened since   ${d.movement.summary}`);
    }
    if (d.noShowInWindow) {
      console.log(`    What happened since   the ${d.noShowTitle ? `"${d.noShowTitle}" ` : ""}meeting was a no-show`);
    }
    if (!d.movement.moved && !d.noShowInWindow && !d.repChange) {
      console.log("");
      notMeasured(
        "What happened since",
        "nothing has changed on this deal in Rolldog or on its calls inside the window, so " +
          "there is no subsequent event to point at.",
      );
    }
    if (d.whatChanged.length > 0) {
      console.log("");
      console.log("    What the calls surfaced:");
      for (const w of d.whatChanged.slice(0, 3)) {
        say(`${w.label ? `${w.label}: ` : ""}${w.text}`, "      ");
      }
    }
    console.log("");
  }
}

// =====================================================================

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? "45");
  if (!Number.isFinite(days) || days <= 0) {
    console.error("--days must be a positive number");
    process.exit(1);
  }
  const sinceMs = Date.now() - days * 86_400_000;
  const sinceIso = new Date(sinceMs).toISOString();
  const untilIso = new Date().toISOString();

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  console.log(`\n${rule()}`);
  console.log(`DEALRIPE EVIDENCE PACK    Magaya pilot    last ${days} days`);
  console.log(`Generated ${date10(untilIso)} from the production database and a live CRM read.`);
  console.log(`Every figure below traces to a query. Anything not measurable says so.`);
  console.log(rule());

  // ---- The shared reads ----
  const callsRes = await db
    .from("calls")
    .select(
      "id, deal_id, title, scheduled_start, call_date, outcome, recall_bot_id, has_been_extracted, " +
        "organizer_email, capture_evidence, capture_detail, capture_status_changes, meeting_type, " +
        "call_subtype, followup_draft_state, deals!inner(account, rep_email)",
    )
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", sinceIso)
    .lte("scheduled_start", untilIso);
  if (callsRes.error) throw new Error(`calls read failed: ${callsRes.error.message}`);
  const calls = (callsRes.data ?? []) as unknown as CallRow[];
  const attempts = calls.filter((c) => !NOT_AN_ATTEMPT.has(String(c.outcome ?? "")));

  // Every call, not just the windowed ones, so a prescription issued on a call
  // just outside the window still resolves to its type rather than to unknown.
  const allCallsRes = await db
    .from("calls")
    .select("id, deal_id, meeting_type, call_subtype, outcome")
    .eq("tenant_id", tenantId);
  if (allCallsRes.error) throw new Error(`calls read failed: ${allCallsRes.error.message}`);
  const callsById = new Map<string, CallRow>(
    ((allCallsRes.data ?? []) as unknown as CallRow[]).map((c) => [c.id, c]),
  );

  const dealsRes = await db
    .from("deals")
    .select("id, external_id, rolldog_opportunity_id")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(`deals read failed: ${dealsRes.error.message}`);
  const dealRows = (dealsRes.data ?? []) as Array<{
    id: string;
    external_id: string | null;
    rolldog_opportunity_id: string | null;
  }>;

  await sectionCoverage(tenantId, days, sinceIso, calls, attempts, dealRows.length);
  await sectionProduced(tenantId, sinceMs, attempts, days);

  // ---- The live CRM read behind sections 3, 4 and 6 ----
  //
  // getPipelineChanges authorizes each opportunity itself, one read at a time,
  // the same way lib/snapshot.ts and lib/deal-context.ts do. This script used
  // to wrap the whole call because the engine did not, and the fail-closed
  // scope guard was refusing every auto-linked opportunity: the refusal
  // reached the engine as a Rolldog read that returned nothing, and 18 of the
  // 45 deals carrying a rep forecast reported having none. The wrapper is gone
  // from here on purpose, so this pack reads exactly what Mark's weekly digest
  // and the /review dashboard read. If those three ever disagree again, one of
  // them has grown a scope problem and this is where it will show.
  let records: DealChangeRecord[] | null = null;
  try {
    const pc = await getPipelineChanges(tenantId, { sinceIso, untilIso });
    records = pc.deals;
  } catch (err) {
    records = null;
    console.log(`\n${rule()}`);
    notMeasured(
      "Sections 3, 4 and 6",
      `the pipeline engine failed (${err instanceof Error ? err.message : String(err)}), so nothing ` +
        "about forecast disagreement, what was caught, or named examples can be stated from this run.",
    );
  }

  if (records) {
    const disagreements = sectionDisagreed(records);
    sectionCaught(records, attempts);
    await sectionFollowThrough(tenantId, sinceIso, callsById);
    sectionExamples(disagreements);
  } else {
    await sectionFollowThrough(tenantId, sinceIso, callsById);
  }

  console.log(rule());
  console.log("End of pack. Every number above came from a query in this script.");
  console.log(rule());
  console.log("");
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
