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
import { repName } from "./display-names";
import { listMeetingsBetween } from "./microsoft-graph";
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
  /** microsoft_connections id for the rep, so times come from their calendar. */
  calendarConnectionId?: string | null;
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

// ====================================================================
// Meeting slots (real availability, not invented)
// ====================================================================

const SLOT_START_HOUR_ET = 9;
const SLOT_END_HOUR_ET = 16; // last start, so a 45-min call ends inside the day
const SLOT_LEAD_DAYS = 3; // never propose tomorrow; give the customer room
const SLOT_HORIZON_DAYS = 12;
const MEETING_MINUTES = 45;

export type ProposedSlot = { startsAt: Date; label: string };

/**
 * An already-booked meeting with this customer, if there is one.
 *
 * Asking a customer to book a call they have already booked is the single most
 * embarrassing thing this feature can do. It was Juan's first reaction to his
 * first draft: "I thought I already agreed to a time with him." We have the
 * calendar, so there is no excuse for guessing.
 */
export async function existingMeetingWith(
  connectionId: string,
  customerDomains: string[],
  timeZone = "America/New_York",
): Promise<{ label: string; subject: string | null } | null> {
  if (customerDomains.length === 0) return null;
  const wanted = new Set(customerDomains.map((d) => d.toLowerCase()));
  try {
    const events = await listMeetingsBetween(
      connectionId,
      new Date(),
      new Date(Date.now() + SLOT_HORIZON_DAYS * 86_400_000),
    );
    for (const e of events) {
      if (e.isCancelled || !e.start) continue;
      const involved = e.attendees.some((a) => wanted.has(domainOf(a.email) ?? ""));
      if (!involved) continue;
      const iso = e.start.dateTime.endsWith("Z") ? e.start.dateTime : `${e.start.dateTime}Z`;
      const at = new Date(Date.parse(iso));
      if (!Number.isFinite(at.getTime())) continue;
      return {
        subject: e.subject,
        label: at.toLocaleString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZone,
        }),
      };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Slots the rep is genuinely free, read from their calendar.
 *
 * The model used to invent a time, which is how Juan got a draft proposing
 * 10:00 and asked "why 10 a.m." A proposed time the rep cannot honour is worse
 * than proposing none: the customer accepts and the rep has to walk it back.
 *
 * Deliberately conservative. Business hours only, never within the next few
 * days, one option per day so the choices span the week rather than clustering,
 * and any overlap at all disqualifies a slot. A boring Tuesday morning that is
 * actually free beats a clever one that collides.
 */
export async function freeSlots(
  connectionId: string,
  opts: { timeZone?: string; count?: number } = {},
): Promise<ProposedSlot[]> {
  const want = opts.count ?? 3;
  const now = Date.now();
  const from = new Date(now + SLOT_LEAD_DAYS * 86_400_000);
  const to = new Date(now + SLOT_HORIZON_DAYS * 86_400_000);

  let busy: Array<{ start: number; end: number }>;
  try {
    const events = await listMeetingsBetween(connectionId, from, to);
    busy = events
      .filter((e) => !e.isCancelled && e.start && e.end)
      .map((e) => ({
        start: Date.parse(e.start!.dateTime.endsWith("Z") ? e.start!.dateTime : `${e.start!.dateTime}Z`),
        end: Date.parse(e.end!.dateTime.endsWith("Z") ? e.end!.dateTime : `${e.end!.dateTime}Z`),
      }))
      .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end));
  } catch {
    // No calendar is a reason to propose nothing, never a reason to guess.
    return [];
  }

  const tz = opts.timeZone ?? "America/New_York";
  const out: ProposedSlot[] = [];
  const day = new Date(from);
  day.setUTCHours(0, 0, 0, 0);

  while (day.getTime() < to.getTime() && out.length < want) {
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      for (let h = SLOT_START_HOUR_ET; h <= SLOT_END_HOUR_ET; h++) {
        const candidate = new Date(day);
        candidate.setUTCHours(h + 4, 0, 0, 0); // ET is UTC-4 through October
        const s = candidate.getTime();
        const e = s + MEETING_MINUTES * 60_000;
        if (s < from.getTime()) continue;
        if (busy.some((b) => s < b.end && e > b.start)) continue;
        out.push({
          startsAt: candidate,
          label: candidate.toLocaleString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZone: tz,
          }),
        });
        break; // one per day, so options span the week
      }
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

/**
 * The rep's own recent sent messages, for tone.
 *
 * CUSTOMER-FACING ONLY. A rep writes very differently to a colleague than to a
 * buyer, and Eduardo in particular is a Sales VP with heavy internal traffic.
 * Sampling the whole sent folder would teach the model his internal register
 * and produce drafts that read like a note to Mark rather than to a customer.
 *
 * Headers and previews only; message bodies are never fetched.
 */
export async function voiceSamples(mailbox: string): Promise<string[]> {
  const msgs = await listMailboxMessages({
    tenantIdOrDomain: GRAPH_TENANT,
    mailbox,
    since: new Date(Date.now() - 90 * 86_400_000),
  });
  const me = domainOf(mailbox);
  const external = msgs.filter((m) => {
    if (!m.outbound || m.preview.length < 80) return false;
    return [...m.to, ...m.cc].some((r) => {
      const d = domainOf(r);
      return Boolean(d) && d !== me && !isFreeMailNoise(d as string);
    });
  });
  // Fall back to any sent mail rather than none: a slightly-off voice beats a
  // generic one, and a new rep may have no customer mail yet.
  const pool = external.length > 0 ? external : msgs.filter((m) => m.outbound && m.preview.length >= 80);
  return pool.slice(0, VOICE_SAMPLES).map((m) => `Subject: ${m.subject}\n${m.preview}`);
}

/**
 * The rep's first name for the sign-off. Deliberately just the name: no title
 * or phone number, because inventing either is worse than omitting both and
 * the rep's full block is already configured in Outlook.
 */
function repFirstName(mailbox: string): string {
  return repName(mailbox);
}

/** Calendar and notification senders that are external but not customers. */
function isFreeMailNoise(domain: string): boolean {
  return /^(calendar|notifications?|noreply|no-reply)\./i.test(domain);
}

// ====================================================================
// Generation
// ====================================================================

const SYSTEM = `You draft the follow-up email a B2B sales rep sends right after a customer call. The rep reads and sends it themselves, so it must sound like them, not like a tool.

Non-negotiable rules:

1. ONE ask, and it carries a specific date. A recap that requests nothing does not move a deal. Name the date explicitly ("Thursday the 14th"), never "soon" or "next week" alone. ONE means one: if you find yourself asking the customer to both confirm something and do something else, fold them into a single request or drop the weaker one. Two questions halve the reply rate.
2. Write about THEM. Lead with what the customer said they need, in their words. Do not open with "thank you for your time" and do not list what your company will do before acknowledging what they said.
3. Short. Under 180 words. A rep will not send an essay and a buyer will not read one.
4. No em-dashes, ever. Use commas or full stops. Em-dashes read as AI-written to this customer.
5. No marketing language, no adjectives about your own product, no "excited to", no "circling back", no "just following up".
6. If a gate is genuinely open (economic buyer absent, no decision process mapped, no next meeting), work ONE of them in as a soft closing question. Never list gaps at the customer.
6a. ASK ABOUT PROCESS, NEVER ABOUT MONEY, in writing. "Is there a formal approval process we should plan around?" is right. "Is there a budget range set?" is wrong: in an email a money question reads as qualifying them rather than helping them, it invites a defensive or evasive answer, and it is the line most likely to get forwarded to procurement. Budget belongs on a call where the rep can read the reaction. Process questions surface the same authority and timing information without the edge, and they give the customer something easy and flattering to answer.
7. Match the sample voice for greeting, sign-off, sentence length and formality. If the samples are terse, be terse.
8. Any proposed time carries a TIMEZONE. "Thursday, August 13th at 10:00 AM ET", never a bare "10:00 AM". These customers span Canada, Latin America, Europe and Asia, and an unqualified time is how a booked meeting turns into a no-show. When the customer's own timezone is given below, state the time in THEIRS, then the rep's in brackets: "10:00 AM ET (9:00 AM CT my time)". Writing a time only in the seller's zone quietly makes the buyer do the conversion.
9. Distinguish what is IN THIS EMAIL from what will be REVIEWED at the meeting. A recording, a datasheet or a video is in this email: write "here's the recording", present tense. A proposal, pricing or an implementation estimate is walked through live, because emailing it ahead removes the reason for the meeting and lets the buyer evaluate it alone. Unless the transcript shows the rep explicitly promising to email a proposal ahead, do NOT say it is coming. Do not lump them together: "the proposal, recording and estimate are on their way" is wrong when only the recording is going now.
10. FORMAT AS SHORT STANDALONE LINES, one thought each, with a blank line between. Never a dense paragraph. A rep reads this on a phone between calls and a wall of text gets rewritten. Roughly: greeting, one line on what is in the email, one line with the dated ask, one optional line with the softer question.
10a. STOP AFTER THE LAST CONTENT LINE. Do NOT write a closing line, a sign-off, a name, a title or a phone number. The rep's signature is appended automatically and is not yours to write. End the body on the final sentence of substance.
11. For anything going out WITH this email, use present tense and stay neutral about the mechanism: "Here's the recording from Friday's session." That stays true once the rep attaches it.
   Do NOT write "please find attached" or "I have attached": nothing is attached when the rep opens the draft, and it reads as a mistake.
   Do NOT write "is on its way", "are on their way" or "I'll send it over" for something included in THIS email either. Those describe a separate, later email and leave the customer waiting for one that never arrives.
   Always name the file in attachmentsToAdd so the rep knows what to attach before sending.

Return JSON only:
{"subject": string, "body": string, "attachmentsToAdd": string[]}

"subject" is used only when there is no thread to reply to.
"attachmentsToAdd" names files the rep promised on the call (a datasheet, an NDA, a proposal). Name them plainly; you cannot attach anything, the rep will.`;

/**
 * True while a demo is plausibly still ahead of this deal.
 *
 * Magaya's stages run SQL0 (awaiting action) through SQL5 (agreement). A demo
 * belongs before proposal validation, so from SQL3 onward the deal has already
 * been demoed and NDA-before-demo is behind it. Unknown stages are treated as
 * pre-demo, since a spurious NDA mention is a smaller error than omitting a
 * required one on an early deal.
 */
function isPreDemoStage(stageKey: string | null | undefined): boolean {
  const m = /sql\s*([0-5])/i.exec(stageKey ?? "");
  if (!m) return true;
  return Number(m[1]) < 3;
}

function buildUserMessage(
  input: FollowUpDraftInput,
  samples: string[],
  hasThread: boolean,
  slots: ProposedSlot[],
  booked: { label: string; subject: string | null } | null,
): string {
  const s = input.summary;
  const open = s.stillOpen.slice(0, 4).map((f) => `- ${f.label ?? f.fieldKey}`).join("\n");
  const today = new Date().toISOString().slice(0, 10);
  return [
    `TODAY: ${today}`,
    `CUSTOMER: ${input.account}`,
    input.attendees ? `ON THE CALL: ${input.attendees}` : "",
    input.callDate ? `CALL DATE: ${input.callDate}` : "",
    s.customerTimezone
      ? `CUSTOMER TIMEZONE (they said so on the call): ${s.customerTimezone}. Propose the time in this zone.`
      : `CUSTOMER TIMEZONE: not stated on the call. Use the rep's zone and label it explicitly.`,
    hasThread
      ? `THIS IS A REPLY on an existing thread. Do not re-introduce yourself and do not restate context they already have.`
      : `THERE IS NO EXISTING THREAD. Write a fresh email and include a subject.`,
    ``,
    `WHAT WAS SAID ON THE CALL:`,
    s.recap,
    ``,
    s.nextStepCommitment
      ? `THE COMMITMENT ALREADY AGREED (build the dated ask around this, do not invent a different one):\n${s.nextStepCommitment}\nCAUTION: this line is a summary of the rep's intent, not a list of what goes in this email. If it names a proposal, pricing or an estimate, those are what the MEETING is for. Rule 9 overrides this wording.`
      : `NO COMMITMENT WAS AGREED ON THE CALL. The ask should secure one.`,
    // Ranked deliberately. A date on the calendar outranks a document or a
    // signature, because the rep's own words are that a booked date is a
    // commitment while an action item is only an intention. This is the ask
    // most likely to be missed, so it is stated first and unambiguously.
    s.shouldBookNextMeeting
      ? `\nNOTHING IS ON THE CALENDAR and this deal should have a date. Propose ONE specific date and time as the ask, even if the immediate step is asynchronous. This outranks asking for a document or a signature; fold those in around it rather than leading with them.`
      : "",
    // Times come from the rep's real calendar. Inventing one produced a draft
    // proposing a slot the rep was not free for, which he immediately spotted.
    // A meeting already on the calendar outranks everything: never ask a
    // customer to book something they have already booked.
    booked
      ? `\nA MEETING WITH THIS CUSTOMER IS ALREADY ON THE CALENDAR: ${booked.label}${booked.subject ? ` ("${booked.subject}")` : ""}.\nDo NOT propose a time and do NOT ask them to book anything. Reference the existing meeting as settled ("ahead of ${booked.label}") and make the ask something else: confirming who will join, or the softer process question.`
      : slots.length > 0
        ? `\nPROPOSE ONE OF THESE EXACT TIMES, copied verbatim. They are confirmed free on the rep's calendar:\n${slots.map((s) => `- ${s.label}`).join("\n")}\nUse the FIRST one unless the transcript gives a reason to prefer another. Never invent a different date or time.`
        : `\nNO CONFIRMED FREE SLOTS ARE AVAILABLE. Do NOT invent a specific time. Ask them to propose one, or offer a named week ("early next week").`,
    s.followUpMeetingExpected && s.noFollowupBooked
      ? `\nA next meeting was agreed on the call and could be booked right now.`
      : "",
    // The recap's NDA signal is deliberately an over-reminder for the REP: it
    // fires whenever a demo sits anywhere in the path. That is wrong to put in
    // front of a CUSTOMER on a deal already past demo, where raising it reads
    // as the rep having lost track of their own deal. Only surface it while a
    // demo is genuinely still ahead.
    s.nda?.demoIsNext && !s.nda.ndaInPlace && isPreDemoStage(s.stageKey)
      ? `\nA demo is still ahead and no NDA is signed. Magaya requires one first, so make the proposed date contingent on it rather than raising the NDA as a separate request.`
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
      // Belt and braces on two rules the model can still slip on.
      // Em-dashes: this customer reads them as AI-written.
      // "Attached": a draft cannot carry files, so a rep who skims and sends
      // would reference a proposal that is not there. Rewrite rather than
      // regenerate, so one slip does not cost a whole generation.
      body: o.body
        .replace(/\s*[—–]\s*/g, ", ")
        // "Attached is X" -> "Here is X". The earlier rewrite sent these to
        // "I am sending over", which implied a separate later email for
        // something that goes in this one. Present tense is the honest form.
        .replace(/\bplease find attached\b/gi, "here is")
        .replace(/\bI have attached\b/gi, "Here is")
        .replace(/\battached (is|are)\b/gi, (_m, v: string) => (v.toLowerCase() === "are" ? "Here are" : "Here is"))
        .replace(/\b(is|are) on (its|their) way to\b/gi, (_m, v: string) => (v.toLowerCase() === "are" ? "are here for" : "is here for")),
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
  const [thread, samples, slots, booked] = await Promise.all([
    findCustomerThread(input.mailbox, input.customerDomains),
    voiceSamples(input.mailbox).catch(() => [] as string[]),
    input.calendarConnectionId
      ? freeSlots(input.calendarConnectionId, { count: 3 }).catch(() => [] as ProposedSlot[])
      : Promise.resolve([] as ProposedSlot[]),
    input.calendarConnectionId
      ? existingMeetingWith(input.calendarConnectionId, input.customerDomains).catch(() => null)
      : Promise.resolve(null),
  ]);

  const resp = await getAnthropicClient().messages.create({
    model: getAnthropicModel(),
    // Generous headroom. A truncated draft is the one failure mode a rep cannot
    // work around: they see an email cut off mid-sentence and stop trusting it.
    max_tokens: 3000,
    temperature: 0.3, // a shade of variation so it reads human, not templated
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserMessage(input, samples, Boolean(thread), slots, booked) }],
  });
  const block = resp.content.find((b) => b.type === "text");
  const raw = block && "text" in block ? block.text : "";
  if (process.env.DRAFT_DEBUG === "1") {
    console.log(`\n----- RAW MODEL OUTPUT (${raw.length} chars) -----\n${raw}\n----- END RAW -----\n`);
  }
  const parsed = parseJson(raw);
  if (!parsed) return null;

  // Reject a body that stops mid-thought. Anthropic's stop_reason tells us when
  // the model ran out of room, and a body not ending in terminal punctuation or
  // a sign-off is the same failure arriving quietly. Returning nothing is right:
  // no draft is recoverable, half a draft in a rep's outbox is not.
  // Append the sign-off ourselves. The model kept abandoning it mid-word
  // ("Ha" for "Happy to..."), and a rep's sign-off is fixed text anyway: not
  // worth a generation, and worth getting exactly right.
  parsed.body = `${parsed.body.trimEnd()}\n\nBest regards,\n${repFirstName(input.mailbox)}`;

  const tail = parsed.body.trimEnd().slice(-1);
  const looksComplete = /[.!?"')\dA-Za-z]/.test(tail);
  if (resp.stop_reason === "max_tokens" || !looksComplete) {
    console.warn(
      `[followup-draft] discarding truncated draft for ${input.account} ` +
        `(stop_reason=${resp.stop_reason}, ends "${parsed.body.trimEnd().slice(-24)}")`,
    );
    return null;
  }

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

/**
 * Draft the follow-up automatically after a call, into the rep's Drafts folder.
 *
 * Called from transcript-sync alongside the recap. Best-effort in the same way
 * everything else on that path is: it must never affect ingest, and every skip
 * is a quiet return rather than a throw.
 *
 * Four gates, in cost order:
 *   - new_opportunity calls only. An internal sync or an existing-customer
 *     check-in does not want a sales follow-up sitting in the rep's drafts.
 *   - mailbox on GRAPH_MAIL_ALLOWED_MAILBOXES, so a rep who has not been
 *     onboarded never gets written to.
 *   - a customer-side attendee exists to write to.
 *   - not already drafted for this call, checked against sent_messages, so a
 *     re-ingest cannot leave the rep two drafts of the same email.
 */
export async function autoDraftFollowUpForCall(args: {
  tenantId: string;
  callId: string;
  dealId: string;
  account: string;
  repEmail: string | null;
  meetingType: string | null;
  summary: PostCallSummary;
  attendees?: string;
  callDate?: string | null;
  participants: unknown;
}): Promise<{ created: boolean; reason?: string }> {
  const { supabaseAdmin } = await import("./supabase");
  const { allowedMailboxes } = await import("./graph-mail");
  const { recordSentMessage } = await import("./sent-messages");

  if (args.meetingType !== "new_opportunity") {
    return { created: false, reason: `meeting type '${args.meetingType ?? "unclassified"}' is not an opportunity call` };
  }
  const mailbox = (args.repEmail ?? "").trim().toLowerCase();
  if (!mailbox) return { created: false, reason: "no rep email on the deal" };
  if (!allowedMailboxes().includes(mailbox)) {
    return { created: false, reason: `${mailbox} is not on GRAPH_MAIL_ALLOWED_MAILBOXES` };
  }

  const people = Array.isArray(args.participants)
    ? (args.participants as Array<{ email?: string | null }>)
    : [];
  const customerEmails = people
    .map((p) => (p?.email ?? "").toLowerCase().trim())
    .filter((e) => e.includes("@") && domainOf(e) !== "magaya.com");
  if (customerEmails.length === 0) {
    return { created: false, reason: "no customer-side attendee on the call" };
  }

  const db = supabaseAdmin();
  const prior = await db
    .from("sent_messages")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("call_id", args.callId)
    .eq("kind", "followup_draft")
    .limit(1);
  if ((prior.data ?? []).length > 0) {
    return { created: false, reason: "follow-up already drafted for this call" };
  }

  // Same calendar the briefing sync reads, so proposed times are real openings.
  const conn = await db
    .from("microsoft_connections")
    .select("id")
    .eq("user_principal_name", mailbox)
    .maybeSingle();

  const res = await createFollowUpDraft({
    mailbox,
    customerDomains: customerDomainsFor(customerEmails),
    customerEmails,
    account: args.account,
    summary: args.summary,
    attendees: args.attendees,
    callDate: args.callDate ?? null,
    calendarConnectionId: conn.data?.id ?? null,
  });
  if (!res.created || !res.draft) return { created: false, reason: res.reason ?? "draft not created" };

  // Archive it. This is both the audit trail and the idempotency marker, so it
  // is recorded even though nothing was emailed.
  await recordSentMessage({
    tenantId: args.tenantId,
    dealId: args.dealId,
    callId: args.callId,
    kind: "followup_draft",
    toEmail: mailbox,
    subject: res.draft.subject,
    // Real HTML, not an empty string: the Activity log renders body_html in the
    // expandable detail, so an empty body means the row cannot be inspected.
    // Inspecting exactly what was put in a rep's mailbox is the whole point.
    html: draftArchiveHtml(res.draft),
    text: res.draft.body,
    providerId: null,
  });
  return { created: true };
}

/**
 * The archived copy shown in the Activity log. Records what the rep will see,
 * including whether it went onto a thread and which files they still need to
 * attach, since those are the two things most likely to be wrong.
 */
function draftArchiveHtml(draft: FollowUpDraft): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const meta = draft.replyToMessageId
    ? "Reply on the existing customer thread"
    : `New email to ${draft.to.join(", ") || "(no recipients resolved)"}`;
  const attach = draft.attachmentsToAdd.length
    ? `<p style="margin:12px 0 0;color:#b45309;font-size:12px;">Rep must attach: ${esc(draft.attachmentsToAdd.join(", "))}</p>`
    : "";
  return [
    `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:13px;color:#0F172A;">`,
    `<p style="margin:0 0 4px;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.05em;">Draft, not sent</p>`,
    `<p style="margin:0 0 12px;color:#334155;font-size:12px;">${esc(meta)}</p>`,
    `<div style="white-space:pre-wrap;">${esc(draft.body)}</div>`,
    attach,
    `</div>`,
  ].join("");
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
