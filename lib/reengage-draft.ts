/**
 * A follow-up drafted because a FLAG fired, not because a call happened.
 *
 * WHY THIS IS A DIFFERENT MODULE FROM followup-draft.ts
 *
 * Everything DealRipe drafts today is triggered by an event: a call ended, a
 * meeting was a no-show. That covers the moment after a conversation and
 * nothing else, so a deal that quietly stops moving in week three of a
 * three-month cycle gets nothing, which is precisely when a rep most needs the
 * nudge. Magaya's dominant recorded loss reason is No Decision / Non-Responsive.
 *
 * THE TRIGGER IS SILENCE, AND SILENCE HAS NO EVENT.
 *
 * This is the whole architectural point and it is worth stating plainly,
 * because the obvious competitor design cannot reach it. An agent that watches
 * an inbox drafts a reply when a message lands. Nothing landing produces no
 * message, no webhook and no event, so an inbox-reactive system is structurally
 * blind to the case that matters most. The trigger here is computeDealFlags
 * over the whole book on a schedule, which fires on the ABSENCE of things.
 *
 * WHAT MAKES A DRAFT WORTH SENDING RATHER THAN REWRITING
 *
 * Specificity, and it is the only thing that separates this from a mail-merge
 * "just checking in". The draft is built from what was actually said on the
 * last call, the qualification gate that is still open, and the thing the
 * customer themselves said they were waiting on. DealRipe holds all three; a
 * tool reading only the mailbox holds none of them.
 *
 * WHAT IT NEVER DOES
 *
 *   Sends. The app holds Mail.ReadWrite and deliberately NOT Mail.Send, so this
 *   cannot send even if it were asked to. Eduardo: "I don't want it to be sent
 *   automatically, I just want it prepared for me."
 *
 *   Draft twice for the same reason. A rep who finds the same re-engagement
 *   email in their drafts every morning stops reading drafts, so one flag on
 *   one deal produces one draft per REDRAFT_COOLDOWN_DAYS.
 *
 *   Write for a deal whose customer never replied to anything. Re-engaging a
 *   thread that was always one-way is a cold email, not a re-engagement, and it
 *   should be a rep's deliberate choice.
 */

import { draftArchiveHtml } from "./draft-archive";
import { appendRepSignature, voiceSamples } from "./followup-draft";
import { pickRecipient, type Roster } from "./reengage-recipients";
import { computeDealFlags, type Flag } from "./deal-flags";
import { readCustomerStanding, type CustomerStanding } from "./salesforce-context";
import { assessDeal, computeBuyerSignals, type BuyerSignals } from "./deal-signals-buyer";
import { allowedMailboxes, createDraft, createReplyDraft, domainOf } from "./graph-mail";
import { findCustomerThread } from "./followup-draft";
import { runModel } from "./model-run";
import { ledgerError, recordPrescriptions } from "./prescription-ledger";
import { recordSentMessage } from "./sent-messages";
import { supabaseAdmin } from "./supabase";

const GRAPH_TENANT = "magaya.com";

/**
 * How long before the same flag on the same deal may draft again.
 *
 * Ten days rather than a week, because a rep who sends the draft is likely
 * waiting on a reply for several days after, and a second draft landing while
 * the first is still out is worse than none.
 */
const REDRAFT_COOLDOWN_DAYS = 10;

/**
 * Flags that justify writing to a customer, in the order they win when a deal
 * carries several.
 *
 * ONE FLAG, ONE DRAFT. An email built to address three flags asks for three
 * things and gets none of them, which is the failure the post-call draft
 * already learned: Eduardo's own sample recap had six open items, five owned by
 * Magaya, and not one date.
 *
 * Deliberately NOT here: `commit_without_economic_buyer`,
 * `close_date_repeatedly_pushed` and the band-versus-evidence flags. Those are
 * arguments to have with the REP, and mailing the customer about our own
 * forecast hygiene is the "an ask may never cite our CRM state" rule.
 */
const DRAFTABLE: ReadonlyArray<{ id: string; goal: string }> = [
  {
    id: "losing_momentum",
    goal:
      "re-open the conversation. They have gone quiet after real engagement, so give them a reason to " +
      "reply that is about their problem rather than about our process.",
  },
  {
    id: "emailing_without_reply",
    goal:
      "change something. They have not answered the last message or two on this thread, so do not send " +
      "a third of the same kind: change the channel, the person, or what is being asked for.",
  },
  {
    id: "invited_but_silent",
    goal:
      "reach the person who was in the room and did not speak. Ask them something only they can answer.",
  },
];

export type ReengageDraft = {
  dealId: string;
  account: string;
  mailbox: string;
  flag: Flag;
  subject: string;
  body: string;
  to: string[];
  replyToMessageId: string | null;
  /**
   * The last captured call, which this draft is grounded in and which the
   * silence is measured from.
   *
   * Null when the deal has no captured call. That deal gets no ledger row,
   * which is correct rather than a limitation: a prescription with no call
   * cannot be scored, and there would be nothing to ground the draft in
   * either.
   */
  groundedInCallId: string | null;
};

export type ReengageOutcome =
  | { status: "drafted"; draft: ReengageDraft; webLink?: string | null }
  | { status: "would_draft"; draft: ReengageDraft }
  /** Every one of these is a REASON, never a silent skip. */
  | { status: "skipped"; account: string; why: string }
  | { status: "failed"; account: string; why: string };

function daysAgo(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86_400_000) : null;
}

/**
 * The one flag to write about, or null.
 *
 * Severity is not the tiebreaker: DRAFTABLE's own order is, because "they went
 * quiet" and "they stopped answering" want different emails and the first is
 * the better opener when both are true.
 */
function chooseFlag(flags: Flag[]): { flag: Flag; goal: string } | null {
  for (const d of DRAFTABLE) {
    const hit = flags.find((f) => f.id === d.id);
    if (hit) return { flag: hit, goal: d.goal };
  }
  return null;
}

const SYSTEM = `You write one short re-engagement email for a B2B software rep at Magaya, which sells logistics software (customs filing, freight forwarding, warehouse management).

The rep sends this themselves after reading it, so write in first person as the rep.

RULES, and each one exists because breaking it produced an email a rep rewrote:

- Ground every sentence in what was actually said on the calls. Reference a specific thing THEY said they cared about or were waiting on. A message that could have been sent to any account is worse than no message.
- Never mention our CRM, our forecast, our qualification framework, a stage, or a gap. The customer does not know those exist and does not care.
- Do not apologise for the gap in contact, do not say "just checking in", "circling back", "touching base", or "I wanted to follow up".
- LEAD WITH SOMETHING FROM OUR SIDE, then ask. If WHAT WE STILL OWE THEM is present below, open with the one item most worth reporting on and say where it stands. An email that brings news earns a reply; an email that requests a status update asks the customer to do our work.
- NEVER ask whether the project is still active, still on their radar, still moving, or has been tabled. It hands them a clean exit and it is the exact wording of the two attempts in this pilot that got no answer. Assume it is live and write as though it is.
- Exactly ONE ask, and it is specific. A question they can answer in one line, or a concrete offer. Not "let me know if you have questions". Where you can, shrink the cost of saying yes to a number: "15 to 20 minutes" beats "a quick call".
- No em-dashes and no en-dashes anywhere. Use commas or start a new sentence.
- Six sentences maximum, and shorter is better. This is read on a phone.
- Open with a greeting on its own line, the way the rep writes it: "Hi Carrie," or "Yaremi," followed by a blank line. Address the ONE person the message is for, even when others are copied.
- No subject line in the body, and no sign-off or signature. DealRipe appends the rep's own measured signature after you. (This used to say Outlook appends it. Outlook does not append a signature to a draft created through the API, so every re-engagement went out unsigned.)
- Do not restate your own ask as a noun phrase, and never count it. "That one answer would help me" is "That would help me". Also out: "just that one thing", "even a quick reply", "it would mean a lot". Asking for something and then narrating how valuable it is to you is a sales move; the rep asks and stops.

Return JSON only: {"subject": "...", "body": "..."}
The subject is ignored when this replies to an existing thread, so write it as though it were a fresh email either way.`;

async function lastCallContext(
  tenantId: string,
  dealId: string,
): Promise<{ callId: string; when: string | null; summary: string } | null> {
  const db = supabaseAdmin();
  const call = await db
    .from("calls")
    .select("id, scheduled_start, call_date, title")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId)
    .eq("outcome", "captured")
    .order("scheduled_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (call.error || !call.data) return null;
  const c = call.data as { id: string; scheduled_start: string | null; call_date: string | null; title: string | null };

  // The EXTRACTION rather than the transcript. It is already the distilled
  // answer set, it is a fraction of the tokens, and it carries the customer's
  // own words in `evidence`, which is exactly what makes a draft specific.
  const fx = await db
    .from("field_extractions")
    .select("framework_field_key, status, answer, evidence")
    .eq("deal_id", dealId)
    .eq("status", "Yes")
    .limit(14);
  const lines = ((fx.data ?? []) as Array<{ framework_field_key: string; answer: string | null; evidence: string | null }>)
    .filter((r) => r.answer)
    .map((r) => `- ${r.framework_field_key}: ${r.answer}${r.evidence ? ` (they said: "${String(r.evidence).slice(0, 220)}")` : ""}`);

  // THE RECAP NARRATIVE, alongside the extraction rather than instead of it.
  //
  // The extraction is the framework's answer set, so it holds what the
  // qualification asks about and nothing else. The narrative pass is written in
  // the customer's own words with no framework vocabulary, which is where the
  // offhand detail, the objection as they phrased it and the personal thing
  // live. Those are what make a re-engagement sound like the rep wrote it.
  //
  // The stored recap opens with a copy of the follow-up draft, so only the
  // WHAT HAPPENED section is taken. A recap that does not carry that heading
  // contributes nothing rather than a slice of the wrong thing.
  const narrative = await recapNarrative(c.id);
  // WHAT THE REP PROMISED AND HAS NOT DELIVERED.
  //
  // The one re-engagement in this pilot that got a reply inside two days was
  // Juan reporting on work he had done: "I have been in discussions with my
  // implementation team and have some resources lined up and reserved for you."
  // He invented no news. He reported on a commitment he had already made.
  //
  // Those commitments are already written down, as the bullets in the follow-up
  // email the rep sent after the call, so this needs no roadmap feed and no
  // implementation calendar. It also cannot hallucinate an offer, because every
  // line is something the rep said out loud on a recorded call.
  const owed = await openCommitments(c.id);

  return {
    callId: c.id,
    when: c.scheduled_start ?? c.call_date,
    summary: [
      c.title ? `Meeting: ${c.title}` : null,
      narrative ? `How the call actually went:\n${narrative}` : null,
      owed ? `WHAT WE STILL OWE THEM, from the follow-up the rep sent after that call:\n${owed}` : null,
      lines.length > 0 ? `What was established:` : null,
      ...lines,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * The commitment bullets from the follow-up draft the rep sent after the call.
 *
 * The stored recap opens with a copy of that draft, and its bullet list is the
 * "here is what we will do" block. Only lines that read as an obligation are
 * kept: a bullet describing what the CUSTOMER will do is not something we can
 * report progress on, and offering it back to them is worse than saying
 * nothing.
 */
async function openCommitments(callId: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from("sent_messages")
    .select("body_text")
    .eq("call_id", callId)
    .eq("kind", "recap")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const text = (data as { body_text?: string | null } | null)?.body_text;
  if (!text) return null;
  // Stop at the recap proper; past that the bullets are extracted fields, not
  // promises.
  const head = text.split(/\n-{6,}\n/)[0] ?? text;
  const bullets = head
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*\u2022]\s+/.test(l))
    .map((l) => l.replace(/^[-*\u2022]\s+/, ""))
    // Ours, not theirs. "I am looking into", "Steven is checking", "we are
    // flagging" are reportable; "Debra will send the org chart" is not.
    .filter((l) => !/^(they|the customer|[A-Z][a-z]+ (will|is going to) (send|share|provide|get back))/i.test(l))
    .slice(0, 6);
  return bullets.length > 0 ? bullets.map((b) => `- ${b}`).join("\n") : null;
}

/** The WHAT HAPPENED section of the last recap for this call, or null. */
async function recapNarrative(callId: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from("sent_messages")
    .select("body_text")
    .eq("call_id", callId)
    .eq("kind", "recap")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const text = (data as { body_text?: string | null } | null)?.body_text;
  if (!text) return null;
  const start = text.indexOf("WHAT HAPPENED");
  if (start < 0) return null;
  const rest = text.slice(start + "WHAT HAPPENED".length);
  // Ends at the next all-caps heading, which is CAPTURED ON THIS CALL today and
  // must not be assumed: anything matching the heading shape closes the block.
  const end = rest.search(/\n[A-Z][A-Z '&-]{6,}\n/);
  const body = (end < 0 ? rest : rest.slice(0, end)).trim();
  return body.length > 40 ? body.slice(0, 1800) : null;
}

/**
 * Build one re-engagement draft for one deal. Writes nothing.
 *
 * `signals` and `flags` are passed in rather than recomputed so a caller
 * sweeping the whole book pays for them once, and so a caller can draft from a
 * read it has already shown a human.
 */
export async function generateReengageDraft(args: {
  tenantId: string;
  dealId: string;
  account: string;
  mailbox: string;
  customerEmails: string[];
  /**
   * The candidate recipients split by whether they have ever replied.
   *
   * Optional so a caller that has not built one still works, and then the mail
   * falls back to the whole roster exactly as it did before rather than
   * silently going nowhere.
   */
  roster?: Roster;
  signals: BuyerSignals;
  flags: Flag[];
  /**
   * The Salesforce account, so we can find out whether this is a CUSTOMER
   * before writing to them like a prospect.
   *
   * Added 2026-08-25. Five deals awaiting a reply resolve to `only_historical`,
   * meaning every closed opportunity on the account predates our first call.
   * Best closed WON on 2026-06-30. Without this they get "are you still looking
   * to get that demo and pricing in front of you" sent to someone who already
   * bought, which is the Cargoservicesgroup error with a stamp on it.
   */
  salesforceAccountId?: string | null;
}): Promise<ReengageDraft | null> {
  const chosen = chooseFlag(args.flags);
  if (!chosen) return null;

  const ctx = await lastCallContext(args.tenantId, args.dealId);
  const domains = [...new Set(args.customerEmails.map((e) => domainOf(e)).filter((d): d is string => !!d))];
  const thread = await findCustomerThread(args.mailbox, domains).catch(() => null);

  const quiet =
    args.signals.daysSinceLastCall.status === "read" ? args.signals.daysSinceLastCall.value : null;

  // Customer or prospect. Fails OPEN: an unavailable read must never turn a
  // customer into a prospect, and it must never turn a prospect into a customer
  // either, so an unknown standing simply adds no instruction.
  let standing: CustomerStanding | null = null;
  if (args.salesforceAccountId) {
    standing = await readCustomerStanding(args.salesforceAccountId).catch(() => null);
  }
  const standingLines: string[] =
    standing?.status === "customer"
      ? [
          ``,
          `THIS ACCOUNT IS ALREADY A MAGAYA CUSTOMER${standing.since ? `, since ${standing.since.slice(0, 10)}` : ""}${standing.implementation ? `, implementation status "${standing.implementation}"` : ""}.`,
          `Do NOT write to them as a prospect. Never ask what is driving them to look at a new solution, never offer to "get a demo and pricing in front of you", and never reintroduce Magaya.`,
          `They bought already. Write about the thing that is actually open: the expansion, the module, the renewal, or whatever the calls say this conversation is about.`,
        ]
      : [];

  const prompt = [
    `Account: ${args.account}`,
    ctx?.when ? `Last call: ${ctx.when.slice(0, 10)}${quiet !== null ? `, ${quiet} days ago` : ""}` : "No captured call.",
    ``,
    `WHY YOU ARE WRITING: ${chosen.flag.title}.`,
    `The evidence: ${chosen.flag.evidence}`,
    `Your goal: ${chosen.goal}`,
    ...standingLines,
    ``,
    `WHAT THE CALLS ESTABLISHED, in their words where we have them:`,
    ctx?.summary || "(nothing captured)",
    ``,
    thread
      ? `This will reply on an existing thread, subject "${thread.subject ?? "(none)"}". Write it as a reply: no reintroduction.`
      : `There is no live thread, so this is a fresh email.`,
  ].join("\n");

  const res = await runModel({
    task: "reengage_draft",
    tenantId: args.tenantId,
    dealId: args.dealId,
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 900,
  });

  let parsed: { subject?: string; body?: string };
  try {
    const m = res.text.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  } catch {
    return null;
  }
  if (!parsed.body || parsed.body.trim().length < 40) return null;

  // The dash rule is enforced, never trusted. lib/briefing-lint.ts calls this
  // an auto-fix rather than a regeneration for exactly this reason: the
  // substitution is exact and lossless, and regenerating over one character is
  // absurd.
  const dedash = (s: string) => s.replace(/\s*[—–]\s*/g, ", ");

  return {
    dealId: args.dealId,
    account: args.account,
    mailbox: args.mailbox,
    flag: chosen.flag,
    subject: dedash(parsed.subject ?? `${args.account}`),
    // SIGNED THE SAME WAY A FOLLOW-UP IS, through the one shared function.
    // These reached reps ending on the last sentence with no name attached,
    // because the prompt asserted Outlook would add one and nothing checked.
    body: appendRepSignature(dedash(parsed.body).trim(), args.mailbox, await voiceSamples(args.mailbox)),
    // ONE PERSON. The model addresses a single human in its first line and the
    // To line used to carry the whole call roster, so IFF Inc's "rather than
    // working through you as the go-between" was drafted to ten colleagues.
    // The rest are DROPPED, not cc'd.
    to: (() => {
      const one = args.roster ? pickRecipient(args.roster, chosen.flag.id) : null;
      return one ? [one] : args.customerEmails;
    })(),
    replyToMessageId: thread?.id ?? null,
    groundedInCallId: ctx?.callId ?? null,
  };
}

/** Has this deal already been drafted for this flag inside the cooldown? */
export async function recentlyDrafted(dealId: string, flagId: string): Promise<boolean> {
  const since = new Date(Date.now() - REDRAFT_COOLDOWN_DAYS * 86_400_000).toISOString();
  const res = await supabaseAdmin()
    .from("sent_messages")
    .select("id, subject")
    .eq("deal_id", dealId)
    .eq("kind", "reengage_draft")
    .gte("sent_at", since);
  if (res.error) {
    // Fail CLOSED. Not knowing whether we already drafted is a reason not to
    // draft again, because the cost of a duplicate in a rep's inbox is that
    // they stop reading drafts at all.
    console.warn(`[reengage-draft] dedupe read failed for ${dealId}: ${res.error.message}`);
    return true;
  }
  return (res.data ?? []).some((r) => String((r as { subject: string }).subject ?? "").includes(`[${flagId}]`));
}

/**
 * Put the draft in the rep's Drafts folder.
 *
 * Replies onto the live thread when there is one, and falls back to a fresh
 * message when Graph refuses, which it does for a meeting request. That exact
 * failure silently cost two reps their follow-ups on 2026-08-11.
 */
export async function createReengageDraft(
  draft: ReengageDraft,
  opts: { apply: boolean } = { apply: false },
): Promise<ReengageOutcome> {
  if (!allowedMailboxes().includes(draft.mailbox.toLowerCase())) {
    return { status: "skipped", account: draft.account, why: `${draft.mailbox} is not an allowed mailbox` };
  }
  if (!opts.apply) return { status: "would_draft", draft };

  const fresh = () =>
    createDraft({
      tenantIdOrDomain: GRAPH_TENANT,
      mailbox: draft.mailbox,
      subject: draft.subject,
      body: draft.body,
      to: draft.to.map((email) => ({ email })),
    });

  let webLink: string | null | undefined;
  try {
    if (draft.replyToMessageId) {
      try {
        const r = await createReplyDraft({
          tenantIdOrDomain: GRAPH_TENANT,
          mailbox: draft.mailbox,
          messageId: draft.replyToMessageId,
          body: draft.body,
          toRecipients: draft.to,
        });
        webLink = r.webLink;
      } catch (replyErr) {
        console.warn(
          `[reengage-draft] reply failed for ${draft.account}, writing a new message: ` +
            `${replyErr instanceof Error ? replyErr.message : String(replyErr)}`,
        );
        webLink = (await fresh()).webLink;
      }
    } else {
      webLink = (await fresh()).webLink;
    }
  } catch (err) {
    return { status: "failed", account: draft.account, why: err instanceof Error ? err.message : String(err) };
  }

  const tenantId = (
    await supabaseAdmin().from("deals").select("tenant_id").eq("id", draft.dealId).maybeSingle()
  ).data?.tenant_id as string;

  // THE LEDGER ROW IS THE POINT, not the email.
  //
  // prescribed_actions is the action-outcome dataset, and until now every row
  // in it was triggered by a call. This is the first instruction DealRipe
  // issues because something did NOT happen, which is a kind of row no
  // call-triggered system can produce. Recording it anywhere else would split
  // the asset in two.
  //
  // The text is the flag's MOVE, not the email body: the ledger records what
  // the rep was told to do, and the draft is the help we gave them doing it.
  if (draft.groundedInCallId) {
    const led = await recordPrescriptions({
      tenantId,
      dealId: draft.dealId,
      callId: draft.groundedInCallId,
      source: "reengage",
      issuedAt: new Date().toISOString(),
      prescriptions: [
        { kind: "next_step", text: draft.flag.move, frameworkFieldKeys: null },
      ],
    });
    if (led.status === "unavailable") {
      console.warn(`[reengage-draft] ledger write failed for ${draft.account}: ${ledgerError(led.error)}`);
    }
  }

  // The flag id rides in the archived subject because that is what
  // recentlyDrafted matches on: the cooldown is per flag, not per deal, so a
  // deal that goes quiet and later loses its thread can be drafted for both.
  await recordSentMessage({
    tenantId,
    dealId: draft.dealId,
    kind: "reengage_draft",
    toEmail: draft.to.join(", "),
    subject: `[${draft.flag.id}] ${draft.subject}`,
    // REAL HTML, not an empty string. The Activity log renders body_html in the
    // expandable detail, so `html: ""` produced seven rows on 2026-08-31 that
    // named a customer and their addresses and could not be opened. The
    // follow-up path learned this and this one did not, which is why the
    // renderer now lives in one file both call.
    html: draftArchiveHtml({
      to: draft.to,
      body: draft.body,
      replyToMessageId: draft.replyToMessageId,
      // The flag is the whole reason this draft exists. Without it the reader
      // cannot tell a deliberate sweep from a stray send to a customer.
      reason: { title: draft.flag.title, evidence: draft.flag.evidence },
    }),
    text: draft.body,
  }).catch((e) => {
    // The draft is in the rep's mailbox either way. Losing the archive costs
    // the cooldown, not the email, so it must not fail the run.
    console.warn(`[reengage-draft] archive failed for ${draft.account}: ${e instanceof Error ? e.message : String(e)}`);
  });

  return { status: "drafted", draft, webLink };
}

/** Recompute signals and flags for a deal, for a caller that has neither. */
export async function flagsForDeal(tenantId: string, dealId: string): Promise<{ signals: BuyerSignals; flags: Flag[] }> {
  const signals = await computeBuyerSignals({ tenantId, dealId });
  const assessment = assessDeal(signals);
  return { signals, flags: computeDealFlags({ signals, assessment }) };
}

export { DRAFTABLE, REDRAFT_COOLDOWN_DAYS, daysAgo };
