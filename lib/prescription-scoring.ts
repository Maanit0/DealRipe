/**
 * Scoring the prescription ledger.
 *
 * Two independent questions, deliberately not collapsed:
 *
 *   1. FOLLOW-THROUGH. Did the rep do what the briefing told them to. Answered
 *      from the transcript, one model call per call rather than one per
 *      prescription, with a verbatim quote required as evidence.
 *
 *   2. OUTCOMES. What happened afterwards. Answered deterministically in
 *      lib/prescription-outcomes.ts, never by the model.
 *
 * The rule the whole file is shaped around: no quote means no, and no
 * transcript means unknown. Those are different rows and must never become the
 * same row. A rep who was told to ask about the approval chain and did not is
 * a training signal. A call whose bot never got in is not.
 *
 * The two flavours of missing transcript are also different, and only one is
 * worth work:
 *
 *   not_yet       the bot is still processing, or ingest has not run. Retry.
 *   no_content    the call has an outcome that means there was no conversation
 *                 (no_show, rescheduled, capture_failed, duplicate). There will
 *                 never be a transcript, so the row is stamped scored_at and
 *                 leaves the queue, still carrying followed='unknown'.
 *                 scored_at means "we have finished deciding", not "we got an
 *                 answer".
 */

import { runModel } from "./model-run";
import type { Tristate } from "./database.types";
import {
  readCallOutcomes,
  type OutcomeCall,
  type PostCallMailRead,
} from "./prescription-outcomes";
import { ledgerError } from "./prescription-ledger";
import { supabaseAdmin } from "./supabase";
import { resolveTenantId } from "./tenant-deal-lookup";

/**
 * Call outcomes that mean there was no conversation to score against.
 * Mirrors lib/briefing-history.ts, which uses the same set to decide what
 * counts as a call at all.
 */
const NO_CONTENT = new Set([
  "no_conversation",
  "no_show",
  "rescheduled",
  "placeholder",
  "capture_failed",
  "duplicate",
]);

/**
 * How long after a call its deterministic outcomes are still refreshed.
 *
 * A transcript lands minutes after a call, so scoring follow-through
 * immediately is right. Outcomes are not: a rep who books the next meeting the
 * following morning would be recorded as "no next meeting" forever if we froze
 * the answer at score time. So outcomes are recomputed on every run for calls
 * inside this window and freeze at the last computed value once past it.
 */
export const OUTCOME_REFRESH_DAYS = 21;
/**
 * Outcomes are not written until a call has had time to produce them. Inside
 * this window an unbooked next meeting is not yet a fact about the rep.
 */
export const OUTCOME_SETTLE_DAYS = 3;
/**
 * How long a commitment's email channel stays OPEN before an empty mailbox is
 * accepted as a real negative.
 *
 * THE EVIDENCE WINDOW HAS TO COVER THE CLAIM WINDOW. A commitment says "Nick
 * sends the services list by Friday August 28, Magaya sends the revised
 * proposal by Wednesday September 2". The email pass runs when the call is
 * scored, minutes to hours after the call, reads the mailbox from the call time
 * forward, finds nothing because nothing has been sent yet, and stamps
 * email_checked_at. The stamp is what makes it permanent: the row is excluded
 * from every later run, so a commitment fulfilled on the due date is recorded
 * forever as one the rep ignored.
 *
 * Medovlog is the case that found this. Its 08-27 commitment scored 'no'; the
 * deal closed WON on 08-28 with "Completed: You're copied on 'Magaya Quote
 * Agreement - Medov'" sitting in the deal's own mail. Across the book, 67 of the
 * 75 email-checked commitments carry a 'no' decided this way.
 *
 * Seven days rather than a parsed due date. Commitments name their dates in
 * prose ("by Friday", "end of next week", "before the board meets") and a parser
 * that gets one wrong settles a row early, which is the failure being fixed.
 * A fixed window cannot be wrong about what it covers.
 */
export const COMMITMENT_SETTLE_DAYS = 7;

// =====================================================================
// Transcript, three ways
// =====================================================================

export type TranscriptRead =
  | { status: "present"; body: string }
  /** No transcript yet. Worth retrying. */
  | { status: "not_yet"; reason: string }
  /** There was no conversation. There will never be a transcript. */
  | { status: "no_content"; outcome: string }
  /** The read failed. Worth retrying. */
  | { status: "unavailable"; error: string };

/** True when this call will never produce a transcript, so stop retrying it. */
export function isPermanentlyUnscorable(read: TranscriptRead): boolean {
  return read.status === "no_content";
}

export async function readTranscriptForCall(args: {
  callId: string;
  outcome: string | null;
}): Promise<TranscriptRead> {
  if (args.outcome && NO_CONTENT.has(args.outcome)) {
    return { status: "no_content", outcome: args.outcome };
  }
  try {
    const res = await supabaseAdmin()
      .from("transcripts")
      .select("body")
      .eq("call_id", args.callId)
      .maybeSingle();
    if (res.error) return { status: "unavailable", error: res.error.message };
    const body = (res.data?.body ?? "").trim();
    if (!body) return { status: "not_yet", reason: "no transcript row for this call yet" };
    return { status: "present", body };
  } catch (err) {
    return {
      status: "unavailable",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// =====================================================================
// Follow-through, from the transcript
// =====================================================================

export type ScorablePrescription = {
  id: string;
  kind: "question" | "end_commitment" | "next_step" | "avoid";
  text: string;
};

export type FollowThroughVerdict = {
  id: string;
  followed: Tristate;
  /** The verbatim transcript quote. Null whenever followed is not "yes". */
  evidence: string | null;
};

const SYSTEM = `You are auditing whether a sales rep did what their pre-call briefing told them to do. You are given the transcript of one customer call and a numbered list of instructions the rep was given BEFORE that call.

For each instruction, decide whether the rep actually carried it out on this call, and quote the line that proves it.

THE TRANSCRIPT IS MACHINE DIARIZED AND FRAGMENTED. Lines are "Speaker: text", one spoken sentence is often split across several lines by the same speaker, and other people's short interjections ("mhm", "yeah", "okay") are interleaved in the middle of it. So the rep's question frequently does NOT appear as one continuous line. Read across a speaker's own consecutive fragments to understand what they said.

Rules:

1. EVIDENCE OR NOTHING. "asked": true requires a quote copied from the transcript word for word. If you cannot find one, "asked" is false and "quote" is null. Never paraphrase, never tidy up the grammar, never quote something the customer said instead of the rep.
1a. Because of the fragmentation above, copy words that are CONTIGUOUS IN ONE SPEAKER'S OWN SPEECH. You may join that speaker's consecutive fragments across an interruption by someone else, because those words really were said in sequence. You may NOT join words from two different speakers, and you may NOT join two separate passages of the same speaker that are minutes apart. If you are unsure, quote the single longest fragment that carries the question, even if it is only part of the sentence. A short true quote is worth more than a long reconstructed one, which will be rejected.
2. Judge the SUBSTANCE, not the wording. The instruction is a suggested phrasing, not a script. A rep who asks "so who else signs off on something this size?" has carried out an instruction to ask who approves the purchase.
2a. SAME INFORMATION, not merely the same topic. The test is whether the rep's question, as asked, would get the customer to supply the specific thing the instruction was after. Two questions that circle the same subject are not the same question:
   - Told "tell me how you run freight ops today and what software you're using", the rep asking "so what brings you to Magaya?" has NOT done it. That asks why they are here, not what they run.
   - Told "what's driving you to look at a new solution right now", the rep saying "so you're doing air imports and want a platform that does EDI with your partner, right?" has NOT done it. That is the rep summarizing what he already knows back at the customer, not asking what changed.
   - Told "who else needs to be part of this decision", the rep asking "is it just you and Temper who decides, or is there anybody else?" HAS done it. Same information, different words.
   An opening pleasantry, a recap of what the customer already said, or a question that merely mentions the subject does not count. When the quote you are about to give is broader, vaguer or about something adjacent, answer false.
3. The rep must have asked it. A customer volunteering the information unprompted does NOT count: the ledger measures what the rep did. If the customer raised it and the rep only followed up, that counts only if the rep's follow-up actually pursued the instruction.
4. For an instruction of kind "end_commitment", the test is whether the REP PROPOSED that specific next step on the call, with something concrete attached (a date, a named action, a named person). Whether the customer agreed does not matter here. Quote the rep proposing it.
5. For an instruction of kind "avoid", "asked" means the rep DID the thing they were told not to do. Quote it.
6. Partial credit does not exist. A rep who gestured at the topic without asking the question did not ask it. When genuinely torn, answer false: this feeds a training signal, and a false positive teaches the wrong lesson while a false negative only understates.
7. Return one entry for every instruction, in the same order, using the same "n" numbers you were given.

Return JSON only, no prose and no markdown fences:
{"verdicts": [{"n": number, "asked": boolean, "quote": string | null}]}`;

function buildUserMessage(
  prescriptions: ReadonlyArray<ScorablePrescription>,
  transcript: string,
  ctx: { account: string; callDate: string | null },
): string {
  const list = prescriptions
    .map((p, i) => `${i + 1}. [${p.kind}] ${p.text}`)
    .join("\n");
  return [
    `CUSTOMER: ${ctx.account}`,
    ctx.callDate ? `CALL DATE: ${ctx.callDate}` : "",
    ``,
    `INSTRUCTIONS THE REP WAS GIVEN BEFORE THIS CALL:`,
    list,
    ``,
    `TRANSCRIPT OF THE CALL:`,
    transcript,
    ``,
    `For each numbered instruction, did the rep carry it out on this call? Quote verbatim or answer false. Return JSON only.`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

function parseVerdicts(raw: string): Array<{ n: number; asked: boolean; quote: string | null }> | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(s.slice(start, end + 1)) as { verdicts?: unknown };
    if (!Array.isArray(o.verdicts)) return null;
    return o.verdicts
      .map((v) => v as { n?: unknown; asked?: unknown; quote?: unknown })
      .filter((v) => typeof v.n === "number")
      .map((v) => ({
        n: v.n as number,
        asked: v.asked === true,
        quote: typeof v.quote === "string" && v.quote.trim() ? v.quote.trim() : null,
      }));
  } catch {
    return null;
  }
}

/** Loose enough to survive whitespace and punctuation, strict enough that an
 *  invented quote does not pass. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The transcript as one string per speaker, in order.
 *
 * Recall.ai diarizes into fragments and interleaves them, so a single spoken
 * sentence is routinely split across non-adjacent lines with someone else's
 * backchannel in between:
 *
 *   Juan Lopez: So what's driving you to look at
 *   Mariela Cordova: mhm
 *   Juan Lopez: a new solution right now?
 *
 * A contiguous verbatim quote of that question does not exist in the
 * transcript text, which meant the evidence check rejected correct evidence
 * and the ledger recorded a rep who asked the question as a rep who did not.
 * That is the same substitution of absence-of-evidence for
 * evidence-of-absence this file was written to prevent, arriving from the
 * inside.
 *
 * Joining each speaker's own fragments restores the sentence they actually
 * said, without joining across speakers, so a quote still cannot be assembled
 * out of two different people's words.
 */
function speakerStreams(transcript: string): string[] {
  const bySpeaker = new Map<string, string[]>();
  for (const line of transcript.split("\n")) {
    // "Name: text". Bounded so a colon inside speech does not create a speaker.
    const m = /^\s*([^:]{1,60}?):\s*(.*)$/.exec(line);
    if (m) {
      const list = bySpeaker.get(m[1]) ?? [];
      list.push(m[2]);
      bySpeaker.set(m[1], list);
    } else {
      const list = bySpeaker.get("") ?? [];
      list.push(line);
      bySpeaker.set("", list);
    }
  }
  return [...bySpeaker.values()].map((parts) => normalize(parts.join(" ")));
}

/** Transcript text with the speaker labels removed, everything else intact. */
function withoutSpeakerLabels(transcript: string): string {
  return normalize(
    transcript
      .split("\n")
      .map((l) => l.replace(/^\s*[^:]{1,60}?:\s*/, ""))
      .join(" "),
  );
}

/**
 * Is this quote actually in the transcript.
 *
 * A model that invents its evidence is the one failure mode that would quietly
 * turn this ledger into fiction, and it is cheap to check. A quote that does
 * not appear is treated as no quote, which by rule 1 means the instruction was
 * not followed.
 *
 * Three places it may appear, in order of strictness. All three require the
 * words to be contiguous somewhere; none of them will assemble a quote out of
 * fragments that are not adjacent in some real reading of the call.
 */
export function quoteAppearsIn(transcript: string, quote: string): boolean {
  const q = normalize(quote);
  if (q.length < 12) return false; // too short to be evidence of anything
  if (normalize(transcript).includes(q)) return true;
  if (withoutSpeakerLabels(transcript).includes(q)) return true;
  return speakerStreams(transcript).some((s) => s.includes(q));
}

export type ScoreCallResult =
  | { status: "scored"; verdicts: FollowThroughVerdict[]; discardedQuotes: number }
  /** The model call failed or returned nothing usable. Retry later. */
  | { status: "unavailable"; error: string };

/**
 * Score every prescription for one call, in one model call.
 *
 * Returns "unavailable" rather than a list of "no" verdicts when the model
 * cannot be reached or its answer cannot be parsed. A failed audit that looks
 * like a rep who did nothing is precisely the substitution this codebase keeps
 * paying for.
 */
export async function scoreCallPrescriptions(args: {
  prescriptions: ReadonlyArray<ScorablePrescription>;
  transcript: string;
  account: string;
  callDate: string | null;
}): Promise<ScoreCallResult> {
  if (args.prescriptions.length === 0) {
    return { status: "scored", verdicts: [], discardedQuotes: 0 };
  }
  // Two attempts. A response that does not parse leaves every prescription on
  // the call unscored, which on a re-run reads as a rep who was never audited,
  // and one call in the first full run was lost exactly this way. Retrying once
  // is far cheaper than the alternative of a call silently skipped every run.
  let parsed: ReturnType<typeof parseVerdicts> = null;
  let lastError = "";
  for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
    let raw: string;
    try {
      const resp = await runModel({
        task: "prescription.scoring",
        maxTokens: 2000,
        temperature: 0,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content:
              buildUserMessage(args.prescriptions, args.transcript, {
                account: args.account,
                callDate: args.callDate,
              }) +
              (attempt > 0
                ? `\n\nYour previous response could not be parsed. Return ONLY the JSON object, with no preamble, no explanation and no markdown fences.`
                : ""),
          },
        ],
      });
      const block = resp.message.content.find((b) => b.type === "text");
      raw = block && "text" in block ? block.text : "";
      if (resp.truncated) {
        lastError = "model ran out of output tokens before finishing the verdicts";
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }
    parsed = parseVerdicts(raw);
    if (!parsed && !lastError) lastError = "model response could not be parsed as verdicts";
  }

  if (!parsed) {
    return { status: "unavailable", error: lastError || "model response could not be parsed as verdicts" };
  }

  const byIndex = new Map(parsed.map((v) => [v.n, v]));
  let discardedQuotes = 0;
  const verdicts: FollowThroughVerdict[] = args.prescriptions.map((p, i) => {
    const v = byIndex.get(i + 1);
    // The model skipped this instruction entirely. Not an answer.
    if (!v) return { id: p.id, followed: "unknown", evidence: null };
    if (!v.asked || !v.quote) return { id: p.id, followed: "no", evidence: null };
    if (!quoteAppearsIn(args.transcript, v.quote)) {
      discardedQuotes += 1;
      // A discarded quote is the one case where a "no" might be our fault
      // rather than the rep's, so it is inspectable rather than silent.
      if (process.env.PRESCRIPTION_DEBUG === "1") {
        console.warn(
          `[prescription-scoring] ${args.account}: quote not found in transcript, scoring "${p.text.slice(0, 60)}" as not followed. Quote was: "${v.quote}"`,
        );
      }
      return { id: p.id, followed: "no", evidence: null };
    }
    return { id: p.id, followed: "yes", evidence: v.quote };
  });

  return { status: "scored", verdicts, discardedQuotes };
}

// =====================================================================
// The email channel, for end commitments only
// =====================================================================

/**
 * A commitment can be secured after the call. A question cannot.
 *
 * The briefing tells the rep to ASK the question on the call, so the call is
 * where it did or did not happen and the transcript is the whole answer. An
 * end commitment is different: the first run of this scorer found 21 of them
 * and exactly one proposed out loud, with seven of the remaining twenty
 * followed by mail from the rep to the customer. Scoring those from the
 * transcript alone recorded reps who did the work as reps who did nothing.
 *
 * So this pass runs ONLY for end commitments the call did not settle, and it
 * can only ever turn a "no" into a "yes". It never downgrades: the transcript
 * already answered whether it happened on the call, and this is asking a
 * second, additional question.
 */
const EMAIL_SYSTEM = `You are checking whether a sales rep secured a specific next step with a customer by email, after a call where they did not secure it out loud.

You are given the next step the rep was supposed to secure, and the emails the rep sent that customer after the call.

Rules:

1. EVIDENCE OR NOTHING. "secured": true requires a quote copied word for word from one of the emails. If you cannot find one, "secured" is false and "quote" is null.
2. The rep must ACTUALLY MAKE THE MOVE, not mention the topic. "Are you free Thursday the 21st at 10am ET to walk through the estimate?" secures a next step. "Great speaking today, let me know if you have questions" does not, and neither does "we should find time soon".
3. It must be the SAME next step, or close enough that a sales manager would call it the same move. A proposed demo is not a signed NDA. If the instruction named a date or a week and the rep proposed a materially different one, that still counts: the rep secured the step, the timing is their call.
4. Only the rep's own words count. Quoting the customer's reply does not prove the rep asked.
5. When torn, answer false.

Return JSON only, no prose and no markdown fences:
{"secured": boolean, "quote": string | null}`;

export type EmailCommitmentResult =
  | { status: "secured"; evidence: string }
  | { status: "not_secured" }
  /** No mail to search. Not an answer; the row stays unchecked and retryable. */
  | { status: "no_mail" }
  | { status: "unavailable"; error: string };

/**
 * Did the rep secure this commitment in writing after the call.
 *
 * One model call per commitment, and only for commitments the transcript
 * already scored as not done, so the common case costs nothing.
 */
export async function scoreCommitmentInEmail(args: {
  commitment: string;
  /** Subject + body of each message the rep sent the customer after the call. */
  emails: Array<{ subject: string; body: string }>;
  account: string;
}): Promise<EmailCommitmentResult> {
  if (args.emails.length === 0) return { status: "no_mail" };

  const corpus = args.emails
    .map((e, i) => `--- EMAIL ${i + 1} ---\nSubject: ${e.subject}\n${e.body}`)
    .join("\n\n");

  let raw: string;
  try {
    const resp = await runModel({
      task: "prescription.commitment_email",
      maxTokens: 700,
      temperature: 0,
      system: EMAIL_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            `CUSTOMER: ${args.account}`,
            ``,
            `THE NEXT STEP THE REP WAS SUPPOSED TO SECURE:`,
            args.commitment,
            ``,
            `WHAT THE REP SENT THEM AFTER THE CALL:`,
            corpus,
            ``,
            `Did the rep secure that next step in these emails? Quote word for word or answer false. Return JSON only.`,
          ].join("\n"),
        },
      ],
    });
    const block = resp.message.content.find((b) => b.type === "text");
    raw = block && "text" in block ? block.text : "";
  } catch (err) {
    return { status: "unavailable", error: err instanceof Error ? err.message : String(err) };
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { status: "unavailable", error: "model response could not be parsed" };
  }
  let parsed: { secured?: unknown; quote?: unknown };
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { status: "unavailable", error: "model response was not valid JSON" };
  }
  if (parsed.secured !== true) return { status: "not_secured" };
  const quote = typeof parsed.quote === "string" ? parsed.quote.trim() : "";
  if (!quote) return { status: "not_secured" };

  // Same discipline as the transcript path: evidence that is not in the source
  // is not evidence. The email corpus is clean prose rather than diarized
  // fragments, so a plain contiguous check is the right strictness here.
  if (!quoteAppearsIn(corpus, quote)) {
    if (process.env.PRESCRIPTION_DEBUG === "1") {
      console.warn(
        `[prescription-scoring] ${args.account}: email quote not found in the rep's sent mail, not counting it. Quote was: "${quote}"`,
      );
    }
    return { status: "not_secured" };
  }
  return { status: "secured", evidence: quote };
}

/** How many of the rep's post-call emails to read in full. */
const EMAIL_BODIES_TO_READ = 3;

/**
 * Run the email pass for one call's unsettled commitments.
 *
 * Stamps email_checked_at ONLY when the mailbox was genuinely read. A mailbox
 * we could not open leaves the marker null so the next run tries again, which
 * is the difference between "the rep did not do it" and "we have not looked",
 * carried all the way into the column.
 */
async function runEmailPass(args: {
  db: ReturnType<typeof supabaseAdmin>;
  rows: LedgerRow[];
  mail: PostCallMailRead;
  account: string;
  callId: string;
  /** The call's own timestamp, which is where the evidence window starts. */
  callAt: string;
  dryRun: boolean;
  counts: ScoringCounts;
  emit: (d: ScoringDecision) => void;
}): Promise<void> {
  const { db, rows, mail, account, callId, callAt, dryRun, counts, emit } = args;
  const daysSinceCall = Math.floor((Date.now() - Date.parse(callAt)) / 86_400_000);
  const settled = Number.isFinite(daysSinceCall) && daysSinceCall >= COMMITMENT_SETTLE_DAYS;

  if (mail.status !== "read") {
    // Not checked, and deliberately not stamped.
    counts.commitmentsEmailUnchecked += rows.length;
    emit({
      kind: "email-unchecked",
      callId,
      account,
      rows: rows.length,
      detail: `no mailbox read (${mail.status}), so these stay "not on the call" rather than "not anywhere"`,
    });
    return;
  }

  // Bodies, because bodyPreview is the first ~255 characters and a dated ask
  // usually sits at the end of a follow-up rather than the start.
  const { getMessageBody } = await import("./graph-mail");
  const emails: Array<{ subject: string; body: string }> = [];
  for (const m of mail.outbound.slice(0, EMAIL_BODIES_TO_READ)) {
    const body = await getMessageBody({
      tenantIdOrDomain: "magaya.com",
      mailbox: mail.mailbox,
      messageId: m.id,
    }).catch(() => null);
    emails.push({ subject: m.subject, body: body ?? m.preview });
  }

  for (const row of rows) {
    const result = await scoreCommitmentInEmail({
      commitment: row.text,
      emails,
      account,
    });

    if (result.status === "unavailable") {
      counts.errors += 1;
      emit({ kind: "error", callId, account, message: `email pass failed: ${result.error}` });
      continue;
    }
    if (result.status === "no_mail") {
      // An empty mailbox is only a real negative once the commitment has had
      // time to be kept. Inside the settle window it means "not yet", so the
      // marker is NOT stamped and the row comes back on the next run. Stamping
      // here is what froze 67 rows at 'no' on evidence that had not happened.
      if (!settled) {
        counts.commitmentsNotYetDue += 1;
        emit({ kind: "email-not-yet-due", callId, account, text: row.text, daysSinceCall });
        continue;
      }
      // Past the window: read, empty, and now old enough to mean it.
      if (!dryRun) {
        await db
          .from("prescribed_actions")
          .update({ email_checked_at: new Date().toISOString() })
          .eq("id", row.id);
      }
      continue;
    }

    if (!dryRun) {
      const upd = await db
        .from("prescribed_actions")
        .update(
          result.status === "secured"
            ? {
                followed: "yes" as const,
                // Channel-prefixed, so nobody reads an email line as
                // something the rep said on the call.
                followed_evidence: `[email] ${result.evidence}`,
                email_checked_at: new Date().toISOString(),
              }
            : // Same rule as the no_mail branch: mail exists but does not
              // contain the commitment, which inside the settle window is still
              // "not yet" rather than "never". Leave it open.
              settled
              ? { email_checked_at: new Date().toISOString() }
              : {},
        )
        .eq("id", row.id);
      if (upd.error) {
        counts.errors += 1;
        console.error(
          `[prescription-scoring] email verdict write failed for row ${row.id}: ${upd.error.message}`,
        );
        continue;
      }
    }

    if (result.status === "secured") {
      counts.commitmentsSecuredByEmail += 1;
      // The row moves from no to yes. Keep the run totals honest.
      counts.rowsFollowed += 1;
      counts.rowsNotFollowed = Math.max(0, counts.rowsNotFollowed - 1);
      emit({
        kind: "email-secured",
        callId,
        account,
        text: row.text,
        evidence: result.evidence,
      });
    }
  }
}

// =====================================================================
// The job
// =====================================================================

export type ScoringDecision =
  | { kind: "scored"; callId: string; account: string; rows: number; followed: number; notFollowed: number }
  | { kind: "no-transcript"; callId: string; account: string; rows: number; retry: boolean; detail: string }
  | { kind: "outcomes-only"; callId: string; account: string; rows: number; detail: string }
  /** A commitment the call did not settle, secured by email afterwards. */
  | { kind: "email-secured"; callId: string; account: string; text: string; evidence: string }
  /** The mailbox could not be read, so the email channel was not checked. */
  | { kind: "email-unchecked"; callId: string; account: string; rows: number; detail: string }
  /** Read, empty, and too soon for that to mean anything. Left open. */
  | { kind: "email-not-yet-due"; callId: string; account: string; text: string; daysSinceCall: number }
  | { kind: "skip"; callId: string; account: string; reason: string }
  | { kind: "error"; callId: string; account: string; message: string };

export type ScoringCounts = {
  callsSeen: number;
  callsScored: number;
  rowsScored: number;
  rowsFollowed: number;
  rowsNotFollowed: number;
  /** Rows retired without an answer because their call has no conversation. */
  rowsRetiredNoContent: number;
  /** Rows left in the queue because their transcript has not arrived. */
  rowsAwaitingTranscript: number;
  outcomesWritten: number;
  quotesDiscarded: number;
  /** End commitments the call did not settle but the rep secured by email. */
  commitmentsSecuredByEmail: number;
  /** End commitments whose email channel could not be checked. Retryable. */
  commitmentsEmailUnchecked: number;
  /** End commitments still inside their settle window, deliberately not decided. */
  commitmentsNotYetDue: number;
  errors: number;
};

export type ScoringOptions = {
  tenantSlug: string;
  /** Print what would happen and write nothing. */
  dryRun?: boolean;
  /** Restrict to these rep emails (deals.rep_email, lowercased). */
  repEmails?: string[];
  /**
   * How far back to refresh outcomes on rows that are already scored. Defaults
   * to OUTCOME_REFRESH_DAYS. Does not bound unscored rows, which are always
   * picked up however old they are.
   */
  since?: string;
  /** Safety bound on calls per run. */
  maxCalls?: number;
  /**
   * Score rows that already carry a verdict, overwriting it.
   *
   * For when the scorer itself changed, which is the only honest reason to
   * revisit a decided row. Deliberately not the default and never automatic:
   * the never-overwrite rule governs ISSUE, and a verdict quietly changing
   * under a rep would be just as bad. An operator asks for this explicitly.
   */
  rescore?: boolean;
  onDecision?: (d: ScoringDecision) => void;
};

type LedgerRow = {
  id: string;
  deal_id: string;
  call_id: string;
  kind: ScorablePrescription["kind"];
  text: string;
  scored_at: string | null;
  followed: Tristate;
  email_checked_at: string | null;
};

const LEDGER_SELECT =
  "id, deal_id, call_id, kind, text, scored_at, followed, email_checked_at";

/**
 * Score unscored prescriptions and refresh deterministic outcomes.
 *
 * Grouped by call, because the transcript read and the model call are both
 * per-call. One model call per call, never one per prescription.
 */
export async function runPrescriptionScoring(
  opts: ScoringOptions,
): Promise<ScoringCounts> {
  const counts: ScoringCounts = {
    callsSeen: 0,
    callsScored: 0,
    rowsScored: 0,
    rowsFollowed: 0,
    rowsNotFollowed: 0,
    rowsRetiredNoContent: 0,
    rowsAwaitingTranscript: 0,
    outcomesWritten: 0,
    quotesDiscarded: 0,
    commitmentsSecuredByEmail: 0,
    commitmentsEmailUnchecked: 0,
    commitmentsNotYetDue: 0,
    errors: 0,
  };
  const emit = opts.onDecision ?? (() => {});
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId(opts.tenantSlug);

  // Everything in play: every unscored row regardless of age, plus scored rows
  // whose call is recent enough that its outcomes are still moving.
  //
  // The age bound deliberately does NOT apply to unscored rows. Bounding those
  // too would strand any row whose transcript arrived late behind a window it
  // had already fallen out of, and it would be stranded silently, which is the
  // shape of bug this ledger is supposed to help find rather than create.
  const refreshFrom = new Date(Date.now() - OUTCOME_REFRESH_DAYS * 86_400_000).toISOString();
  const rowsRes = await db
    .from("prescribed_actions")
    .select(LEDGER_SELECT)
    .eq("tenant_id", tenantId)
    .or(`scored_at.is.null,issued_at.gte.${opts.since ?? refreshFrom}`)
    .order("issued_at", { ascending: true });
  if (rowsRes.error) {
    throw new Error(ledgerError(`[prescription-scoring] ledger read failed: ${rowsRes.error.message}`));
  }
  const rows = (rowsRes.data ?? []) as LedgerRow[];
  if (rows.length === 0) return counts;

  // Resolve the calls and deals these rows belong to.
  const callIds = [...new Set(rows.map((r) => r.call_id))];
  const callsRes = await db
    .from("calls")
    .select("id, deal_id, scheduled_start, call_date, outcome, participants")
    .in("id", callIds);
  if (callsRes.error) {
    throw new Error(`[prescription-scoring] calls read failed: ${callsRes.error.message}`);
  }
  const calls = new Map(
    (callsRes.data ?? []).map((c) => [c.id, c as (typeof callsRes.data)[number]]),
  );

  const dealIds = [...new Set(rows.map((r) => r.deal_id))];
  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rep_email")
    .in("id", dealIds);
  if (dealsRes.error) {
    throw new Error(`[prescription-scoring] deals read failed: ${dealsRes.error.message}`);
  }
  const deals = new Map((dealsRes.data ?? []).map((d) => [d.id, d]));

  const wantedReps = new Set((opts.repEmails ?? []).map((e) => e.trim().toLowerCase()));

  // Group by call.
  const byCall = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const list = byCall.get(r.call_id);
    if (list) list.push(r);
    else byCall.set(r.call_id, [r]);
  }

  let processed = 0;
  for (const [callId, callRows] of byCall) {
    if (opts.maxCalls && processed >= opts.maxCalls) break;
    const call = calls.get(callId);
    const deal = deals.get(callRows[0].deal_id);
    const account = deal?.account ?? callRows[0].deal_id;
    counts.callsSeen += 1;
    processed += 1;

    if (!call) {
      // The row points at a call that is not there. Say so; do not score it as
      // anything.
      counts.errors += 1;
      emit({ kind: "error", callId, account, message: "call row not found" });
      continue;
    }
    if (
      wantedReps.size > 0 &&
      !wantedReps.has((deal?.rep_email ?? "").trim().toLowerCase())
    ) {
      emit({ kind: "skip", callId, account, reason: "rep not selected" });
      continue;
    }

    try {
      const at = call.scheduled_start ?? call.call_date ?? null;
      if (!at) {
        counts.errors += 1;
        emit({ kind: "error", callId, account, message: "call has no date" });
        continue;
      }

      // --- 1. Follow-through, for rows not yet decided.
      const unscored = opts.rescore
        ? callRows
        : callRows.filter((r) => r.scored_at === null);
      let scoredThisCall = 0;
      // Each row's verdict as of this run, so the email pass below reads what
      // we just wrote rather than the stale value from the opening query.
      const followedNow = new Map(callRows.map((r) => [r.id, r.followed]));
      if (unscored.length > 0) {
        const transcript = await readTranscriptForCall({ callId, outcome: call.outcome });

        if (transcript.status === "present") {
          const result = await scoreCallPrescriptions({
            prescriptions: unscored.map((r) => ({ id: r.id, kind: r.kind, text: r.text })),
            transcript: transcript.body,
            account,
            callDate: at.slice(0, 10),
          });
          if (result.status === "unavailable") {
            // Leave every row unscored. A failed audit must never look like a
            // rep who did nothing.
            counts.errors += 1;
            emit({ kind: "error", callId, account, message: `scoring failed: ${result.error}` });
          } else {
            counts.quotesDiscarded += result.discardedQuotes;
            for (const v of result.verdicts) {
              // A verdict the model skipped stays unknown AND stays unscored,
              // so the next run tries again.
              if (v.followed === "unknown") continue;
              if (!opts.dryRun) {
                const upd = await db
                  .from("prescribed_actions")
                  .update({
                    followed: v.followed,
                    followed_evidence: v.evidence,
                    scored_at: new Date().toISOString(),
                  })
                  .eq("id", v.id);
                if (upd.error) {
                  counts.errors += 1;
                  console.error(
                    `[prescription-scoring] verdict write failed for row ${v.id}: ${upd.error.message}`,
                  );
                  continue;
                }
              }
              followedNow.set(v.id, v.followed);
              scoredThisCall += 1;
              counts.rowsScored += 1;
              if (v.followed === "yes") counts.rowsFollowed += 1;
              else counts.rowsNotFollowed += 1;
            }
            if (scoredThisCall > 0) counts.callsScored += 1;
            emit({
              kind: "scored",
              callId,
              account,
              rows: scoredThisCall,
              followed: result.verdicts.filter((v) => v.followed === "yes").length,
              notFollowed: result.verdicts.filter((v) => v.followed === "no").length,
            });
          }
        } else if (transcript.status === "no_content") {
          // There will never be a transcript. Retire the rows unanswered so
          // they stop consuming a model call every run, still carrying
          // followed='unknown' because we genuinely did not check.
          if (!opts.dryRun) {
            const upd = await db
              .from("prescribed_actions")
              .update({ scored_at: new Date().toISOString() })
              .in("id", unscored.map((r) => r.id));
            if (upd.error) {
              counts.errors += 1;
              console.error(
                `[prescription-scoring] retire write failed for call ${callId}: ${upd.error.message}`,
              );
            }
          }
          counts.rowsRetiredNoContent += unscored.length;
          emit({
            kind: "no-transcript",
            callId,
            account,
            rows: unscored.length,
            retry: false,
            detail: `call outcome '${transcript.outcome}', there was no conversation to score against`,
          });
        } else {
          counts.rowsAwaitingTranscript += unscored.length;
          emit({
            kind: "no-transcript",
            callId,
            account,
            rows: unscored.length,
            retry: true,
            detail:
              transcript.status === "not_yet"
                ? transcript.reason
                : `transcript read failed: ${transcript.error}`,
          });
        }
      }

      // --- 2. Deterministic outcomes, once the call has had time to produce
      // them and while they are still moving.
      const ageDays = (Date.now() - Date.parse(at)) / 86_400_000;
      if (ageDays >= OUTCOME_SETTLE_DAYS && ageDays <= OUTCOME_REFRESH_DAYS) {
        const outcomeCall: OutcomeCall = {
          tenantId,
          callId,
          dealId: callRows[0].deal_id,
          at,
          participants: call.participants,
          repEmail: deal?.rep_email ?? null,
          dealExternalId: deal?.external_id ?? null,
        };
        const outcomes = await readCallOutcomes(outcomeCall);
        if (!opts.dryRun) {
          const upd = await db
            .from("prescribed_actions")
            .update({
              outcome_next_meeting: outcomes.nextMeeting.value,
              outcome_draft_sent: outcomes.draftSent.value,
              outcome_stage_moved: outcomes.stageMoved.value,
              outcome_qualification_advanced: outcomes.qualificationAdvanced.value,
              // The reason each value is what it is, carried to the row.
              // OutcomeRead has always produced these and they have only ever
              // reached a console line, so the table could say a row was
              // unknown and could not say why, and answering "why" meant
              // re-reading a CRM that had since moved on. That is this
              // codebase's own failure mode: the work of distinguishing "no"
              // from "did not check" was done and then not recorded.
              outcome_reasons: {
                next_meeting: outcomes.nextMeeting.reason,
                draft_sent: outcomes.draftSent.reason,
                stage_moved: outcomes.stageMoved.reason,
                qualification_advanced: outcomes.qualificationAdvanced.reason,
              },
            })
            .in("id", callRows.map((r) => r.id));
          if (upd.error) {
            counts.errors += 1;
            console.error(
              `[prescription-scoring] outcome write failed for call ${callId}: ${upd.error.message}`,
            );
          }
        }
        counts.outcomesWritten += callRows.length;
        if (unscored.length === 0 || scoredThisCall === 0) {
          emit({
            kind: "outcomes-only",
            callId,
            account,
            rows: callRows.length,
            detail: `next meeting ${outcomes.nextMeeting.value} (${outcomes.nextMeeting.reason}); email ${outcomes.draftSent.value} (${outcomes.draftSent.reason}); CRM stage ${outcomes.stageMoved.value} (${outcomes.stageMoved.reason}); qualification ${outcomes.qualificationAdvanced.value} (${outcomes.qualificationAdvanced.reason})`,
          });
        }

        // --- 3. The email channel, for end commitments the call did not
        // settle. Reuses the mailbox read the outcomes just paid for.
        const pending = callRows.filter(
          (r) =>
            r.kind === "end_commitment" &&
            r.email_checked_at === null &&
            followedNow.get(r.id) === "no",
        );
        if (pending.length > 0) {
          await runEmailPass({
            db,
            rows: pending,
            mail: outcomes.mail,
            account,
            callId,
            callAt: at,
            dryRun: opts.dryRun === true,
            counts,
            emit,
          });
        }
      }
    } catch (err) {
      counts.errors += 1;
      emit({
        kind: "error",
        callId,
        account,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return counts;
}
