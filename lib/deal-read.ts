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

const SYSTEM = `You write one short read on a B2B sales deal for a CRO, to be read just before a pipeline review.

WHAT A READ IS. Three sentences, at most about 60 words. Where the deal actually stands, what the last real interaction produced, and what is now holding it. A manager's read, not a summary of the data you were given.

Rules:
1. No em-dashes or en-dashes. Hard rule.
2. RESOLVE COMMITMENTS AGAINST LATER EVIDENCE. Every line you are given carries a date. If they agreed on the 14th to sign an NDA and a field captured on the 21st says the NDA is signed, the NDA is DONE and the open item is whatever came after it. Never report a commitment as outstanding when a later line shows it was met.
3. Say what is OWED and BY WHOM, in the present tense, naming the person where you have a name.
4. Never say the customer failed to attend when the evidence says DealRipe could not get into the room. Those are different facts and only one of them is about the customer.
5. Do not restate the stage, the amount or the band. The reader can already see those next to your text.
6. Do not hedge and do not pad. No "it appears", no "it seems", no "moving forward".
7. If the evidence is genuinely thin, say so in one sentence rather than inflating it.
8. Never invent a fact, a date or a name that is not in the evidence.

FIRST, ONE HEADLINE. Before the three sentences, write a single line beginning "HEADLINE: " naming the most consequential thing learned about this deal IN THE LAST SEVEN DAYS, in at most twelve words. It is read in a table cell, so it has to stand alone.

A headline is what the customer said or did and what it means: "Confirmed $34,400 a month is in range", "Legal is reviewing the NDA", "Named CargoWise as the incumbent", "Pushed the decision to their October board". It is never a list of field names, never "existing systems, next step, business type", and never a category. If nothing was learned in the last seven days, write exactly "HEADLINE: none".

Then a blank line, then the three sentences.`;

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
      ? `IN THE LAST SEVEN DAYS these gates moved: ${ev.changedThisWeek.join(", ")}. The headline must come from what those actually say above.`
      : "NOTHING moved in the last seven days, so the headline is exactly: none.",
    "",
    "Write the headline and the read.",
  ].join("\n");

  try {
    const resp = await runModel({
      task: "deal_read",
      maxTokens: 300,
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
    const m = /^HEADLINE:\s*(.+?)\s*(?:\n|$)/i.exec(raw);
    const headline = m && !/^none$/i.test(m[1].trim()) ? m[1].trim() : null;
    const text = raw.replace(/^HEADLINE:.*(?:\n|$)/i, "").trim();
    if (!text) return { status: "unavailable", error: "model returned only a headline" };
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
  return crypto.createHash("sha256").update(ev.lines.join("\n")).digest("hex").slice(0, 32);
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
