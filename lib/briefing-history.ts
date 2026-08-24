/**
 * What happened last time, for the briefing prompt.
 *
 * The recaps read well and the briefings read vague, and it is not a prompt
 * quality difference: a recap is written with the transcript in front of it,
 * while the briefing only ever saw a snapshot of the qualification record. So
 * the recap says "$250 a month for the customer portal, roughly 10 users,
 * decision maker back next week" and the briefing for the very next call says
 * "budget, decision process and close date are all blank". Both true. Only one
 * is useful.
 *
 * buildMagayaBriefingUserMessage has always accepted a `history` block and
 * nothing ever passed one. This builds it, from three things a rep would
 * actually carry into the room:
 *
 *   1. What the last call established, in the customer's own words.
 *   2. What we promised to do, and whether it is still outstanding.
 *   3. What we asked last time and did not get an answer to.
 *
 * The third is the one that compounds. A gap that has survived two calls is not
 * the same as a gap nobody has raised, and a briefing that repeats a question
 * verbatim without noticing it already failed once is the clearest possible
 * signal that nothing is actually reading the deal.
 */

import { supabaseAdmin } from "./supabase";

const NO_CONTENT = new Set([
  "no_conversation",
  "no_show",
  "rescheduled",
  "placeholder",
  "capture_failed",
  // A second row for a meeting already recorded on another row. Set by
  // scripts/merge-duplicate-calls.ts. Not a real call and must never be
  // counted as one.
  "duplicate",
]);

/** How many past calls to summarize. Two is the useful window: the last call
 *  and the one before it, which is where a stalling pattern first shows. */
const CALLS_TO_SUMMARIZE = 2;

function shortDate(iso: string | null): string {
  if (!iso) return "recently";
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "America/Chicago",
    });
  } catch {
    return "recently";
  }
}

/**
 * Build the SINCE LAST CALL block, or null when this deal has no history worth
 * carrying (a genuinely first conversation, where inventing continuity would be
 * worse than saying nothing).
 */
export async function buildBriefingHistory(
  tenantId: string,
  dealId: string,
  opts?: {
    /**
     * Treat this instant as "now". Defaults to the real now.
     *
     * A briefing is written before a call, so "every call so far" and "every
     * call before this one" are the same set and the default is right. A RECAP
     * is written about one specific call, and there the two differ: previewing
     * Dunavant's Aug 12 recap surfaced the Aug 14 pricing conversation as
     * "prior calls", complete with a figure that had not been quoted yet. In
     * production the recap runs minutes after the call so it rarely shows, but
     * any re-run or backfill leaks the future into the past.
     */
    asOf?: string | null;
  },
): Promise<string | null> {
  const db = supabaseAdmin();
  const nowIso = opts?.asOf ?? new Date().toISOString();
  // A BRIEFING wants every call so far, inclusive of nothing in the future.
  // A RECAP passes asOf = its own call's start, and must exclude that call:
  // otherwise the Dunavant Aug 12 recap lists the Aug 12 call as prior history,
  // which is the recap citing itself. Strict comparison when asOf is supplied
  // does exactly that, because asOf IS this call's timestamp.
  const bound = opts?.asOf ? "lt" : "lte";

  let calls;
  try {
    const res = await db
      .from("calls")
      .select("id, title, scheduled_start, call_date, outcome, meeting_type")
      .eq("tenant_id", tenantId)
      .eq("deal_id", dealId)
      [bound]("scheduled_start", nowIso)
      .order("scheduled_start", { ascending: false })
      .limit(8);
    if (res.error) return null;
    calls = (res.data ?? []).filter((c) => !(c.outcome && NO_CONTENT.has(c.outcome)));
  } catch {
    return null;
  }
  if (calls.length === 0) return null;

  const recent = calls.slice(0, CALLS_TO_SUMMARIZE);
  const recentIds = recent.map((c) => c.id);

  // Facts confirmed on those calls, with the customer's own words. This is the
  // material that makes a recap concrete, and the briefing never had it.
  let byCall = new Map<string, Array<{ label: string; answer: string }>>();
  // Whether we actually read the extractions. Without this the block below
  // prints "(nothing was confirmed on this call)" under every call on the deal
  // when the read fails, which is not a thinner briefing but a false one: it
  // tells the rep their last three calls established nothing. Supabase returns
  // an error in the result rather than throwing, so the error field has to be
  // checked too; relying on the catch alone let a failed query render as a
  // confident empty history.
  let factsRead = true;
  try {
    const fx = await db
      .from("field_extractions")
      .select("framework_field_key, status, answer, evidence, last_updated_from_call_id")
      .eq("tenant_id", tenantId)
      .eq("deal_id", dealId)
      .eq("status", "Yes");
    if (fx.error) throw new Error(fx.error.message);
    for (const r of fx.data ?? []) {
      const cid = r.last_updated_from_call_id;
      if (!cid || !recentIds.includes(cid)) continue;
      const list = byCall.get(cid) ?? [];
      const answer = (r.answer ?? "").trim();
      if (answer) list.push({ label: r.framework_field_key, answer });
      byCall.set(cid, list);
    }
  } catch (err) {
    factsRead = false;
    byCall = new Map();
    console.warn(
      `[briefing-history] confirmed-facts read failed for deal ${dealId}, the briefing will not say what past calls established: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const lines: string[] = [];

  for (const c of recent) {
    const when = shortDate(c.scheduled_start ?? c.call_date);
    const title = (c.title ?? "call").slice(0, 70);
    const facts = byCall.get(c.id) ?? [];
    lines.push(`${when}, "${title}":`);
    if (!factsRead) {
      // Say what we do not know rather than asserting a negative. The model
      // reads this block as fact, and "nothing was confirmed" is the sentence
      // that turns a proposal follow-up back into a discovery call.
      lines.push(`  (what this call confirmed could not be read, do not assume it established nothing)`);
    } else if (facts.length === 0) {
      lines.push(`  (nothing was confirmed on this call)`);
    } else {
      // Cap it. The prompt needs the shape of the conversation, not a
      // transcript; past a handful of lines it crowds out the gaps.
      for (const f of facts.slice(0, 8)) {
        lines.push(`  ${f.label}: ${f.answer.slice(0, 220)}`);
      }
    }
    lines.push("");
  }

  // What we said we would do.
  //
  // CAREFUL: "still owed" is a claim DealRipe cannot currently support.
  //
  // These come from the tasks table filtered on status != 'done', and NOTHING
  // IN THIS CODEBASE EVER WRITES 'done'. Measured 2026-08-23: 206 tasks, 205
  // todo, 1 in_progress, zero done. So the filter is a no-op and the list is
  // every commitment ever extracted from any call on the deal, whether or not
  // the rep delivered it days later.
  //
  // The old heading said "STILL OWED TO THE CUSTOMER FROM LAST TIME", and the
  // IFF briefing turned that into "multiple deliverables owed to Carrie and Ana
  // are past due by weeks", which DealRipe has no way of knowing. Telling a rep
  // they are behind on work they may well have done is worse than saying
  // nothing: it is wrong, it is about their competence, and the same email is
  // asking them to trust our questions.
  //
  // So the framing is now what we can actually stand behind: these were agreed,
  // here is when, and we cannot see whether they were delivered. Closing the
  // loop properly needs delivery evidence (an email with the attachment, a
  // later call referencing it), which prescription-scoring already does for
  // questions and does not yet do for deliverables.
  try {
    const tasks = await db
      .from("tasks")
      .select("title, detail, status, deadline, priority, created_at")
      .eq("tenant_id", tenantId)
      .eq("deal_id", dealId)
      .neq("status", "done")
      // Bounded by the same asOf as the call list above. Without it a recap for
      // an older call listed commitments created by a LATER call as "still owed
      // from last time", which reads as the rep having missed things they had
      // not been asked for yet.
      [bound]("created_at", nowIso)
      .order("created_at", { ascending: false })
      .limit(6);
    const open = tasks.data ?? [];
    if (open.length > 0) {
      lines.push("WHAT WE COMMITTED TO ON EARLIER CALLS:");
      lines.push(
        "  DealRipe cannot see whether these were delivered, so do NOT tell the rep they are overdue,",
      );
      lines.push(
        "  late, or that they have missed anything. Treat them as things to confirm, not to chase.",
      );
      for (const t of open) {
        const agreed = t.created_at ? ` (agreed ${shortDate(t.created_at)})` : "";
        const due = t.deadline ? `, said for ${shortDate(t.deadline)}` : "";
        lines.push(`  ${t.title}${agreed}${due}`);
      }
      lines.push("");
    }
  } catch {
    /* best-effort */
  }

  // Questions we were told to ask and have not. A gap that survived a call is
  // not the same as a gap nobody raised: it usually means the customer dodged
  // it, or the rep did, and asking it identically a second time is how a
  // briefing proves it is not paying attention.
  try {
    //
    // Reads the prescription ledger's `followed` column, which supersedes
    // asked_on_next_call. This block existed for months and never fired once,
    // because the table it reads had no writer: recordPrescription was defined
    // in lib/closed-loop.ts and nothing ever called it.
    //
    // followed = 'no' means the transcript was read and the rep did not do it.
    // 'unknown' is excluded deliberately: a call with no transcript tells us
    // nothing about whether the question was asked, and putting it here would
    // tell a rep they skipped something we never checked.
    const pres = await db
      .from("prescribed_actions")
      .select("framework_field_keys, text, followed, kind, created_at")
      .eq("tenant_id", tenantId)
      .eq("deal_id", dealId)
      .eq("followed", "no")
      .order("created_at", { ascending: false })
      .limit(10);
    const unasked = (pres.data ?? []).filter((p) => p.kind === "question");
    if (unasked.length > 0) {
      lines.push("ASKED FOR ON A PREVIOUS CALL AND STILL NOT ANSWERED:");
      for (const p of unasked.slice(0, 5)) {
        const target = p.framework_field_keys?.[0] ?? "gap";
        lines.push(`  ${target}: ${(p.text ?? "").slice(0, 180)}`);
      }
      lines.push(
        "These have now survived at least one call. Do not re-ask them in the same words. Either come at the gap from a different angle, or name the fact that it keeps not landing and ask directly why.",
      );
      lines.push("");
    }
  } catch {
    /* best-effort */
  }

  const block = lines.join("\n").trim();
  return block.length > 0 ? block : null;
}
