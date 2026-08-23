/**
 * Did the rep send the follow-up DealRipe drafted, edit it, or write their own?
 *
 * This is the wedge measured directly. DealRipe's claim is not that it writes
 * emails, it is that it writes the email the rep would have written and saves
 * them the twenty minutes. The only evidence for or against that is what
 * actually left their mailbox next to what we put in their drafts folder.
 *
 * WHAT IT CANNOT DO YET, AND WHY IT IS STILL WORTH RUNNING
 *
 * createDraft returns a Graph message id and we throw it away, so a sent
 * message cannot be JOINED to the draft it came from. Persisting that id is the
 * proper fix and is a separate change.
 *
 * Until then this matches on time and recipient: our draft for a call, and the
 * first message the rep sent to that customer afterwards. That is a weaker join
 * and it is honest about being one. It cannot tell a rep who ignored our draft
 * and coincidentally wrote a similar email from one who sent ours, and it says
 * so rather than reporting a number that looks exact.
 *
 * THE SIMILARITY NUMBER IS A HINT, NOT A VERDICT.
 *
 * Word overlap over the rep's sent text. High means the sent mail is mostly our
 * words. Low means they wrote their own. It deliberately does not try to be
 * clever: a percentage that looks precise invites more trust than a
 * time-and-recipient join can carry.
 *
 *   npx tsx scripts/draft-adoption.ts              last 30 days
 *   npx tsx scripts/draft-adoption.ts --days 60
 *   npx tsx scripts/draft-adoption.ts --show        print both texts in full
 *
 * Read-only. Reads reps' mailboxes through the same allowlist as everything
 * else, and prints no message body unless --show is passed.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getMessageBody } from "../lib/graph-mail";
import { readPostCallCustomerMail, type OutcomeCall } from "../lib/prescription-outcomes";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const GRAPH_TENANT = "magaya.com";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Words worth comparing: drops punctuation, casing and one-letter noise. */
function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/**
 * How much of what the rep SENT came from our draft.
 *
 * Asymmetric on purpose. Overlap over the sent text answers "is this our
 * email", where overlap over the draft would answer "did they use all of it",
 * and a rep trimming two sentences from a good draft is still a rep who used
 * it. Quoted history in a reply inflates both, which is one more reason this is
 * a hint rather than a verdict.
 */
function overlap(draft: string, sent: string): number {
  const d = new Set(words(draft));
  const s = words(sent);
  if (s.length === 0 || d.size === 0) return 0;
  const hit = s.filter((w) => d.has(w)).length;
  return Math.round((hit / s.length) * 100);
}

/** Strip the quoted chain so a reply is not scored on our own draft text. */
function beforeQuote(body: string): string {
  const cut = body.search(/\n\s*(On .{0,80}wrote:|-----Original Message-----|From: )/);
  return cut > 0 ? body.slice(0, cut) : body;
}

type Row = {
  call_id: string | null;
  body_text: string | null;
  sent_at: string | null;
};

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 30);
  const show = process.argv.includes("--show");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const drafts = await db
    .from("sent_messages")
    .select("call_id, body_text, sent_at")
    .eq("tenant_id", tenantId)
    .eq("kind", "followup_draft")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false });
  if (drafts.error) throw new Error(`drafts read failed: ${drafts.error.message}`);
  const rows = ((drafts.data ?? []) as Row[]).filter((r) => r.call_id && r.body_text);

  console.log(`\n${"=".repeat(84)}`);
  console.log(`DID THE REP SEND OUR DRAFT? last ${days} days`);
  console.log(`${"=".repeat(84)}`);
  console.log(`\n${rows.length} follow-up draft(s) written by DealRipe in this window.\n`);
  if (rows.length === 0) return;

  const callIds = rows.map((r) => r.call_id as string);
  const calls = await db
    .from("calls")
    .select("id, deal_id, scheduled_start, call_date, participants, deals!inner(account, rep_email, external_id)")
    .in("id", callIds);
  if (calls.error) throw new Error(`calls read failed: ${calls.error.message}`);
  const callById = new Map(
    ((calls.data ?? []) as unknown as Array<{
      id: string;
      deal_id: string;
      scheduled_start: string | null;
      call_date: string | null;
      participants: unknown;
      deals: { account: string; rep_email: string | null; external_id: string | null };
    }>).map((c) => [c.id, c]),
  );

  const tally = { sentOurs: 0, edited: 0, ownWords: 0, nothingSent: 0, cannotTell: 0 };

  for (const r of rows) {
    const c = callById.get(r.call_id as string);
    if (!c) continue;
    const when = String(c.scheduled_start ?? c.call_date ?? "").slice(0, 10);
    const head = `${when}  ${c.deals.account}`;

    const mail = await readPostCallCustomerMail({
      tenantId,
      callId: c.id,
      dealId: c.deal_id,
      at: String(c.scheduled_start ?? c.call_date ?? ""),
      participants: c.participants,
      repEmail: c.deals.rep_email,
      dealExternalId: c.deals.external_id,
    } satisfies OutcomeCall);

    if (mail.status !== "read") {
      tally.cannotTell += 1;
      console.log(`  ?  ${head.padEnd(34)} could not check: ${mail.status}`);
      continue;
    }
    const sent = mail.outbound[0];
    if (!sent) {
      tally.nothingSent += 1;
      console.log(`  .  ${head.padEnd(34)} nothing was sent to the customer after this call`);
      continue;
    }

    // THE BODY OR NOTHING.
    //
    // The first version fell back to comparing the SUBJECT when the body could
    // not be read, and four calls scored exactly 100% because a six-word
    // subject line trivially overlaps a long draft. That is a false positive on
    // the one number this script exists to produce, and reporting adoption we
    // have not measured is worse than reporting that we could not measure it.
    let body: string | null = null;
    let bodyError: string | null = null;
    try {
      body = await getMessageBody({ tenantIdOrDomain: GRAPH_TENANT, mailbox: mail.mailbox, messageId: sent.id });
    } catch (err) {
      bodyError = err instanceof Error ? err.message : String(err);
    }
    if (!body || body.trim().length < 40) {
      tally.cannotTell += 1;
      console.log(
        `  ?  ${head.padEnd(34)} they sent "${sent.subject.slice(0, 46)}" but the body could not be read` +
          `${bodyError ? ` (${bodyError.slice(0, 60)})` : " (empty)"}`,
      );
      continue;
    }
    const sentText = beforeQuote(body);
    const pct = overlap(r.body_text as string, sentText);

    // Bands, not a score. See the header: the join is time-and-recipient, so a
    // precise-looking number would claim more than the method supports.
    const verdict = pct >= 65 ? "SENT OURS " : pct >= 35 ? "EDITED    " : "OWN WORDS ";
    if (pct >= 65) tally.sentOurs += 1;
    else if (pct >= 35) tally.edited += 1;
    else tally.ownWords += 1;

    console.log(`  ${verdict} ${head.padEnd(34)} ${String(pct).padStart(3)}% of what they sent is our wording`);
    console.log(`             they sent: "${sent.subject.slice(0, 62)}"`);
    if (show) {
      console.log(`\n     ---- OUR DRAFT ----\n${(r.body_text as string).split("\n").map((l) => "     " + l).join("\n")}`);
      console.log(`\n     ---- WHAT THEY SENT ----\n${sentText.split("\n").slice(0, 24).map((l) => "     " + l).join("\n")}\n`);
    }
  }

  console.log(`\n${"-".repeat(84)}`);
  console.log(`  sent ours (>=65% our wording): ${tally.sentOurs}`);
  console.log(`  edited    (35-64%):            ${tally.edited}`);
  console.log(`  own words (<35%):              ${tally.ownWords}`);
  console.log(`  nothing sent after the call:   ${tally.nothingSent}`);
  console.log(`  could not check:               ${tally.cannotTell}`);
  console.log(`\n  Matched on time and recipient, not on the draft id, so a rep who ignored our`);
  console.log(`  draft and wrote something similar is indistinguishable from one who sent ours.`);
  console.log(`  Persisting the Graph draft id at creation is what makes this exact.`);
  console.log(`${"-".repeat(84)}\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
