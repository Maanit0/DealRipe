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
): Promise<string | null> {
  const db = supabaseAdmin();
  const nowIso = new Date().toISOString();

  let calls;
  try {
    const res = await db
      .from("calls")
      .select("id, title, scheduled_start, call_date, outcome, meeting_type")
      .eq("tenant_id", tenantId)
      .eq("deal_id", dealId)
      .lte("scheduled_start", nowIso)
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

  // What we said we would do. An outstanding promise is the single most useful
  // thing to open a call with, and the most embarrassing thing to have missed.
  try {
    const tasks = await db
      .from("tasks")
      .select("title, detail, status, deadline, priority")
      .eq("tenant_id", tenantId)
      .eq("deal_id", dealId)
      .neq("status", "done")
      .order("created_at", { ascending: false })
      .limit(6);
    const open = tasks.data ?? [];
    if (open.length > 0) {
      lines.push("STILL OWED TO THE CUSTOMER FROM LAST TIME:");
      for (const t of open) {
        const due = t.deadline ? ` (due ${shortDate(t.deadline)})` : "";
        lines.push(`  ${t.title}${due}`);
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
    const pres = await db
      .from("prescribed_actions")
      .select("framework_field_key, prescription, asked_on_next_call, created_at")
      .eq("tenant_id", tenantId)
      .eq("deal_id", dealId)
      .order("created_at", { ascending: false })
      .limit(10);
    const unasked = (pres.data ?? []).filter((p) => p.asked_on_next_call === false);
    if (unasked.length > 0) {
      lines.push("ASKED FOR ON A PREVIOUS CALL AND STILL NOT ANSWERED:");
      for (const p of unasked.slice(0, 5)) {
        lines.push(`  ${p.framework_field_key}: ${(p.prescription ?? "").slice(0, 180)}`);
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
