/**
 * The prescription ledger: what DealRipe told a rep to do, and whether they
 * did it.
 *
 * DealRipe is the only system in this category that tells a rep what to do
 * BEFORE a call, which makes it the only one that can measure whether they did
 * it and what followed. Won and lost is one row per deal per quarter.
 * Prescriptions are several rows per call, so the learning loop has something
 * to learn from in weeks instead of a year.
 *
 * This module owns writing the ledger. Reading and scoring live in
 * lib/prescription-scoring.ts; the deterministic post-call facts live in
 * lib/prescription-outcomes.ts.
 *
 * Two rules the shape of this file exists to enforce:
 *
 *   1. NOTHING DEFAULTS TO FALSE. A row is issued with followed='unknown' and
 *      three outcomes of 'unknown'. Only the scorer, holding a transcript,
 *      may write 'no'.
 *
 *   2. ISSUE NEVER MUTATES. A regenerated briefing supersedes rather than
 *      overwrites: rows are inserted, never updated, and the unique key
 *      (call_id, kind, text_hash) makes re-issuing the same instruction for
 *      the same call a no-op rather than a duplicate.
 */

import type { PrescriptionKind, PrescriptionSource } from "./database.types";
import type { MagayaBriefing } from "./generate-briefing";
import { supabaseAdmin } from "./supabase";

/** One instruction, before it is written. */
export type NewPrescription = {
  kind: PrescriptionKind;
  /** What the rep was told to do, in the words they were told it in. */
  text: string;
  /**
   * Framework field IDs this targets, from the briefing's own targetFields.
   *
   * Null means we do not know which fields were targeted, which is the honest
   * value on a row recovered by parsing a sent email: the rendered briefing
   * carries targetLabel and never targetFields. An empty array would claim the
   * briefing targeted nothing.
   */
  frameworkFieldKeys: string[] | null;
};

export type RecordPrescriptionsArgs = {
  tenantId: string;
  dealId: string;
  /** The call these were issued for. Required: a prescription with no call
   *  cannot be scored, so we fail loudly rather than write an orphan. */
  callId: string;
  source: PrescriptionSource;
  /** When the rep was told, which for a backfill is when the email was sent. */
  issuedAt: string;
  prescriptions: ReadonlyArray<NewPrescription>;
};

export type RecordPrescriptionsResult =
  | { status: "written"; inserted: number; skippedDuplicates: number }
  /** Nothing to write. Not a failure. */
  | { status: "empty" }
  /** The insert failed. Says so rather than reporting zero rows written. */
  | { status: "unavailable"; error: string };

/**
 * The instructions a briefing issues.
 *
 * Three questions and an end commitment, which is exactly what the rep sees:
 * lib/emails/pre-call-briefing.ts renders questions[] under "ASK THESE" and
 * nextStepCommitment under "SECURE THIS NEXT STEP".
 *
 * Pure, and shared with the backfill parser, so a row recovered from a sent
 * email and a row written at issue have the same shape and the same meaning.
 * The only difference between them is frameworkFieldKeys, which the email
 * cannot carry.
 *
 * callObjective and whatsAtRisk are deliberately NOT prescriptions. An
 * objective is the outcome the questions are in service of, not a separate
 * instruction, and counting it would inflate follow-through with a row nobody
 * can act on independently.
 */
export function prescriptionsFromBriefing(
  briefing: MagayaBriefing,
): NewPrescription[] {
  const out: NewPrescription[] = [];

  for (const q of briefing.questions ?? []) {
    const text = (q.ask ?? "").trim();
    if (!text) continue;
    const keys = (q.targetFields ?? []).filter(
      (k): k is string => typeof k === "string" && k.trim().length > 0,
    );
    out.push({
      kind: "question",
      text,
      // A briefing that emitted no targetFields told us nothing about which
      // fields it aimed at, which is not the same as aiming at none.
      frameworkFieldKeys: keys.length > 0 ? keys : null,
    });
  }

  const commitment = (briefing.nextStepCommitment ?? "").trim();
  if (commitment) {
    out.push({ kind: "end_commitment", text: commitment, frameworkFieldKeys: null });
  }

  return out;
}

/**
 * The migration is applied by hand, so the first thing anyone runs against an
 * un-migrated database gets a bare "column does not exist" from PostgREST.
 * Name the fix instead of making them find it.
 */
export function ledgerError(message: string): string {
  if (!/does not exist/i.test(message) || !/prescribed_actions|column/i.test(message)) {
    return message;
  }
  // Name the migration that is actually missing. Pointing at the wrong file
  // sends someone to re-run a migration they already applied, watch it succeed,
  // and hit the identical error again.
  const file = /email_checked_at/i.test(message)
    ? "supabase/add-prescription-email-channel.sql"
    : "supabase/add-prescription-ledger.sql";
  return `${message}\n\nA prescription ledger migration has not been applied. Run:\n  psql "$SUPABASE_DB_URL" -f ${file}`;
}

// =====================================================================
// Recovering instructions from a briefing that was already sent
// =====================================================================

export type ParsedBriefingEmail = {
  questions: string[];
  nextStepCommitment: string | null;
};

/** Section headers in the rendered briefing, used as parse boundaries. */
const EMAIL_HEADERS = [
  "CALL OBJECTIVE",
  "WHERE IT STANDS",
  "SECURE THIS NEXT STEP",
  "WHAT'S AT RISK",
  "SIGNAL",
];

/**
 * Pull the instructions back out of a briefing that was rendered and sent.
 *
 * The structured object was never persisted: briefing-sync rendered it and
 * threw it away, so for anything issued before this ledger existed the only
 * record is prose in sent_messages.body_text. This mirrors renderText in
 * lib/emails/pre-call-briefing.ts:
 *
 *   ASK THESE (3)
 *   1. <ask> [<targetLabel>]
 *      <why>
 *   ...
 *   SECURE THIS NEXT STEP
 *   <commitment>
 *
 * Verified to round-trip that renderer exactly. What it CANNOT recover is
 * targetFields: the email carries targetLabel ("Budget") and never the field
 * ids, so every recovered prescription gets frameworkFieldKeys = null.
 *
 * Returns null rather than guessing when the layout does not match. A
 * half-parsed briefing would put words in a rep's mouth they were never shown,
 * and the ledger is only worth anything if its rows are what was actually
 * issued.
 */
export function parseBriefingEmailText(text: string): ParsedBriefingEmail | null {
  const lines = text.split("\n");

  const askIdx = lines.findIndex((l) => /^ASK THESE\b/.test(l.trim()));
  const nextIdx = lines.findIndex((l) => l.trim() === "SECURE THIS NEXT STEP");
  if (askIdx === -1 && nextIdx === -1) return null;

  const questions: string[] = [];
  if (askIdx !== -1) {
    for (let i = askIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (EMAIL_HEADERS.includes(trimmed)) break;
      // Numbered asks only. The indented line beneath each is the "why", which
      // is written for the rep's eyes and is not an instruction.
      const m = /^(\d+)\.\s+(.*)$/.exec(trimmed);
      if (!m) continue;
      // Strip the trailing "[Budget]" the renderer appends from targetLabel.
      // The label is a category, not part of what the rep says out loud.
      const ask = m[2].replace(/\s*\[[^\]]{1,40}\]\s*$/, "").trim();
      if (ask) questions.push(ask);
    }
  }

  let commitment: string | null = null;
  if (nextIdx !== -1) {
    for (let i = nextIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      if (EMAIL_HEADERS.includes(trimmed)) break;
      commitment = trimmed;
      break;
    }
  }

  if (questions.length === 0 && !commitment) return null;
  return { questions, nextStepCommitment: commitment };
}

/**
 * The same shape prescriptionsFromBriefing produces, from a sent email.
 * Identical in every field except frameworkFieldKeys, which the email cannot
 * carry.
 */
export function prescriptionsFromBriefingEmail(
  parsed: ParsedBriefingEmail,
): NewPrescription[] {
  const out: NewPrescription[] = parsed.questions.map((q) => ({
    kind: "question" as const,
    text: q,
    frameworkFieldKeys: null,
  }));
  if (parsed.nextStepCommitment) {
    out.push({
      kind: "end_commitment",
      text: parsed.nextStepCommitment,
      frameworkFieldKeys: null,
    });
  }
  return out;
}

// =====================================================================

/**
 * Write instructions to the ledger. Insert only.
 *
 * Best-effort by contract: this is called from the briefing send path, where
 * a failure to record must never cost a rep the briefing that already went
 * out. It returns which case it was rather than throwing, and never returns
 * "written: 0" for a write it could not attempt.
 */
export async function recordPrescriptions(
  args: RecordPrescriptionsArgs,
): Promise<RecordPrescriptionsResult> {
  if (args.prescriptions.length === 0) return { status: "empty" };

  const rows = args.prescriptions.map((p) => ({
    tenant_id: args.tenantId,
    deal_id: args.dealId,
    call_id: args.callId,
    issued_at: args.issuedAt,
    kind: p.kind,
    text: p.text,
    source: args.source,
    framework_field_keys: p.frameworkFieldKeys,
    // Stated explicitly rather than left to the column default, because the
    // whole point of the ledger is that these three are not false.
    followed: "unknown" as const,
    outcome_next_meeting: "unknown" as const,
    outcome_draft_sent: "unknown" as const,
    outcome_stage_moved: "unknown" as const,
  }));

  try {
    const db = supabaseAdmin();

    // Dedupe against what this call already holds, then plain-insert.
    //
    // Not an upsert: the unique index is on (call_id, kind, md5(text)) and a
    // conflict target naming a generated column is the kind of thing that
    // works until a PostgREST upgrade decides otherwise. Reading first is one
    // extra query on a path that runs a handful of times an hour, and it
    // cannot silently turn into an UPDATE, which is the one thing this
    // function must never do.
    const existing = await db
      .from("prescribed_actions")
      .select("kind, text")
      .eq("call_id", args.callId);
    if (existing.error) {
      // Do NOT fall through to inserting. A failed read here would duplicate
      // every prescription on the call, and a duplicated ledger row quietly
      // halves a rep's follow-through rate.
      return {
        status: "unavailable",
        error: `could not read existing prescriptions for this call: ${existing.error.message}`,
      };
    }
    const already = new Set(
      (existing.data ?? []).map((r) => `${r.kind} ${r.text}`),
    );
    const fresh = rows.filter((r) => !already.has(`${r.kind} ${r.text}`));
    if (fresh.length === 0) {
      return { status: "written", inserted: 0, skippedDuplicates: rows.length };
    }

    const res = await db.from("prescribed_actions").insert(fresh).select("id");
    if (res.error) {
      // 23505 is the unique index doing its job against a concurrent writer.
      // Both runs wanted the same rows written once, and they are.
      if (res.error.code === "23505") {
        return { status: "written", inserted: 0, skippedDuplicates: rows.length };
      }
      return { status: "unavailable", error: res.error.message };
    }
    const inserted = res.data?.length ?? 0;
    return {
      status: "written",
      inserted,
      skippedDuplicates: rows.length - inserted,
    };
  } catch (err) {
    return {
      status: "unavailable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
