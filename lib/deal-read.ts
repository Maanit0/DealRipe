/**
 * A written read on one deal: where it stands, and why it is where it is.
 *
 * Mark Buman does not need another table. He asked, on 2026-08-26, for the
 * pipeline review to start already inspected, and a row saying "nothing from
 * them in 41 days" is an observation rather than an inspection. The read is the
 * paragraph a good manager writes in their head before a forecast call: what
 * the last real interaction was, what has been learned since, what is actually
 * holding it, and what is now owed by whom.
 *
 * EVIDENCE IS ASSEMBLED, THE VERDICT IS WRITTEN.
 *
 * Everything below the model is a query. Captured fields with the date they
 * were captured and the customer's own words, every call with its outcome,
 * every message with its direction and subject, the commitments and the open
 * gaps. The model turns that into three sentences. It is never asked to decide
 * whether something happened, only to say what the evidence shows.
 *
 * THIS IS WHAT FIXES THE STALE COMMITMENT.
 *
 * "Agreed to sign the NDA so pricing could be sent" sits on a deal forever,
 * because the agreed-next-step column is one field frozen at the moment it was
 * said. A read that sees the NDA field captured eight days LATER can say the
 * NDA is signed and the pricing is the thing now owed. Dates are given on every
 * piece of evidence for exactly that reason: without them nothing can be
 * resolved against anything.
 */

import crypto from "node:crypto";

import { subjectTopic } from "./email-log";
import { runModel } from "./model-run";
import { supabaseAdmin } from "./supabase";

/**
 * Bump when the prompt or the output shape changes.
 *
 * The hash is over the evidence, which is right: a deal where nothing happened
 * should keep its paragraph rather than getting a differently worded one every
 * week. But it means a prompt change can never reach a deal whose evidence has
 * not moved. Three revisions tightening the READ line landed on nothing,
 * because every deal returned a cached read written under the old prompt.
 * The version goes into the hash so a prompt change invalidates exactly what it
 * should: everything, once.
 */
const PROMPT_VERSION = "v4-implication";

/** How far back the evidence goes. Long enough to hold a Magaya cycle. */
const LOOKBACK_DAYS = 120;
/** Cap per section, so one chatty deal cannot crowd out the prompt. */
const MAX_FIELDS = 22;
const MAX_CALLS = 10;
const MAX_MESSAGES = 14;

export type DealEvidence = {
  account: string;
  repName: string;
  stage: string;
  band: string | null;
  amount: number | null;
  closeDate: string | null;
  lines: string[];
  /**
   * What actually happened in the last seven days, as dated facts.
   *
   * A weekly report whose only week-over-week signal is the CRM is blind to the
   * thing DealRipe is for. This needs no stored history: every evidence line
   * carries its own date, so "new since last Monday" is a filter rather than a
   * diff against a snapshot of ourselves.
   */
  changedThisWeek: string[];
  /**
   * The last thing we learned and when, for the weeks where nothing moved.
   *
   * "Nothing new" is a dead cell. A leader looking at a deal that did not move
   * still needs to know when it last did, and what we knew as of then. Maanit,
   * 2026-08-26: "I just don't want any cell to be useless to Mark."
   */
  lastLearned: { key: string; at: string } | null;
  /** False when there is genuinely nothing to read. No model call is made. */
  hasSubstance: boolean;
};

const d10 = (iso: string | null | undefined): string => (iso ? iso.slice(0, 10) : "unknown date");

/**
 * Everything known about one deal, with a date on every line.
 *
 * Ordered oldest to newest inside each section on purpose: the model has to be
 * able to see that a field captured on the 21st supersedes a commitment made on
 * the 14th, and a reverse-chronological list makes that harder to follow than
 * it needs to be.
 */
export async function buildDealEvidence(args: {
  tenantId: string;
  dealId: string;
  account: string;
  repName: string;
  stage: string;
  band: string | null;
  amount: number | null;
  closeDate: string | null;
  missing: string[];
}): Promise<DealEvidence> {
  const db = supabaseAdmin();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const lines: string[] = [];

  const [fx, calls, msgs] = await Promise.all([
    db
      .from("field_extractions")
      .select("framework_field_key, status, answer, evidence, updated_at")
      .eq("tenant_id", args.tenantId)
      .eq("deal_id", args.dealId)
      .eq("status", "Yes")
      .order("updated_at", { ascending: true }),
    db
      .from("calls")
      .select("scheduled_start, title, outcome")
      .eq("tenant_id", args.tenantId)
      .eq("deal_id", args.dealId)
      .gte("scheduled_start", since)
      .order("scheduled_start", { ascending: true }),
    db
      .from("deal_messages")
      .select("direction, customer_side, subject, sent_at, is_calendar_response")
      .eq("tenant_id", args.tenantId)
      .eq("deal_id", args.dealId)
      .eq("is_calendar_response", false)
      .gte("sent_at", since)
      .order("sent_at", { ascending: true }),
  ]);

  const fields = ((fx.data ?? []) as Array<{ framework_field_key: string; answer: string | null; evidence: string | null; updated_at: string | null }>)
    .slice(-MAX_FIELDS);
  if (fields.length > 0) {
    lines.push("WHAT THE CUSTOMER HAS TOLD US, oldest first, with the date it was said:");
    for (const f of fields) {
      const key = f.framework_field_key.replace(/^sql\d_/, "").replace(/_/g, " ");
      lines.push(`- ${d10(f.updated_at)} [${key}] ${String(f.answer ?? "").slice(0, 220)}`);
    }
  }

  const callRows = ((calls.data ?? []) as Array<{ scheduled_start: string; title: string | null; outcome: string | null }>).slice(-MAX_CALLS);
  if (callRows.length > 0) {
    lines.push("", "EVERY MEETING ON THIS DEAL, including the ones that did not happen:");
    for (const c of callRows) {
      const future = Date.parse(c.scheduled_start) > Date.now();
      // A capture failure is OUR bot not getting in, never the customer failing
      // to show. Saying which is the difference between a real signal and an
      // accusation, and the model cannot tell them apart from an outcome string.
      const what =
        future
          ? "SCHEDULED, has not happened yet"
          : c.outcome === "captured"
            ? "held and recorded"
            : c.outcome === "no_conversation" || c.outcome === "no_show"
              ? "nobody from the customer joined"
              : c.outcome === "capture_failed"
                ? "held or not, DealRipe could not get into the room, so nothing is known about it"
                : `outcome ${c.outcome ?? "unset"}`;
      lines.push(`- ${d10(c.scheduled_start)} "${String(c.title ?? "").slice(0, 70)}" ${what}`);
    }
  }

  const messages = ((msgs.data ?? []) as Array<{ customer_side: boolean; subject: string | null; sent_at: string | null }>).slice(-MAX_MESSAGES);
  if (messages.length > 0) {
    const out = messages.filter((m) => !m.customer_side).length;
    const inb = messages.filter((m) => m.customer_side).length;
    lines.push("", `EMAIL, ${out} from us and ${inb} from them in this window, oldest first:`);
    for (const m of messages) {
      lines.push(`- ${d10(m.sent_at)} ${m.customer_side ? "THEM" : "US"}: ${String(m.subject ?? "").slice(0, 90)}`);
    }
  }

  if (args.missing.length > 0) {
    lines.push("", `STILL UNANSWERED after all of the above: ${args.missing.join(", ")}.`);
  }

  // Everything above, filtered to the last seven days. Same source, so the read
  // and the week-over-week line can never disagree about what happened.
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const changedThisWeek: string[] = [];
  // NAME THE THING, DO NOT NAME THE CATEGORY.
  //
  // "learned existing systems" tells a leader a field was filled. It does not
  // tell him they run CargoWise, which is the only part he can use. The answer
  // is already stored next to the key, and a category with the answer withheld
  // is a row that looks informative and is not.
  for (const f of fields) {
    if (d10(f.updated_at) < weekAgo) continue;
    const key = f.framework_field_key.replace(/^sql\d_/, "").replace(/_/g, " ");
    // THE TAG, NOT THE SENTENCE.
    //
    // This column is scanned, and a cell holding "timeline notes: they need to
    // resolve a CBP articles of organization issue first, which..." is narrative
    // wedged into a table: it is truncated mid thought and it crowds out the two
    // other things learned that week. What the customer actually SAID belongs in
    // the read directly below, which is written from the full answer and has room
    // for it. Here the useful fact is only which gates moved.
    changedThisWeek.push(key);
  }
  for (const c of callRows) {
    const day = d10(c.scheduled_start);
    if (day < weekAgo || Date.parse(c.scheduled_start) > Date.now()) continue;
    const subject = String(c.title ?? "").slice(0, 46);
    changedThisWeek.push(
      c.outcome === "captured"
        ? `call held${subject ? `: ${subject}` : ""}`
        : c.outcome === "no_conversation" || c.outcome === "no_show"
          ? `no-show${subject ? `: ${subject}` : ""}`
          : c.outcome === "capture_failed"
            ? `meeting DealRipe could not get into${subject ? `: ${subject}` : ""}`
            : `meeting${subject ? `: ${subject}` : ""}`,
    );
  }
  // EMAIL SUBJECTS ARE NOT THINGS WE LEARNED.
  //
  // GHY printed: 2 from us about "Audit Session Times & Cont. Sessions Times to
  // meet with K...; Lunch?". Two subjects mashed together, truncated mid word,
  // and one of them is the word Lunch. A subject line is not a fact about a
  // deal, and putting it in a column headed "learned" makes the column
  // untrustworthy for the lines that ARE facts.
  //
  // Email still counts, in two places where it means something: the customer
  // signal column, which is about recency, and the read, which is written from
  // the full thread rather than its subject.

  const newest = fields[fields.length - 1];
  const lastLearned = newest?.updated_at
    ? {
        key: newest.framework_field_key.replace(/^sql\d_/, "").replace(/_/g, " "),
        at: d10(newest.updated_at),
      }
    : null;

  return {
    account: args.account,
    repName: args.repName,
    stage: args.stage,
    band: args.band,
    amount: args.amount,
    closeDate: args.closeDate,
    lines,
    changedThisWeek,
    lastLearned,
    hasSubstance: fields.length > 0 || callRows.length > 0 || messages.length > 0,
  };
}

const SYSTEM = `You write two short margin notes on a sales deal for a VP of Sales, read in a table on the morning of a forecast meeting.

Return exactly two lines and nothing else:

CHANGED: <one line>
READ: <one line>

HARD LIMITS. CHANGED is at most 18 words. READ is at most 14 words. Count them before you answer. A longer line is a wrong answer, not a better one.

READ is the IMPLICATION of the evidence. Never a summary, never a retelling, and never a restatement of your own CHANGED line.
  If CHANGED says "Jonathan pulled CargoWise codes himself", READ is "Strong champion, but the Aug 31 close still looks early." Not "Jonathan pulled CargoWise codes."
  If CHANGED says "Two presentations attempted, neither verified", READ is "Still unclear whether the buyer has seen the product." Not "Two presentations could not be confirmed."
  Answer: what does this mean for the deal, the forecast, or the close date.
  Good: "Strong champion, but the Aug 30 close still looks early."
  Good: "Deal is real. The blocker is external."
  Good: "Commit looks aggressive with no reply in 13 days."
  Good: "They are talking, but the deal is not moving."
  Good: "Two meetings attempted, nobody joined."
  Good: "One call booked Aug 13, nobody showed."
  When nothing has been captured, say what was ATTEMPTED and when. Do not write the same generic sentence on every such deal.
  Bad:  "The August 11 session confirmed GHY's core use case, migrating their post-entry audit workflow..."
  Bad:  "Integrity Customs is a one-person startup customs broker that..."
  Bad:  "Forecast is not supported by observable customer evidence."
Never use: "not supported by", "customer evidence", "observable", "momentum", "engagement".

CHANGED is the single most important NEW thing in the last seven days.
  One thing, never a list. Never "budget confirmed, business type learned" - those are database fields.
  Specific: names, competitors, dates, numbers, commitments, blockers.
  Good: "Jonathan pulled CargoWise disposition codes himself to help build the mockup."
  Good: "Isiahphena accepted the proposal and agreed to sign once CBP clears."
  Good: "Customer missed the second demo attempt; no demo has happened yet."
  Positive developments matter as much as problems. This is not a risk field.
  If nothing genuinely new happened, write exactly: No meaningful change. Never invent one.

RULES
- No em-dashes or en-dashes.
- Resolve commitments against later evidence. Agreed on the 14th, a field dated the 21st says signed, so it is DONE.
- If DealRipe could not get into a meeting, say the meeting could not be verified. Never say the customer failed to attend.
- Never invent a fact, date or name.
- Judge the forecast on BUYING BEHAVIOUR, not on blank fields. A customer who accepted a proposal and agreed to sign is a real deal with a blank budget field.
- Say "Signer unknown", "Budget unknown", "Decision process unknown". Never prose for those.`;

export type DealReadResult =
  | { status: "written"; text: string; headline: string | null }
  /** Nothing captured on this deal, so nothing to read. No model call was made. */
  | { status: "no_evidence" }
  | { status: "unavailable"; error: string };

export async function writeDealRead(ev: DealEvidence): Promise<DealReadResult> {
  if (!ev.hasSubstance) return { status: "no_evidence" };
  if (!process.env.ANTHROPIC_API_KEY) return { status: "unavailable", error: "no ANTHROPIC_API_KEY" };

  const user = [
    `DEAL: ${ev.account}, worked by ${ev.repName}.`,
    `Stage ${ev.stage}${ev.band ? `, rep forecast ${ev.band}` : ""}${ev.amount ? `, ${ev.amount} annual` : ""}${ev.closeDate ? `, close date ${ev.closeDate}` : ""}.`,
    `TODAY IS ${new Date().toISOString().slice(0, 10)}.`,
    "",
    ...ev.lines,
    "",
    ev.changedThisWeek.length > 0
      ? `In the last seven days these gates moved: ${ev.changedThisWeek.join(", ")}. CHANGED must come from what those lines actually say above.`
      : "No gate moved in the last seven days. Unless a meeting, no-show or customer email above is genuinely new, CHANGED is exactly: No meaningful change.",
    "",
    "Write the two lines.",
  ].join("\n");

  try {
    const resp = await runModel({
      task: "deal_read",
      maxTokens: 160,
      temperature: 0.2,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    });
    const block = resp.message.content.find((b) => b.type === "text");
    const raw = (block && "text" in block ? block.text : "").trim().replace(/\s*[—–]\s*/g, ", ");
    if (!raw) return { status: "unavailable", error: "model returned nothing" };
    // The headline is split off rather than left in the paragraph: the table
    // cell and the read below it are two different reading jobs, and a cell
    // holding a whole paragraph is what sent this round in circles.
    // ONE SENTENCE, ENDED PROPERLY, NEVER CUT MID-CLAUSE.
    //
    // This used to hard-stop at a word count and append an ellipsis, which put
    // "deal pace is slow for a...", "Brad and Maya sign-off, and..." and "close
    // by Oct 1 is..." into a report a CRO reads. A trailing ellipsis in a
    // leader's summary is worse than a shorter sentence: it says the system had
    // more to tell them and stopped, and there is no way to get the rest.
    //
    // So: take the first sentence whole. Only when it runs past the hard bound
    // does it get cut, and then at the last comma before the bound so the line
    // still ends on a complete clause, with no ellipsis at all.
    const clip = (v: string, words: number): string => {
      const first = (v.split(/(?<=[.!?])\s+/)[0] ?? v).trim();
      const w = first.split(/\s+/);
      if (w.length <= words) return first;
      const cut = w.slice(0, words).join(" ");
      const lastComma = cut.lastIndexOf(",");
      const kept = lastComma > cut.length * 0.5 ? cut.slice(0, lastComma) : cut;
      return kept.replace(/[,;:\s]+$/, "") + ".";
    };
    const hm = /^CHANGED:\s*(.+?)\s*$/im.exec(raw);
    const rm = /^READ:\s*(.+?)\s*$/im.exec(raw);
    const rawHead = hm?.[1]?.trim() ?? "";
    const headline = rawHead && !/^no meaningful change\.?$/i.test(rawHead) ? clip(rawHead, 24) : null;
    // Length is ENFORCED, not asked for. The prompt said "at most 14 words"
    // through three revisions and the model kept returning 58-word retellings,
    // because length is the first instruction a model trades away when it has
    // material. The rule that must hold is held in code.
    const text = clip((rm?.[1] ?? "").trim(), 26);
    if (!text) return { status: "unavailable", error: "model returned no READ line" };
    return { status: "written", text, headline };
  } catch (err) {
    return { status: "unavailable", error: err instanceof Error ? err.message : String(err) };
  }
}


// =====================================================================
// The read as deal state
// =====================================================================

/**
 * A stable fingerprint of the evidence.
 *
 * Taken over the dated lines only. They are all facts about the deal, so this
 * changes when the deal changes and never because the clock moved. Hashing
 * anything we write ourselves, a generated_at or a days-in-stage, would make
 * every deal look like it moved every day, which is the trap lib/snapshot-diff.ts
 * exists to document.
 */
export function evidenceHash(ev: DealEvidence): string {
  return crypto
    .createHash("sha256")
    .update(`${PROMPT_VERSION}\n${ev.lines.join("\n")}`)
    .digest("hex")
    .slice(0, 32);
}

export type StoredRead = { text: string; headline: string | null; generatedAt: string; fresh: boolean };

/**
 * The current read on a deal, generating one only when the evidence has moved.
 *
 * Every consumer calls this: the Monday pipeline review, the digest and the
 * pre-call briefing. One read per deal means those three can no longer describe
 * the same deal differently in the same week, which they could before because
 * each assembled its own view.
 */
export async function refreshDealRead(args: {
  tenantId: string;
  dealId: string;
  evidence: DealEvidence;
  /** Write nothing and return what is stored. For previews. */
  readOnly?: boolean;
}): Promise<StoredRead | null> {
  const db = supabaseAdmin();
  const hash = evidenceHash(args.evidence);

  const existing = await db
    .from("deal_reads")
    .select("text, headline, evidence_hash, generated_at")
    .eq("tenant_id", args.tenantId)
    .eq("deal_id", args.dealId)
    .maybeSingle();
  const row = existing.data as { text: string; headline: string | null; evidence_hash: string; generated_at: string } | null;

  if (row && row.evidence_hash === hash) {
    return { text: row.text, headline: row.headline, generatedAt: row.generated_at, fresh: false };
  }
  if (args.readOnly) {
    // Stale but real beats nothing, and the caller is told which it got.
    return row ? { text: row.text, headline: row.headline, generatedAt: row.generated_at, fresh: false } : null;
  }

  const written = await writeDealRead(args.evidence);
  if (written.status !== "written") {
    if (written.status === "unavailable") {
      console.warn(`[deal-read] ${args.evidence.account}: ${written.error}`);
    }
    // Keep whatever is stored rather than blanking a deal because one model
    // call failed. A missing read reads as "nothing to say about this deal".
    return row ? { text: row.text, headline: row.headline, generatedAt: row.generated_at, fresh: false } : null;
  }

  const now = new Date().toISOString();
  const up = await db.from("deal_reads").upsert(
    {
      tenant_id: args.tenantId,
      deal_id: args.dealId,
      text: written.text,
      headline: written.headline,
      evidence_hash: hash,
      generated_at: now,
      updated_at: now,
    } as never,
    { onConflict: "tenant_id,deal_id" },
  );
  if (up.error) console.error(`[deal-read] upsert failed for ${args.evidence.account}: ${up.error.message}`);
  return { text: written.text, headline: written.headline, generatedAt: now, fresh: true };
}
