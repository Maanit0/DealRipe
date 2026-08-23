/**
 * Where this deal actually stands, written from its history rather than from
 * its checklist.
 *
 * WHY THIS EXISTS
 *
 * The digest reads like a form for the same reason the recap used to: it is
 * generated FROM the gate list, so it can only say things the gate list can
 * express. Eduardo's words about the old recap were "it's very tied to the
 * checks that we have", and the fix there was not a better prompt, it was
 * topology. Three independent passes over the transcript instead of one derived
 * pass.
 *
 * Same fix here. A model reading a deal's actual history can say "they moved
 * from evaluating three vendors to shortlisting two, and the finance director
 * joined the last call", which no combination of gates can produce. The gates
 * stay exactly where they are and keep doing what they are good at.
 *
 * THE GUARANTEE, AND IT IS STRUCTURAL RATHER THAN INSTRUCTED
 *
 * This function takes no flags, no gate list and no framework. Not "is told to
 * ignore them", cannot see them. That is the same guarantee buildNarrative has
 * in lib/recap-passes.ts, which has no framework parameter for exactly this
 * reason: an instruction can be quietly undone by a later edit and a missing
 * parameter cannot.
 *
 * So the narrative and the audit are genuinely independent reads of the same
 * deal, and when they agree that means something.
 *
 * WHAT IT READS, AND WHY NOT TRANSCRIPTS
 *
 * The stored recaps, chronologically. IFF Inc carries 118,294 characters of
 * transcript across three calls and 14,159 characters of recap covering the
 * same ground, already distilled by three passes that were themselves grounded
 * in the transcript. Feeding raw transcripts would cost eight times as much to
 * rediscover what we already extracted.
 *
 * Email is passed as SHAPE, never content: who wrote, which direction, when.
 * Magaya is under NDA and lib/email-log.ts deliberately never stores bodies.
 * The shape is enough to say a thread went quiet, which is the part that
 * matters here.
 */

import { runModel } from "./model-run";
import { supabaseAdmin } from "./supabase";

export type DealNarrative = {
  dealId: string;
  /** Two to four sentences. Where the deal stands and what moved it there. */
  text: string;
};

const SYSTEM = `You write two to four sentences for a CRO about where one deal actually stands, from its history.

You are given the recaps of every call on this deal in order, the CRM changes this week, and the shape of the email traffic. You are NOT given a qualification checklist, and you must not invent one: never write about "gates", "stages", "qualification", "the framework", or a list of things that are missing. Another part of this report does that job and does it better.

What to write instead:
- What this customer is actually trying to do, in their own terms, and what has changed about that since the earlier calls.
- Who has come into the conversation or dropped out of it, by name and role.
- What is genuinely different this week versus before, including "nothing" when nothing is.
- If the deal has gone in a direction the earlier calls would not have predicted, say so plainly. That is the most valuable sentence you can write.

Rules:
- Only what the history supports. If two calls said different things, say which is more recent. Never infer a reason the record does not carry: if a date moved and nothing in the history explains it, say the history does not explain it.
- Names and numbers, always, when the history has them. "Christian, the owner, has still not been on a call" beats "the economic buyer is absent".
- No em-dashes and no en-dashes anywhere. Use commas or a new sentence.
- No marketing language, no adjectives about our product, no "excited", no "strong candidate".
- Do not recommend an action. Another section does that. Describe the state.
- Two to four sentences. A CRO reads six of these.

Return the sentences as plain text, nothing else.`;

export async function buildDealNarrative(args: {
  tenantId: string;
  dealId: string;
  account: string;
  /** This week's CRM changes, already rendered as one line each. */
  crmChanges: ReadonlyArray<string>;
}): Promise<DealNarrative | null> {
  const db = supabaseAdmin();

  const [recapsRes, msgsRes, callsRes] = await Promise.all([
    db
      .from("sent_messages")
      .select("body_text, sent_at, call_id")
      .eq("tenant_id", args.tenantId)
      .eq("deal_id", args.dealId)
      .eq("kind", "recap")
      .order("sent_at", { ascending: true }),
    db
      .from("deal_messages")
      .select("sent_at, customer_side, from_email")
      .eq("tenant_id", args.tenantId)
      .eq("deal_id", args.dealId)
      .order("sent_at", { ascending: true }),
    db
      .from("calls")
      .select("scheduled_start, title, outcome, call_subtype")
      .eq("tenant_id", args.tenantId)
      .eq("deal_id", args.dealId)
      .order("scheduled_start", { ascending: true }),
  ]);

  const recaps = (recapsRes.data ?? []) as Array<{ body_text: string | null; sent_at: string | null; call_id: string | null }>;
  // Nothing distilled means nothing to narrate. Returning null is right: an
  // invented paragraph about a deal we have never heard is worse than a card
  // that simply has no narrative on it.
  if (recaps.length === 0) return null;

  const calls = (callsRes.data ?? []) as Array<{
    scheduled_start: string | null;
    title: string | null;
    outcome: string | null;
    call_subtype: string | null;
  }>;
  const msgs = (msgsRes.data ?? []) as Array<{ sent_at: string | null; customer_side: boolean | null }>;

  const inbound = msgs.filter((m) => m.customer_side).length;
  const outbound = msgs.length - inbound;
  const lastIn = msgs.filter((m) => m.customer_side).at(-1)?.sent_at ?? null;
  const lastOut = msgs.filter((m) => !m.customer_side).at(-1)?.sent_at ?? null;

  // Deliberately capped. Six of these run per digest and the oldest recap on a
  // long deal adds little to "what changed this week".
  const body = recaps
    .slice(-4)
    .map((r, i) => `--- RECAP ${i + 1}, ${String(r.sent_at ?? "").slice(0, 10)} ---\n${(r.body_text ?? "").slice(0, 6000)}`)
    .join("\n\n");

  const prompt = [
    `ACCOUNT: ${args.account}`,
    ``,
    `CALLS ON THIS DEAL:`,
    ...calls.map(
      (c) =>
        `  ${String(c.scheduled_start ?? "").slice(0, 10)}  ${c.call_subtype ?? c.outcome ?? "call"}${c.title ? `  "${c.title.slice(0, 70)}"` : ""}`,
    ),
    ``,
    `EMAIL SHAPE (no content is stored; this is who wrote and when):`,
    `  ${outbound} from us, ${inbound} from them.`,
    `  last from us: ${lastOut ? String(lastOut).slice(0, 10) : "never"}. last from them: ${lastIn ? String(lastIn).slice(0, 10) : "never"}.`,
    ``,
    args.crmChanges.length > 0
      ? `WHAT THE REP CHANGED IN THE CRM THIS WEEK:\n${args.crmChanges.map((c) => `  ${c}`).join("\n")}`
      : `The rep changed nothing in the CRM this week.`,
    ``,
    `THE CALL RECAPS, OLDEST FIRST:`,
    body,
  ].join("\n");

  try {
    const res = await runModel({
      task: "digest.narrative",
      tenantId: args.tenantId,
      dealId: args.dealId,
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 500,
      temperature: 0.2,
    });
    // Enforced, never trusted: the dash rule is exact and lossless to fix, and
    // regenerating a whole pass over one character is absurd. Same call
    // lib/briefing-lint.ts makes.
    const text = res.text.trim().replace(/\s*[—–]\s*/g, ", ");
    return text.length < 40 ? null : { dealId: args.dealId, text };
  } catch (err) {
    // Best effort. The digest prints without a narrative rather than not at all.
    console.warn(
      `[digest-narrative] ${args.account}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
