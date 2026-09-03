/**
 * What the rep meant by that thumbs down, and what to do about it.
 *
 * Every recap that has carried the feedback footer was voted on, three for
 * three, so this is the highest-response channel we have into six reps who do
 * not otherwise write to us. The point of reading it within minutes rather than
 * at the next check-in is that the rep still remembers the call.
 *
 * IT DIAGNOSES AND REPORTS. IT DOES NOT EDIT.
 *
 * The obvious next step is to let it patch the prompt that produced the bad
 * artifact. It must not, and the reason is in this codebase's own history: the
 * briefing prompt carries rules that exist because a specific sentence reached a
 * paying customer, and a loop that rewrites them from one rep's single click
 * would erase that reasoning with no one reading the diff. A change to what six
 * reps read goes through a person.
 *
 * THE FIRST THING IT MUST RULE OUT IS THAT THE ARTIFACT WAS FINE.
 *
 * The vote that prompted this whole loop was Steven thumbing down a Folguerascb
 * recap on 2026-09-02. Nothing was wrong with the recap. He had been sent two of
 * them 27 seconds apart and was reacting to the duplicate. A diagnosis that read
 * only the text would have "improved" a recap that was already correct, which is
 * worse than doing nothing: it burns the rep's signal and teaches the wrong
 * lesson. So the context around the artifact is assembled BEFORE the text is
 * read, and `not_the_artifact` exists as a first-class answer.
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { supabaseAdmin } from "./supabase";

export type FeedbackVerdict = "actionable" | "needs_you" | "not_the_artifact" | "no_signal";

export type FeedbackDiagnosis = {
  rowId: string;
  kind: string;
  account: string | null;
  repEmail: string;
  vote: "up" | "down";
  note: string | null;
  votedAt: string;
  verdict: FeedbackVerdict;
  /** What the rep was reacting to, in one or two sentences. */
  diagnosis: string;
  /** The specific change, where there is one. Null for no_signal. */
  proposedChange: string | null;
  /** Where the change belongs, so a person can go straight there. */
  wherePossibly: string | null;
  /** Facts about the artifact's delivery, gathered before the text was read. */
  context: string[];
};

/** Everything around the artifact that could explain a vote without the text being at fault. */
async function deliveryContext(row: {
  id: string;
  tenant_id: string;
  call_id: string | null;
  kind: string;
  sent_at: string;
}): Promise<string[]> {
  const db = supabaseAdmin();
  const out: string[] = [];
  if (!row.call_id) return ["This artifact is not tied to a call."];

  // Was the rep sent more than one of these for the same call? This is the
  // Folguerascb case and it is checked first for that reason.
  const siblings = await db
    .from("sent_messages")
    .select("id, sent_at")
    .eq("tenant_id", row.tenant_id)
    .eq("call_id", row.call_id)
    .eq("kind", row.kind);
  if (siblings.error) {
    out.push(`Could not check whether this artifact was sent more than once: ${siblings.error.message}.`);
  } else if ((siblings.data ?? []).length > 1) {
    const times = (siblings.data as Array<{ sent_at: string }>).map((r) => r.sent_at).sort();
    const gap = Math.round((Date.parse(times[times.length - 1]) - Date.parse(times[0])) / 1000);
    out.push(
      `THE REP WAS SENT ${times.length} OF THESE for the same call, ${gap} seconds apart. ` +
        `A vote on a duplicate is usually about the duplicate.`,
    );
  } else {
    out.push("Only one of these was sent for this call.");
  }

  const call = await db
    .from("calls")
    .select("outcome, meeting_type, call_subtype, title, call_date")
    .eq("id", row.call_id)
    .maybeSingle();
  if (call.error) {
    out.push(`Could not read the call: ${call.error.message}.`);
  } else if (call.data) {
    const c = call.data as { outcome: string | null; meeting_type: string | null; call_subtype: string | null; title: string | null };
    out.push(`The call was "${c.title ?? "untitled"}", type ${c.meeting_type ?? "unclassified"}/${c.call_subtype ?? "none"}, outcome ${c.outcome ?? "none recorded"}.`);
    const tr = await db.from("transcripts").select("body").eq("call_id", row.call_id).maybeSingle();
    const chars = String((tr.data as { body?: string } | null)?.body ?? "").length;
    out.push(
      chars === 0
        ? "NO TRANSCRIPT IS STORED for this call, so the artifact was written from little or nothing."
        : `The transcript is ${chars} characters.`,
    );
  }
  return out;
}

const SYSTEM = `You are reading one piece of feedback a salesperson left on something DealRipe generated for them, and working out what they were reacting to.

DealRipe sends three artifacts: a BRIEFING about 30 minutes before a call, a RECAP after it, and a FOLLOW-UP DRAFT that is put in the rep's Outlook addressed to the customer.

Answer with one verdict:

- "not_the_artifact": the rep was reacting to something other than the writing. THE DELIVERY CONTEXT IS GIVEN TO YOU FIRST AND YOU MUST READ IT BEFORE THE TEXT. If they were sent the same thing twice, or the call had no transcript, or the meeting never happened, that explains the vote and the text is probably fine. Choose this whenever the context explains the vote, even if you can also see things you would improve in the writing.
- "actionable": a specific, fixable defect in what was generated. You can name the sentence and say what it should have done instead.
- "needs_you": real, but a person has to decide. It touches what DealRipe should say, how it should position something, or a rep disagreeing with the product's approach rather than its execution.
- "no_signal": you looked and there is nothing to learn. A bare thumbs up with no note is usually this. Do not invent a lesson from approval.

Rules:
- A thumbs UP with no note is "no_signal" unless the context shows something notable.
- NEVER propose a change you cannot tie to a specific sentence or a specific missing thing.
- Do not propose rewriting prompt rules wholesale. The person reading this owns that decision.
- Be concrete and short. "The opening recites the modules demoed instead of what the customer said" beats "improve the opening".

Return ONLY JSON:
{"verdict":"...","diagnosis":"one or two sentences","proposedChange":"the specific change, or null","wherePossibly":"a file or prompt rule if you can name one, else null"}`;

function parse(raw: string): { verdict: string; diagnosis: string; proposedChange: string | null; wherePossibly: string | null } | null {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(t.slice(a, b + 1)) as Record<string, unknown>;
    if (typeof o.verdict !== "string" || typeof o.diagnosis !== "string") return null;
    return {
      verdict: o.verdict,
      diagnosis: o.diagnosis,
      proposedChange: typeof o.proposedChange === "string" && o.proposedChange.trim() ? o.proposedChange : null,
      wherePossibly: typeof o.wherePossibly === "string" && o.wherePossibly.trim() ? o.wherePossibly : null,
    };
  } catch {
    return null;
  }
}

const VERDICTS = new Set<FeedbackVerdict>(["actionable", "needs_you", "not_the_artifact", "no_signal"]);

/**
 * Diagnose every vote nobody has looked at yet.
 *
 * `markReviewed` false leaves the rows untouched, which is what the script uses
 * so a person can see what it would say before it starts consuming the queue.
 */
export async function reviewNewFeedback(args: {
  tenantId: string;
  limit?: number;
  markReviewed: boolean;
}): Promise<{ diagnoses: FeedbackDiagnosis[]; errors: string[] }> {
  const db = supabaseAdmin();
  const errors: string[] = [];

  const pending = await db
    .from("sent_messages")
    .select("id, tenant_id, kind, call_id, deal_id, to_email, subject, body_text, feedback, feedback_note, feedback_at, sent_at")
    .eq("tenant_id", args.tenantId)
    .not("feedback", "is", null)
    .is("feedback_reviewed_at", null)
    .order("feedback_at", { ascending: true })
    .limit(args.limit ?? 20);
  if (pending.error) {
    // The column may not exist yet. Say which it is rather than reporting zero
    // votes, because "nothing to review" and "could not look" are the two
    // things this codebase keeps confusing.
    return { diagnoses: [], errors: [`could not read pending feedback: ${pending.error.message}`] };
  }

  const rows = (pending.data ?? []) as Array<{
    id: string; tenant_id: string; kind: string; call_id: string | null; deal_id: string | null;
    to_email: string; subject: string; body_text: string | null;
    feedback: string; feedback_note: string | null; feedback_at: string; sent_at: string;
  }>;

  const client = getAnthropicClient();
  const diagnoses: FeedbackDiagnosis[] = [];

  for (const row of rows) {
    let account: string | null = null;
    if (row.deal_id) {
      const d = await db.from("deals").select("account").eq("id", row.deal_id).maybeSingle();
      account = (d.data as { account?: string } | null)?.account ?? null;
    }
    const context = await deliveryContext(row);

    const user =
      `ARTIFACT: ${row.kind}\n` +
      `ACCOUNT: ${account ?? "unknown"}\n` +
      `REP: ${row.to_email}\n` +
      `THE REP VOTED: ${row.feedback === "up" ? "thumbs up" : "thumbs down"}\n` +
      `THEIR NOTE: ${row.feedback_note ? row.feedback_note : "(they left none)"}\n\n` +
      `DELIVERY CONTEXT, read this before the text:\n${context.map((c) => `- ${c}`).join("\n")}\n\n` +
      `SUBJECT: ${row.subject}\n\n` +
      `WHAT WE SENT THEM:\n${(row.body_text ?? "(no text stored)").slice(0, 6000)}`;

    try {
      const res = await client.messages.create({
        model: getAnthropicModel(),
        max_tokens: 700,
        system: SYSTEM,
        messages: [{ role: "user", content: user }],
      });
      const text = res.content.map((c) => ("text" in c ? c.text : "")).join("");
      const parsed = parse(text);
      if (!parsed || !VERDICTS.has(parsed.verdict as FeedbackVerdict)) {
        errors.push(`${account ?? row.id}: could not parse a verdict`);
        continue;
      }
      const d: FeedbackDiagnosis = {
        rowId: row.id,
        kind: row.kind,
        account,
        repEmail: row.to_email,
        vote: row.feedback === "up" ? "up" : "down",
        note: row.feedback_note,
        votedAt: row.feedback_at,
        verdict: parsed.verdict as FeedbackVerdict,
        diagnosis: parsed.diagnosis,
        proposedChange: parsed.proposedChange,
        wherePossibly: parsed.wherePossibly,
        context,
      };
      diagnoses.push(d);

      if (args.markReviewed) {
        const upd = await db
          .from("sent_messages")
          .update({ feedback_reviewed_at: new Date().toISOString(), feedback_verdict: d.verdict })
          .eq("id", row.id);
        if (upd.error) errors.push(`${account ?? row.id}: diagnosed but not marked, it will be read again: ${upd.error.message}`);
      }
    } catch (err) {
      // Left unmarked on purpose so the next run picks it up. A vote we failed
      // to read is not a vote with nothing in it.
      errors.push(`${account ?? row.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { diagnoses, errors };
}

/** Only the ones worth waking someone for. */
export function worthReporting(d: FeedbackDiagnosis): boolean {
  return d.verdict === "actionable" || d.verdict === "needs_you" || d.verdict === "not_the_artifact";
}
