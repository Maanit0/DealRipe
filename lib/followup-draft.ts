/**
 * Post-call follow-up email, drafted into the rep's own Outlook drafts.
 *
 * Never sent. The app holds Mail.ReadWrite and deliberately not Mail.Send, so
 * the rep reads, edits and sends. Both pilot reps asked for exactly this:
 * Eduardo said "I don't want it to be sent automatically, I just want it
 * prepared for me."
 *
 * Three design decisions worth stating, because they are what separate a draft
 * a rep sends from one they rewrite:
 *
 * 1. REPLY, not a new email. A follow-up belongs on the thread the customer is
 *    already reading. We locate that thread from the rep's mailbox and use
 *    Graph's createReply, so quoting and recipients come from Outlook itself.
 *
 * 2. ONE DATED ASK. The failure mode in real recap emails is documentation
 *    with no move. Eduardo's own sample had six open items, five of them owned
 *    by Magaya, and not a single date. A recap that asks for nothing does not
 *    advance a deal, so the draft always ends on one specific, dated request.
 *
 * 3. VOICE FROM THE REP, STRUCTURE FROM THE DEAL. Tone is copied from how this
 *    rep actually writes (their recent sent mail). What the email has to
 *    achieve comes from the call and the open qualification gaps, never from
 *    the rep's habits, so we do not scale one rep's ceiling to the team.
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { createReplyDraft, createDraft, domainOf, listMailboxMessages, type MailMessage } from "./graph-mail";
import type { PostCallSummary } from "./post-call-summary";

const GRAPH_TENANT = "magaya.com";
/** How far back to look for the live thread with this customer. */
const THREAD_LOOKBACK_DAYS = 120;
/** How many of the rep's own sent messages to learn voice from. */
const VOICE_SAMPLES = 6;

export type FollowUpDraftInput = {
  /** The rep's mailbox. Must be on GRAPH_MAIL_ALLOWED_MAILBOXES. */
  mailbox: string;
  /** Customer domains for this deal, used to find the thread. */
  customerDomains: string[];
  /**
   * Customer addresses from the call, used as recipients ONLY when no thread
   * exists to reply to. On a reply Graph supplies recipients from the thread,
   * which is more reliable than anything we could reconstruct.
   */
  customerEmails?: string[];
  account: string;
  summary: PostCallSummary;
  /** Attendees on the call, so the draft addresses real people. */
  attendees?: string;
  /** ISO date of the call. */
  callDate?: string | null;
};

export type FollowUpDraft = {
  subject: string;
  body: string;
  /** The thread this replies to, when one was found. */
  replyToMessageId: string | null;
  /** Recipients, only used when there is no thread to reply to. */
  to: string[];
  /** Files the rep should attach. We name them; Graph drafts carry no files. */
  attachmentsToAdd: string[];
};

// ====================================================================
// Thread + voice discovery
// ====================================================================

/**
 * The newest message on the liveliest thread with this customer.
 *
 * "Liveliest" rather than "newest message" because a stray one-off email should
 * not beat the thread the deal is actually being run on. Replying into the
 * wrong thread is worse than starting a new one, so we require at least one
 * inbound message: a thread the customer has never replied to is not a
 * conversation, it is a broadcast.
 */
export async function findCustomerThread(
  mailbox: string,
  customerDomains: string[],
): Promise<MailMessage | null> {
  if (customerDomains.length === 0) return null;
  const msgs = await listMailboxMessages({
    tenantIdOrDomain: GRAPH_TENANT,
    mailbox,
    since: new Date(Date.now() - THREAD_LOOKBACK_DAYS * 86_400_000),
    domains: customerDomains,
  });
  if (msgs.length === 0) return null;

  const byThread = new Map<string, MailMessage[]>();
  for (const m of msgs) {
    if (!m.conversationId) continue;
    const list = byThread.get(m.conversationId);
    if (list) list.push(m);
    else byThread.set(m.conversationId, [m]);
  }

  let best: { newest: MailMessage; score: number } | null = null;
  for (const thread of byThread.values()) {
    if (!thread.some((m) => !m.outbound)) continue; // customer never engaged
    const ordered = thread
      .filter((m) => m.at)
      .sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!));
    if (ordered.length === 0) continue;
    const newest = ordered[0];
    const ageDays = (Date.now() - Date.parse(newest.at!)) / 86_400_000;
    // Recency dominates; depth breaks ties between equally recent threads.
    const score = thread.length - ageDays;
    if (!best || score > best.score) best = { newest, score };
  }
  return best?.newest ?? null;
}

/** The rep's own recent sent messages, for tone. Subjects and previews only. */
export async function voiceSamples(mailbox: string): Promise<string[]> {
  const msgs = await listMailboxMessages({
    tenantIdOrDomain: GRAPH_TENANT,
    mailbox,
    since: new Date(Date.now() - 90 * 86_400_000),
  });
  return msgs
    .filter((m) => m.outbound && m.preview.length > 80)
    .slice(0, VOICE_SAMPLES)
    .map((m) => `Subject: ${m.subject}\n${m.preview}`);
}

// ====================================================================
// Generation
// ====================================================================

const SYSTEM = `You draft the follow-up email a B2B sales rep sends right after a customer call. The rep reads and sends it themselves, so it must sound like them, not like a tool.

Non-negotiable rules:

1. ONE ask, and it carries a specific date. A recap that requests nothing does not move a deal. Name the date explicitly ("Thursday the 14th"), never "soon" or "next week" alone.
2. Write about THEM. Lead with what the customer said they need, in their words. Do not open with "thank you for your time" and do not list what your company will do before acknowledging what they said.
3. Short. Under 180 words. A rep will not send an essay and a buyer will not read one.
4. No em-dashes, ever. Use commas or full stops. Em-dashes read as AI-written to this customer.
5. No marketing language, no adjectives about your own product, no "excited to", no "circling back", no "just following up".
6. If a gate is genuinely open (no budget confirmed, economic buyer absent, no next meeting), work ONE of them into the ask naturally as a question. Never list gaps at the customer.
7. Match the sample voice for greeting, sign-off, sentence length and formality. If the samples are terse, be terse.

Return JSON only:
{"subject": string, "body": string, "attachmentsToAdd": string[]}

"subject" is used only when there is no thread to reply to.
"attachmentsToAdd" names files the rep promised on the call (a datasheet, an NDA, a proposal). Name them plainly; you cannot attach anything, the rep will.`;

function buildUserMessage(input: FollowUpDraftInput, samples: string[], hasThread: boolean): string {
  const s = input.summary;
  const open = s.stillOpen.slice(0, 4).map((f) => `- ${f.label ?? f.fieldKey}`).join("\n");
  const today = new Date().toISOString().slice(0, 10);
  return [
    `TODAY: ${today}`,
    `CUSTOMER: ${input.account}`,
    input.attendees ? `ON THE CALL: ${input.attendees}` : "",
    input.callDate ? `CALL DATE: ${input.callDate}` : "",
    hasThread
      ? `THIS IS A REPLY on an existing thread. Do not re-introduce yourself and do not restate context they already have.`
      : `THERE IS NO EXISTING THREAD. Write a fresh email and include a subject.`,
    ``,
    `WHAT WAS SAID ON THE CALL:`,
    s.recap,
    ``,
    s.nextStepCommitment
      ? `THE COMMITMENT ALREADY AGREED (build the dated ask around this, do not invent a different one):\n${s.nextStepCommitment}`
      : `NO COMMITMENT WAS AGREED ON THE CALL. The ask should secure one.`,
    s.followUpMeetingExpected && s.noFollowupBooked
      ? `\nA next meeting was implied but NOTHING IS ON THE CALENDAR. Proposing a specific date is the highest-value ask available.`
      : "",
    s.nda?.demoIsNext && !s.nda.ndaInPlace
      ? `\nA demo is next and no NDA is in place. Magaya requires one before a demo.`
      : "",
    open ? `\nQUALIFICATION GAPS STILL OPEN (work at most ONE in as a question, never list them):\n${open}` : "",
    ``,
    samples.length > 0
      ? `HOW THIS REP WRITES. Copy the voice, not the content:\n\n${samples.join("\n\n---\n\n")}`
      : `No writing samples available. Use plain, direct business English and keep it short.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function parseJson(text: string): { subject: string; body: string; attachmentsToAdd: string[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const o = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof o.body !== "string" || !o.body.trim()) return null;
    return {
      subject: typeof o.subject === "string" ? o.subject : "",
      // Belt and braces on the em-dash rule: the customer flags them as AI.
      body: o.body.replace(/\s*[—–]\s*/g, ", "),
      attachmentsToAdd: Array.isArray(o.attachmentsToAdd)
        ? o.attachmentsToAdd.filter((a): a is string => typeof a === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/** Compose the draft. Does not touch the mailbox; see createFollowUpDraft. */
export async function generateFollowUpDraft(
  input: FollowUpDraftInput,
): Promise<FollowUpDraft | null> {
  const [thread, samples] = await Promise.all([
    findCustomerThread(input.mailbox, input.customerDomains),
    voiceSamples(input.mailbox).catch(() => [] as string[]),
  ]);

  const resp = await getAnthropicClient().messages.create({
    model: getAnthropicModel(),
    max_tokens: 1200,
    temperature: 0.3, // a shade of variation so it reads human, not templated
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserMessage(input, samples, Boolean(thread)) }],
  });
  const block = resp.content.find((b) => b.type === "text");
  const parsed = parseJson(block && "text" in block ? block.text : "");
  if (!parsed) return null;

  // On a reply, Graph fills recipients from the thread. Only a fresh draft
  // needs them, and then only customer-side addresses.
  const to = thread
    ? []
    : [...new Set((input.customerEmails ?? []).map((e) => e.toLowerCase().trim()))].filter(
        (e) => e.includes("@") && domainOf(e) !== "magaya.com",
      );

  return {
    subject: parsed.subject || `Following up on our call, ${input.account}`,
    body: parsed.body,
    replyToMessageId: thread?.id ?? null,
    to,
    attachmentsToAdd: parsed.attachmentsToAdd,
  };
}

/** Generate AND write the draft into the rep's Drafts folder. Never sends. */
export async function createFollowUpDraft(
  input: FollowUpDraftInput,
): Promise<{ created: boolean; draft: FollowUpDraft | null; webLink?: string | null; reason?: string }> {
  const draft = await generateFollowUpDraft(input);
  if (!draft) return { created: false, draft: null, reason: "generation returned nothing" };

  try {
    const res = draft.replyToMessageId
      ? await createReplyDraft({
          tenantIdOrDomain: GRAPH_TENANT,
          mailbox: input.mailbox,
          messageId: draft.replyToMessageId,
          body: draft.body,
        })
      : await createDraft({
          tenantIdOrDomain: GRAPH_TENANT,
          mailbox: input.mailbox,
          subject: draft.subject,
          body: draft.body,
          to: draft.to.map((email) => ({ email })),
        });
    return { created: true, draft, webLink: res.webLink };
  } catch (e) {
    return { created: false, draft, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Deal domains for thread lookup, excluding anything internal. */
export function customerDomainsFor(emails: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const e of emails) {
    const d = domainOf(e);
    if (d && d !== "magaya.com") out.add(d);
  }
  return [...out];
}
