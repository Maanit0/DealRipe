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

import { runModel } from "./model-run";
import { createReplyDraft, createDraft, domainOf, getMessageBody, listMailboxMessages, type MailMessage } from "./graph-mail";
import { applyMagayaTerms, MAGAYA_GLOSSARY } from "./magaya-terms";
import { repName } from "./display-names";
import { listMeetingsBetween } from "./microsoft-graph";
import type { PostCallSummary } from "./post-call-summary";

const GRAPH_TENANT = "magaya.com";
/** How far back to look for the live thread with this customer. */
const THREAD_LOOKBACK_DAYS = 120;
/** How many of the rep's own sent messages to learn voice from. */
const VOICE_SAMPLES = 6;
// Head carries greeting and register; tail carries the sign-off. Both matter,
// the middle is deal content we do not want the model copying.
const VOICE_HEAD = 700;
const VOICE_TAIL = 300;

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
  /**
   * The company's real name, from the CRM, for the subject line.
   *
   * `account` is DealRipe's own deal key and must never reach a customer: the
   * fallback subject was putting "Gfcus" and "Snsiq" in front of them, so the
   * name was dropped entirely and the subject became a bare "Following up on our
   * call". That fixed the leak and created a different problem, which Ariel
   * Rodriguez reported on 2026-08-28: with 50 drafts in his folder and no
   * company name on any of ours, he could not find the one we had just written
   * him. Verified by message id afterwards, it was there the whole time.
   *
   * So: the CRM's spelling when we have one, and no name at all when we do not.
   * Never the slug.
   */
  customerName?: string | null;
  /**
   * OPTIONAL. Absent on a general recap, which carries no qualification
   * summary. The draft is written from the transcript, so this is supporting
   * detail rather than the source, and its absence costs a timezone hint and a
   * next-step line rather than the email.
   */
  summary?: PostCallSummary;
  /** Attendees on the call, so the draft addresses real people. */
  attendees?: string;
  /**
   * The customer-side people this email is addressed to, by name.
   *
   * Without this the model has to infer the greeting from the transcript, which
   * names everyone in the room including the rep. Juan Lopez's Diamond
   * Forwarding draft opened "Laerte, Donna, Scott, Juan," and the Juan in that
   * list was the sender. customerEmails was already computed and correct; it
   * simply never reached the prompt.
   */
  recipients?: string;
  /** ISO date of the call. */
  callDate?: string | null;
  /** microsoft_connections id for the rep, so times come from their calendar. */
  calendarConnectionId?: string | null;
  /**
   * What each side actually committed to, from the recap's narrative pass.
   *
   * Eduardo, 2026-08-14, on the draft: "it's a little dry. I would like to have
   * more like, we discussed this, we agree this, kind of like have a starting
   * point in the next conversation."
   *
   * These carry a verified transcript quote behind each line, which is the
   * point: the draft used to re-derive commitments from the transcript on its
   * own and got them wrong. Juan's draft opened by promising a proposal
   * implementation estimate he was never sending, because the call discussed
   * one and he was only sending a recording. Discussed is not agreed.
   */
  agreed?: { weOwe: string[]; customerOwes: string[] };
  /**
   * What KIND of conversation this was, so the email has the right job.
   *
   * Until 2026-08-23 the draft had exactly one shape: a post-call recap ending
   * in one dated ask. That is right after discovery and wrong everywhere else,
   * and the Protrans call is what made it obvious. DealRipe drafted a recap of
   * a technical report review; Alexandra sent a full commercial concessions
   * letter with revised licence fees, tier pricing and implementation rates,
   * because the customer was waiting on terms. Our draft scored 17% overlap and
   * that was the correct outcome: it was a well-written email for a different
   * conversation.
   *
   * The recap already routes on call type and the follow-up draft never did,
   * even though calls.call_subtype was written minutes earlier by the same
   * ingest. Absent falls back to the discovery shape, which is what it always
   * did.
   */
  callSubtype?: string | null;
  /** The call verbatim. THE SOURCE. See autoDraftFollowUpForCall's note. */
  transcript?: string | null;
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
export type ExistingMeeting = { label: string; subject: string | null };

/**
 * The same read, saying whether it ran.
 *
 * "The rep has nothing booked with this customer" and "we could not read the
 * rep's calendar" produce the same null and the same draft, and only one of
 * them is safe: the second is how a draft asks a customer to book a call they
 * have already booked, which is the exact failure this function exists to
 * prevent. The draft still goes out either way (a rep reviews it before it
 * sends), but the log now says which case it was written under.
 */
export type ExistingMeetingRead =
  | { status: "found"; meeting: ExistingMeeting }
  /** The calendar was read and holds no meeting with this customer. */
  | { status: "none"; meeting: null }
  /** No domains to match on, so there was nothing to look for. */
  | { status: "no_domains"; meeting: null }
  /** This rep has no connected calendar, so there was nothing to read. */
  | { status: "no_calendar"; meeting: null }
  /** The calendar read threw. We do not know what the rep has booked. */
  | { status: "unavailable"; meeting: null; error: string };

export async function readExistingMeetingWith(
  connectionId: string,
  customerDomains: string[],
  timeZone = "America/New_York",
): Promise<ExistingMeetingRead> {
  if (customerDomains.length === 0) return { status: "no_domains", meeting: null };
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
        status: "found",
        meeting: {
          subject: e.subject,
          label: at.toLocaleString("en-US", {
            weekday: "long",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZone,
          }),
        },
      };
    }
  } catch (err) {
    return {
      status: "unavailable",
      meeting: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  return { status: "none", meeting: null };
}

/**
 * Null means "nothing booked, or we could not tell". Kept for callers that
 * cannot act on the difference; the draft path uses readExistingMeetingWith.
 */
export async function existingMeetingWith(
  connectionId: string,
  customerDomains: string[],
  timeZone = "America/New_York",
): Promise<ExistingMeeting | null> {
  const read = await readExistingMeetingWith(connectionId, customerDomains, timeZone);
  return read.status === "found" ? read.meeting : null;
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
  } catch (err) {
    // No calendar is a reason to propose nothing, never a reason to guess.
    // Still worth saying out loud: an empty slot list because the rep is
    // genuinely booked solid and an empty slot list because Graph would not
    // answer produce the same draft, and only the second is a fault.
    console.warn(
      `[followup-draft] calendar read failed for connection ${connectionId}, proposing no times: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
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
    if (!m.outbound) return false;
    // Clean first, then measure. See stripMailChrome.
    const real = stripMailChrome(m.preview);
    if (real.length < 80) return false;
    if (isMeetingInviteBoilerplate(`${m.subject}\n${m.preview}`)) return false;
    return [...m.to, ...m.cc].some((r) => {
      const d = domainOf(r);
      return Boolean(d) && d !== me && !isFreeMailNoise(d as string);
    });
  });
  // Fall back to any sent mail rather than none: a slightly-off voice beats a
  // generic one, and a new rep may have no customer mail yet.
  const pool =
    external.length > 0
      ? external
      : msgs.filter(
          (m) =>
            m.outbound &&
            stripMailChrome(m.preview).length >= 80 &&
            !isMeetingInviteBoilerplate(`${m.subject}\n${m.preview}`),
        );
  const chosen = pool.slice(0, VOICE_SAMPLES);

  // Fetch the real body for these few. bodyPreview is the first ~255 characters,
  // so it shows how a rep OPENS an email and never how they close one. The
  // prompt asks the model to match greeting and sign-off, and a sign-off is at
  // the end, so preview-only samples cannot teach the half that reps notice.
  // Steven asked about exactly this: he signs off "Cheers", which lives in the
  // last line and would never have appeared in a sample.
  const withBodies = await Promise.all(
    chosen.map(async (m) => {
      const body = await getMessageBody({ tenantIdOrDomain: GRAPH_TENANT, mailbox, messageId: m.id }).catch(() => null);
      return { m, body };
    }),
  );

  return withBodies.map(({ m, body }) => {
    if (!body) return `Subject: ${m.subject}\n${m.preview}`;
    // Trim the quoted thread below a reply, which is someone else's writing.
    // Cut the quoted thread. Outlook's text rendering separates a reply with a
    // long underscore rule before "From:", which the original pattern missed
    // entirely, so Steven's samples carried the whole chain. That made them long
    // enough to trip the head/tail truncation, which put his sign-off in the
    // head and a "[...]" marker where his name should have been.
    const own = body
      .split(/\n\s*(?:_{10,}|-{10,})\s*\n(?=\s*(?:From|Sent|To|Subject):)/)[0]
      .split(/\n\s*(?:From:|On .{0,60}wrote:|-----Original Message-----)/)[0]
      .trim();
    if (own.length <= VOICE_HEAD + VOICE_TAIL) return `Subject: ${m.subject}\n${own}`;
    // Head carries the greeting and register, tail carries the sign-off.
    return `Subject: ${m.subject}\n${own.slice(0, VOICE_HEAD)}\n[...]\n${own.slice(-VOICE_TAIL)}`;
  });
}

/**
 * The rep's first name for the sign-off. Deliberately just the name: no title
 * or phone number, because inventing either is worse than omitting both and
 * the rep's full block is already configured in Outlook.
 */
function repFirstName(mailbox: string): string {
  return repName(mailbox);
}


// ====================================================================
// Voice sample hygiene
// ====================================================================

/**
 * Boilerplate that is outbound, external and long, and teaches the model
 * nothing about how a rep writes.
 *
 * Alexandra's six samples were four of these and two real emails: two raw Teams
 * invitations she organized, and two one-line acknowledgements. So most of what
 * the model saw as "her voice" was Microsoft's meeting template.
 */
function isMeetingInviteBoilerplate(text: string): boolean {
  return (
    /Microsoft Teams meeting/i.test(text) ||
    /teams\.microsoft\.com\/l\/meetup-join/i.test(text) ||
    /\bMeeting ID:\s*[\d ]{9,}/i.test(text) ||
    /\bPasscode:\s*\S+/i.test(text) ||
    /zoom\.us\/j\/\d+/i.test(text)
  );
}

/**
 * Strip the parts of a message the rep did not type: mobile footers, the rule
 * Outlook draws above them, and image placeholders.
 *
 * This has to run BEFORE any length test. "Perfect thank you" is seventeen
 * characters of actual writing and only cleared the 80 character minimum
 * because "Get Outlook for iOS" and a divider were counted with it, so two of
 * the six samples were acknowledgements dressed up as substantial emails.
 */
/**
 * Where the rep's own writing ends and somebody else's quoted message begins.
 *
 * Outlook opens a quoted original with a separator that CARRIES TEXT, so the
 * bare-rule strip below never matched it, and the header block underneath is
 * all short lines that sail through the 60-char filter in learnSignature.
 *
 * Ariel's sent mail is mostly replies to meeting invites. His learned
 * "signature" came out as his sign-off, his name, then
 * "-----Original Appointment-----" and the invite headers. Appended to a draft,
 * the body ended in a dash, the completeness check read that as a truncation,
 * and every draft he should have had was discarded before it reached his
 * Outlook. That is the Black Gold call on 2026-08-12 and it was never about the
 * reply path.
 *
 * Everything past the first boundary is another person's prose. It is wrong in
 * a signature and wrong in a voice sample, so it is cut in one place for both.
 */
const QUOTED_BOUNDARY_RE =
  /^\s*(?:-{2,}\s*original\s+(?:message|appointment)\s*-{2,}|_{5,}\s*$|from:\s|sent:\s|on\s.{0,160}\swrote:\s*$|>)/i;

function cutQuotedTail(text: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => QUOTED_BOUNDARY_RE.test(l));
  return at === -1 ? text : lines.slice(0, at).join("\n");
}

function stripMailChrome(text: string): string {
  return cutQuotedTail(text)
    .replace(/Get Outlook for (iOS|Android)\s*<[^>]*>/gi, "")
    .replace(/Sent from my (iPhone|iPad|Android|BlackBerry)[^\n]*/gi, "")
    .replace(/\[cid:[^\]]*\]\s*(<[^>]*>)?/gi, "")
    .replace(/\[(?:A |An )?[^\]]{0,80}(?:picture|image|drawing|logo)[^\]]{0,80}\]\s*(<[^>]*>)?/gi, "")
    .replace(/^[_\-\u2500-\u257F]{6,}$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Sign-offs reps actually use. Order does not matter; the match does. */
const SIGNOFF_RE =
  /^(kindly|best|best regards|warm regards|warmest regards|regards|thanks|thank you|thanks so much|many thanks|cheers|sincerely|talk soon|all the best|respectfully)[,!.]?$/i;

/**
 * The rep's real closing block, learned from their own sent mail.
 *
 * Every draft has always ended "Best regards," plus a first name, on the
 * assumption that Outlook appends the rep's configured signature. Drafts
 * created through Graph do not get the client-side signature, so the rep opens
 * the draft and pastes their block in by hand every single time. Alexandra
 * signs "Kindly," and her block is name, title and phone; "Best regards,
 * Alexandra" is not how she has closed a single email we sampled.
 *
 * Returns null when the samples do not agree on anything, because a guessed
 * signature on outgoing customer mail is worse than the generic one.
 */
/**
 * A rep's real closing block, as the rep themselves supplied it.
 *
 * learnSignature reads the richest block out of a rep's sent mail, which works
 * whenever their sent mail HAS a rich block in it. Juan Lopez, 2026-08-27, on
 * the drafts he was getting: "the signature that's on it is as if I was writing
 * it from my mobile phone." It was, because that is what the sample agreed on.
 * Stripping "Sent from my iPhone" removes the tagline and cannot put back a
 * title and a phone number that were never in the mail we sampled.
 *
 * So this is not a heuristic and is not derived from anything: it is the block
 * the rep sent us, kept verbatim. It outranks the learned one, because a rep
 * telling us their own signature is better evidence than us inferring it.
 *
 * ONLY THE LINES BELOW THE SIGN-OFF live here. How a rep says goodbye is still
 * learned from their mail: Alexandra closes "Kindly," and Juan did not tell us
 * what he closes with, so inventing one would replace a measured fact with a
 * guess to fix a problem he did not report.
 *
 * The Magaya banner image Juan attached is deliberately NOT here. A draft body
 * is assembled as text, an <img> needs a URL we would have to host, and a
 * broken image on outgoing customer mail is worse than no image. It is tracked
 * as an open item instead.
 */
const REP_SIGNATURE_BLOCK: Record<string, string> = {
  // Supplied by Juan on 2026-08-27, transcribed from the block in his own mail.
  "jlopez@magaya.com": "JUAN LOPEZ\nSENIOR SOFTWARE ADVISOR\n786.363.6269",
};

/**
 * The sign-off line the rep actually uses, taken off their learned block.
 *
 * Returns null rather than a default, so the caller can tell "they close with
 * Kindly" apart from "we never saw them close anything", which are the two
 * cases that decide whether the generic fallback is right.
 */
function learnedSignOff(signature: string | null): string | null {
  const first = (signature ?? "").split("\n")[0]?.trim();
  return first && SIGNOFF_RE.test(first) ? first : null;
}

export function learnSignature(
  samples: ReadonlyArray<string>,
  repDisplayName?: string | null,
): string | null {
  const candidates: string[] = [];

  for (const raw of samples) {
    // A sample may carry a "[...]" marker where the middle was cut out. A block
    // read across that marker is not a signature, it is two fragments with a
    // hole in it, and it shipped "Cheers," followed by a job title and no name.
    const usable = stripMailChrome(raw).split("\n[...]\n")[0];
    const lines = usable.split("\n").map((l) => l.trimEnd());
    // Search from the end: a sign-off word can appear mid-email ("thanks for
    // sending that"), and only the last one closes the message.
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!SIGNOFF_RE.test(lines[i].trim())) continue;
      const block = lines
        .slice(i)
        // A long line after the sign-off is prose from a quoted reply, not part
        // of the block.
        .filter((l) => l.trim().length <= 60 && !l.includes("[...]"))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (block.length > 0) candidates.push(block);
      break;
    }
  }

  if (candidates.length === 0) return null;
  // Prefer the richest block, which is the one carrying title and phone rather
  // than a bare "Thanks, Alex" off a phone.
  candidates.sort((a, b) => b.split("\n").length - a.split("\n").length || b.length - a.length);
  const best = candidates[0];

  // A signature without the sender's name is worse than the generic fallback:
  // it reads as a template someone forgot to fill in. If the block never names
  // the rep, put the name back directly under the sign-off.
  const name = (repDisplayName ?? "").trim();
  if (!name) return best;
  const first = name.split(/\s+/)[0].toLowerCase();
  const namesTheRep = best
    .split("\n")
    .slice(1)
    .some((l) => l.trim().toLowerCase().includes(first));
  if (namesTheRep) return best;
  const [signOff, ...rest] = best.split("\n");
  return [signOff, name, ...rest].join("\n").replace(/\n{3,}/g, "\n\n");
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
7a. GREET ONLY THE PEOPLE LISTED UNDER "WRITING TO". The rep is the sender and must never appear in their own greeting, and neither must anyone else from the rep's own company. Names in the transcript are the room, not the address line. If no recipients are listed, open without names rather than guessing from the transcript.
8. Any proposed time carries a TIMEZONE. "Thursday, August 13th at 10:00 AM ET", never a bare "10:00 AM". These customers span Canada, Latin America, Europe and Asia, and an unqualified time is how a booked meeting turns into a no-show. When the customer's own timezone is given below, state the time in THEIRS, then the rep's in brackets: "10:00 AM ET (9:00 AM CT my time)". Writing a time only in the seller's zone quietly makes the buyer do the conversion.
9. Distinguish what is IN THIS EMAIL from what will be REVIEWED at the meeting. A recording, a datasheet or a video is in this email: write "here's the recording", present tense. A proposal, pricing or an implementation estimate is walked through live, because emailing it ahead removes the reason for the meeting and lets the buyer evaluate it alone. Unless the transcript shows the rep explicitly promising to email a proposal ahead, do NOT say it is coming. Do not lump them together: "the proposal, recording and estimate are on their way" is wrong when only the recording is going now.
10. FORMAT AS SHORT STANDALONE LINES, one thought each, with a blank line between. Never a dense paragraph. A rep reads this on a phone between calls and a wall of text gets rewritten. Roughly: greeting, one line on what is in the email, one line with the dated ask, one optional line with the softer question.
10a. STOP AFTER THE LAST CONTENT LINE. Do NOT write a closing line, a sign-off, a name, a title or a phone number. The rep's signature is appended automatically and is not yours to write. End the body on the final sentence of substance.
11. For anything going out WITH this email, use present tense and stay neutral about the mechanism: "Here's the recording from Friday's session." That stays true once the rep attaches it.
   Do NOT write "please find attached" or "I have attached": nothing is attached when the rep opens the draft, and it reads as a mistake.
   Do NOT write "is on its way", "are on their way" or "I'll send it over" for something included in THIS email either. Those describe a separate, later email and leave the customer waiting for one that never arrives.
   Always name the file in attachmentsToAdd so the rep knows what to attach before sending.

WHAT THIS PARTICULAR EMAIL IS FOR

The user message names the kind of call. The rules above hold for all of them, but the JOB of the email changes and rule 1's "one ask" means something different in each:

- DISCOVERY: they told you about their problem. Reflect it back in their words and ask for the next conversation, dated. This is the default shape.
- DEMO: they saw the product. Connect what they saw to the specific problem they named earlier, and ask for the next step toward a decision, dated.
- PROPOSAL or NEGOTIATION: they are evaluating terms and are waiting on YOU. The email carries the substance being decided on, not a recap of the meeting. State what changed, item by item, in the order the customer raised them, and be concrete about numbers, dates and what is included. Length rule 3 is relaxed here and only here: a terms email is as long as the terms. Still one ask, and it is for the decision or the next step toward it.
- FOLLOW_UP: the conversation is already running. Be short, pick up exactly where it left off, and do not re-introduce anything.
- EXISTING CUSTOMER: they already buy from you. Never write as though you are selling in for the first time, never ask what is driving them to look at a new solution.

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

/**
 * How much of the call goes into the draft prompt. A 36k-character transcript
 * is the measured worst case, so this is effectively all of it, capped so one
 * unusually long call cannot crowd out the checked detail underneath.
 */
const TRANSCRIPT_CHARS = 30_000;

function buildUserMessage(
  input: FollowUpDraftInput,
  samples: string[],
  hasThread: boolean,
  /** The newest message in that thread, already truncated. Empty when unread. */
  threadBody: string,
  slots: ProposedSlot[],
  booked: { label: string; subject: string | null } | null,
): string {
  const s = input.summary;
  const today = new Date().toISOString().slice(0, 10);
  // Stated as a fact at the top, the same way the briefing states call type, so
  // the model routes on it rather than inferring the shape from the transcript.
  const kind = (input.callSubtype ?? "").trim().toLowerCase();
  const KIND_LABEL: Record<string, string> = {
    discovery: "DISCOVERY",
    demo: "DEMO",
    proposal: "PROPOSAL or NEGOTIATION",
    follow_up: "FOLLOW_UP",
    customer: "EXISTING CUSTOMER",
    internal: "INTERNAL",
  };
  const transcript = (input.transcript ?? "").trim().slice(0, TRANSCRIPT_CHARS);
  return [
    `TODAY: ${today}`,
    `CUSTOMER (DealRipe's internal label, NOT necessarily how they spell it. Take the company's own name from the call, and the people's names from WRITING TO below, never from the transcript, which mishears them): ${input.account}`,
    transcript
      ? `THE CALL, VERBATIM. This is your source. Write from what was actually said, and use the customer's own words where they said something worth echoing back. Everything below this is checked detail to get right, not material to narrate.\n\n${transcript}`
      : "",
    KIND_LABEL[kind]
      ? `THIS WAS A ${KIND_LABEL[kind]} CALL. Write the email that kind of call needs.`
      : `CALL KIND NOT CLASSIFIED, so write the default discovery shape.`,
    input.attendees ? `ON THE CALL: ${input.attendees}` : "",
    MAGAYA_GLOSSARY,
    input.recipients
      ? `WRITING TO (greet these people and nobody else): ${input.recipients}`
      : "",
    input.callDate ? `CALL DATE: ${input.callDate}` : "",
    s?.customerTimezone
      ? `CUSTOMER TIMEZONE (they said so on the call): ${s?.customerTimezone}. Propose the time in this zone.`
      : `CUSTOMER TIMEZONE: not stated on the call. Use the rep's zone and label it explicitly.`,
    hasThread
      ? `THIS IS A REPLY on an existing thread. Do not re-introduce yourself and do not restate context they already have.`
      : "",
    threadBody
      ? `THE LAST MESSAGE IN THAT THREAD, so you can pick up where it left off rather than repeat it. If it asks a question that is still open, answer it or say when you will:\n${threadBody}`
      : `THERE IS NO EXISTING THREAD. Write a fresh email and include a subject.`,
    ``,
    `WHAT WAS SAID ON THE CALL:`,
    s?.recap ?? "",
    ``,
    // The opening the reps asked for. Stated before the ask, because the point
    // is to give the customer a foundation to reply from rather than a cold
    // request.
    input.agreed && (input.agreed.weOwe.length > 0 || input.agreed.customerOwes.length > 0)
      ? [
          `WHAT WAS ACTUALLY AGREED. Open the email by restating this briefly, in your own words, so the customer starts from established ground. These are the ONLY commitments that exist; anything else discussed on the call was discussed, not agreed, and must not be described as something you are sending.`,
          input.agreed.weOwe.length > 0 ? `We owe them:\n${input.agreed.weOwe.map((x) => `- ${x}`).join("\n")}` : "",
          input.agreed.customerOwes.length > 0
            ? `They owe us:\n${input.agreed.customerOwes.map((x) => `- ${x}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    ``,
    s?.nextStepCommitment
      ? `THE COMMITMENT ALREADY AGREED (build the dated ask around this, do not invent a different one):\n${s?.nextStepCommitment}\nCAUTION: this line is a summary of the rep's intent, not a list of what goes in this email. If it names a proposal, pricing or an estimate, those are what the MEETING is for. Rule 9 overrides this wording.`
      : `NO COMMITMENT WAS AGREED ON THE CALL. The ask should secure one.`,
    // Ranked deliberately. A date on the calendar outranks a document or a
    // signature, because the rep's own words are that a booked date is a
    // commitment while an action item is only an intention. This is the ask
    // most likely to be missed, so it is stated first and unambiguously.
    s?.shouldBookNextMeeting
      ? `\nNOTHING IS ON THE CALENDAR and this deal should have a date. Propose ONE specific date and time as the ask, even if the immediate step is asynchronous. This outranks asking for a document or a signature; fold those in around it rather than leading with them.`
      : "",
    // Times come from the rep's real calendar. Inventing one produced a draft
    // proposing a slot the rep was not free for, which he immediately spotted.
    // A meeting already on the calendar outranks everything: never ask a
    // customer to book something they have already booked.
    booked
      ? `\nA MEETING WITH THIS CUSTOMER IS ALREADY ON THE CALENDAR: ${booked.label}${booked.subject ? ` ("${booked.subject}")` : ""}.\nDo NOT propose a time and do NOT ask them to book anything. Reference the existing meeting as settled ("ahead of ${booked.label}") and make the ask something else, drawn from what was actually said on the call: confirming who is joining, or chasing a specific thing they said they would do.`
      : slots.length > 0
        ? `\nPROPOSE ONE OF THESE EXACT TIMES, copied verbatim. They are confirmed free on the rep's calendar:\n${slots.map((s) => `- ${s.label}`).join("\n")}\nUse the FIRST one unless the transcript gives a reason to prefer another. Never invent a different date or time.`
        : `\nNO CONFIRMED FREE SLOTS ARE AVAILABLE. Do NOT invent a specific time. Ask them to propose one, or offer a named week ("early next week").`,
    s?.followUpMeetingExpected && s?.noFollowupBooked
      ? `\nA next meeting was agreed on the call and could be booked right now.`
      : "",
    // The recap's NDA signal is deliberately an over-reminder for the REP: it
    // fires whenever a demo sits anywhere in the path. That is wrong to put in
    // front of a CUSTOMER on a deal already past demo, where raising it reads
    // as the rep having lost track of their own deal. Only surface it while a
    // demo is genuinely still ahead.
    // The stage gate alone was too blunt. Dunavant's Aug 14 call sits at a
    // proposal-stage key because pricing was discussed, while the demo is still
    // ahead on Thursday the 20th and Michael owes a signed NDA on Monday the
    // 17th. isPreDemoStage said false, the rule was suppressed, and the draft
    // confirmed a demo without mentioning the signature that gates it.
    //
    // So the stage is now one of two ways to establish a demo is still ahead.
    // The other is the commitments themselves, which are verified against the
    // transcript and say so directly. That keeps the original protection (do
    // not raise an NDA on a deal genuinely past demo) while no longer relying
    // on stage as a proxy for something the agreed steps state outright.
    s?.nda?.demoIsNext &&
    !s?.nda?.ndaInPlace &&
    (isPreDemoStage(s?.stageKey) || agreedMentionsUpcomingDemo(input.agreed))
      ? `\nA demo is still ahead and no NDA is signed. Magaya requires one first, so make the proposed date contingent on it rather than raising the NDA as a separate request.`
      : "",
    ``,
    samples.length > 0
      ? `HOW THIS REP WRITES. Copy the voice, not the content:\n\n${samples.join("\n\n---\n\n")}`
      : `No writing samples available. Use plain, direct business English and keep it short.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Do the agreed commitments themselves say a demo is still coming?
 *
 * Deliberately narrow. It looks only at what both sides COMMITTED to, not at
 * anything merely discussed, because a demo someone mentioned in passing is not
 * a demo that gates an NDA.
 */
function agreedMentionsUpcomingDemo(
  agreed: { weOwe: string[]; customerOwes: string[] } | undefined,
): boolean {
  if (!agreed) return false;
  return [...agreed.weOwe, ...agreed.customerOwes].some((x) =>
    /\b(demo|demonstration|presentation|walk ?through)\b/i.test(x),
  );
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
  const [thread, samples, slots, bookedRead] = await Promise.all([
    findCustomerThread(input.mailbox, input.customerDomains),
    voiceSamples(input.mailbox).catch(() => [] as string[]),
    input.calendarConnectionId
      ? freeSlots(input.calendarConnectionId, { count: 3 }).catch(() => [] as ProposedSlot[])
      : Promise.resolve([] as ProposedSlot[]),
    input.calendarConnectionId
      ? readExistingMeetingWith(input.calendarConnectionId, input.customerDomains).catch(
          (err): ExistingMeetingRead => ({
            status: "unavailable",
            meeting: null,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      : Promise.resolve<ExistingMeetingRead>({ status: "no_calendar", meeting: null }),
  ]);

  // What was actually said in the thread, not just that a thread exists.
  //
  // The prompt used to get a bare "THIS IS A REPLY, do not re-introduce
  // yourself", which tells the model to avoid repeating context it has never
  // been shown. So a draft could thank someone for a call while ignoring the
  // question they asked in writing the day before. Steven Johnson wants the
  // draft to be a starting point he edits rather than one he rewrites, and a
  // follow-up that misses the open question in the thread is a rewrite.
  //
  // Best-effort and truncated. A mailbox we cannot read costs the context and
  // not the draft, and a long thread must not crowd out the call itself.
  const threadBody = thread
    ? await getMessageBody({ tenantIdOrDomain: GRAPH_TENANT, mailbox: input.mailbox, messageId: thread.id })
        .then((b) => (b ?? "").replace(/\s+/g, " ").trim().slice(0, 1500))
        .catch(() => "")
    : "";

  // The draft is composed the same way either way; a rep reviews it before it
  // sends, and withholding a draft over a calendar blip helps nobody. But an
  // unread calendar is the one condition under which this draft can ask a
  // customer to book a call they already booked, so it does not pass silently.
  if (bookedRead.status === "unavailable") {
    console.warn(
      `[followup-draft] could not read ${input.mailbox}'s calendar for ${input.account}, so this draft ` +
        `does not know whether a meeting with them is already booked and may propose a time for one: ${bookedRead.error}`,
    );
  }
  const booked = bookedRead.meeting;

  const resp = await runModel({
    task: "followup_draft",
    // Generous headroom. A truncated draft is the one failure mode a rep cannot
    // work around: they see an email cut off mid-sentence and stop trusting it.
    maxTokens: 3000,
    temperature: 0.3, // a shade of variation so it reads human, not templated
    system: SYSTEM,
    messages: [{ role: "user", content: buildUserMessage(input, samples, Boolean(thread), threadBody, slots, booked) }],
  });
  const block = resp.message.content.find((b) => b.type === "text");
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
  //
  // Check the MODEL'S body, before the signature is appended. The check used to
  // run afterwards, which meant it read the last character of the signature and
  // never once looked at the text it exists to police: a body truncated
  // mid-sentence passed whenever the signature happened to end in a letter, and
  // a sound body was thrown away whenever the signature did not. Both halves of
  // that showed up in production.
  const modelTail = parsed.body.trimEnd().slice(-1);
  if (resp.truncated || !/[.!?"')\dA-Za-z]/.test(modelTail)) {
    console.warn(
      `[followup-draft] discarding truncated draft for ${input.account} ` +
        `(stop_reason=${resp.message.stop_reason}, body ends "${parsed.body.trimEnd().slice(-24)}")`,
    );
    return null;
  }

  // Append the sign-off ourselves. The model kept abandoning it mid-word
  // ("Ha" for "Happy to..."), and a rep's sign-off is fixed text anyway: not
  // worth a generation, and worth getting exactly right.
  // Use the rep's OWN closing block when their sent mail agrees on one, and
  // fall back to the generic pair only when it does not. Hardcoding "Best
  // regards" gave every rep the same sign-off regardless of how they actually
  // close, and gave none of them their name, title and phone, so the first
  // thing each rep did to a draft was retype their own signature.
  const learned = learnSignature(samples, repFirstName(input.mailbox));
  // A rep-supplied block replaces the LEARNED BLOCK ONLY, and keeps the rep's
  // own sign-off word above it when we have measured one.
  const supplied = REP_SIGNATURE_BLOCK[input.mailbox.toLowerCase()];
  const signature = supplied
    ? `${learnedSignOff(learned) ?? "Best regards,"}\n${supplied}`
    : learned;
  parsed.body = `${parsed.body.trimEnd()}\n\n${signature ?? `Best regards,\n${repFirstName(input.mailbox)}`}`;

  // Customer-side addresses from the CALL, computed the same way for a reply and
  // for a fresh draft.
  //
  // This used to be empty on the reply path, on the assumption that Graph fills
  // recipients from the thread. It does, and it fills them with whoever sent
  // last, which is the BDR when a BDR booked the meeting. Eduardo, 2026-08-14:
  // "your recap email is going out to that BDR instead of the prospect in the
  // meeting." The addresses were already computed and correct and simply were
  // not used here.
  const to = [...new Set((input.customerEmails ?? []).map((e) => e.toLowerCase().trim()))].filter(
    (e) => e.includes("@") && domainOf(e) !== "magaya.com",
  );

  return {
    // Last thing before this reaches a customer's inbox. A rep who says
    // "acelink" on a call had it copied straight into the draft; the prompt
    // glossary makes that unlikely and this makes it impossible.
    // Never the account field here. It holds DealRipe's own deal key, so this
    // fallback was putting "Following up on our call, Gfcus" and "Snsiq" in
    // front of customers on every fresh draft. No name beats the wrong name.
    subject: applyMagayaTerms(
      parsed.subject || fallbackSubject(input.customerName),
    ),
    body: applyMagayaTerms(parsed.body),
    replyToMessageId: thread?.id ?? null,
    to,
    attachmentsToAdd: parsed.attachmentsToAdd,
  };
}

/**
 * The subject when the model did not write one.
 *
 * Only a name the CRM gave us. A rep hunting a folder of fifty drafts needs
 * something to search for, and a customer reading it needs it to be their actual
 * company name rather than our internal key.
 */
function fallbackSubject(customerName: string | null | undefined): string {
  const name = String(customerName ?? "").trim();
  return name ? `Following up on our call, ${name}` : "Following up on our call";
}

/** Generate AND write the draft into the rep's Drafts folder. Never sends. */
export async function createFollowUpDraft(
  input: FollowUpDraftInput,
): Promise<{
  created: boolean;
  draft: FollowUpDraft | null;
  webLink?: string | null;
  /**
   * The draft's RFC 5322 Message-ID, which SURVIVES being sent.
   *
   * Returned so the caller can persist it. Without it there is no way to join a
   * message the rep SENT back to the draft it came from, so "did they send
   * ours" can only be answered by matching on time and recipient, which cannot
   * separate a rep who sent our draft from one who ignored it and happened to
   * write something similar. scripts/draft-adoption.ts says so in its own
   * output; this is what removes the caveat.
   *
   * Deliberately NOT Graph's `id`: Outlook assigns a new one when the draft
   * moves to Sent Items, so a join on it would silently never match. Same trap
   * as iCalUId against the per-mailbox event id.
   */
  draftId?: string | null;
  reason?: string;
}> {
  const draft = await generateFollowUpDraft(input);
  if (!draft) return { created: false, draft: null, reason: "generation returned nothing" };

  const fresh = () =>
    createDraft({
      tenantIdOrDomain: GRAPH_TENANT,
      mailbox: input.mailbox,
      subject: draft.subject,
      body: draft.body,
      to: draft.to.map((email) => ({ email })),
    });

  if (!draft.replyToMessageId) {
    try {
      const res = await fresh();
      return { created: true, draft, webLink: res.webLink, draftId: res.internetMessageId };
    } catch (e) {
      return { created: false, draft, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  // Reply first, because threading the follow-up onto the existing conversation
  // is what makes it feel like the rep wrote it. But a reply is a nicety and the
  // draft is the point, so a reply that cannot be made falls back to a fresh
  // email rather than losing the whole thing.
  //
  // The case that forced this: findCustomerThread picks the liveliest thread
  // with the customer over 120 days, and for a newly onboarded rep the only mail
  // they have with that customer is often the calendar invite for the meeting
  // itself. Graph refuses to reply to a meeting request with
  // ErrorInvalidReferenceItem, and on 2026-08-11 that silently cost Custom Goods
  // and Z Transportation their follow-ups after a 104 minute demo and a proposal
  // review. Both reps' Activity cards read "never sent" with no reason anywhere.
  try {
    const res = await createReplyDraft({
      tenantIdOrDomain: GRAPH_TENANT,
      mailbox: input.mailbox,
      messageId: draft.replyToMessageId,
      body: draft.body,
      // Overrides the thread's last sender. Empty leaves Graph's own choice,
      // which is right when we could not establish who the customer was.
      toRecipients: draft.to,
    });
    return { created: true, draft, webLink: res.webLink, draftId: res.internetMessageId };
  } catch (replyErr) {
    const msg = replyErr instanceof Error ? replyErr.message : String(replyErr);
    console.warn(
      `[followup-draft] reply draft failed for ${input.mailbox}, falling back to a new message: ${msg}`,
    );
    try {
      const res = await fresh();
      return { created: true, draft, webLink: res.webLink, draftId: res.internetMessageId };
    } catch (e) {
      return {
        created: false,
        draft,
        reason: `reply failed (${msg}); new message also failed (${e instanceof Error ? e.message : String(e)})`,
      };
    }
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
/**
 * People who spoke on this call and whom the draft cannot reach.
 *
 * Not on the invite, so we have no address for them, and the draft is therefore
 * correctly addressed to fewer people than were in the room. The Orvia call is
 * the case: five customer stakeholders spoke and only Rafael has an address, in
 * the invite, in the account's Salesforce contacts, or anywhere in 120 days of
 * the rep's mail with that domain.
 *
 * DELIBERATELY NOT GUESSED. Seeing rafael@orvia.com.mx and writing
 * claudia@orvia.com.mx is a one-line change and it would put a customer email
 * on the wire to an address nobody has ever confirmed exists. The rep knows
 * these people and can add them in two seconds; we are telling them, not
 * deciding for them.
 *
 * Returns an empty list on any failure, since this line is an aid and must never
 * cost the notification.
 */
async function unaddressedSpeakers(tenantId: string, dealId: string, callId: string): Promise<string[]> {
  try {
    const { getDealAttendanceHistory } = await import("./attendance");
    const history = await getDealAttendanceHistory(tenantId, dealId, 8);
    const call = history.find((c) => c.callId === callId);
    if (!call) return [];
    return call.invitees
      .filter((i) => i.spoke && !i.onInvite && !i.email && String(i.name ?? "").trim())
      .map((i) => String(i.name).trim());
  } catch {
    return [];
  }
}

/**
 * Whether this rep gets the "draft ready" email.
 *
 * DRAFT_READY_REPS is a comma-separated list of mailboxes, or "*" for everyone.
 * Unset means nobody, so the feature ships dark and is turned on per person.
 *
 * Per rep rather than global on purpose. Ariel Rodriguez asked for this email by
 * name and knows it is coming; the other five reps do not, and an unannounced
 * new artifact after every call is exactly how a rep learns to filter DealRipe
 * out. Same shape as every other blast-radius gate here: SALESFORCE_PILOT_ACCOUNT_IDS,
 * GRAPH_MAIL_ALLOWED_MAILBOXES, PILOT_OPPORTUNITY_IDS. Fail closed.
 */
export function draftReadyEnabledFor(mailbox: string): boolean {
  const raw = (process.env.DRAFT_READY_REPS ?? "").trim();
  if (!raw) return false;
  if (raw === "*") return true;
  const wanted = new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  return wanted.has(mailbox.trim().toLowerCase());
}

/**
 * "AUGUST 28 2026 . 01:00 PM CT". Central, because Magaya works Central.
 *
 * Never left to the reader's locale, for the same reason lib/graph-time.ts
 * exists: Microsoft hands us event times with no offset, and a rep in a
 * different timezone reading their own clock off our string is how a meeting
 * gets missed.
 */
function formatMeetingWhen(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const month = d.toLocaleDateString("en-US", { timeZone: "America/Chicago", month: "long" }).toUpperCase();
  const day = d.toLocaleDateString("en-US", { timeZone: "America/Chicago", day: "numeric" });
  const year = d.toLocaleDateString("en-US", { timeZone: "America/Chicago", year: "numeric" });
  const time = d.toLocaleTimeString("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
  return `${month} ${day} ${year} \u00b7 ${time} CT`;
}

/**
 * Email the rep that their draft exists, with a link into it.
 *
 * Gated by draftReadyEnabledFor, which is per REP rather than global. Ariel
 * Rodriguez asked for this email and is expecting it; the other five reps have
 * never heard of it, and a new artifact appearing unannounced after every call
 * is how a rep starts ignoring the channel.
 *
 * Never throws. The caller fires it without awaiting, and a notification that
 * fails must not mark a written draft as not written.
 */
async function notifyDraftReady(args: {
  tenantId: string;
  dealId: string;
  callId: string;
  mailbox: string;
  account: string;
  to: string[];
  generatedSubject: string;
  body: string;
  webLink: string | null;
  internetMessageId: string | null;
  meetingWhen: string | null;
}): Promise<void> {
  if (!draftReadyEnabledFor(args.mailbox)) return;

  const { readMessageStateByInternetId } = await import("./graph-mail");
  const { renderDraftReadyEmail } = await import("./emails/draft-ready");
  const { sendEmail } = await import("./mailer");
  const { recordSentMessage } = await import("./sent-messages");

  // What Outlook ACTUALLY called it. Falls back to ours only when the read
  // fails, and the fallback is the weaker answer: on a reply it is wrong.
  let draftSubject = args.generatedSubject;
  if (args.internetMessageId) {
    const state = await readMessageStateByInternetId({
      tenantIdOrDomain: GRAPH_TENANT,
      mailbox: args.mailbox,
      internetMessageId: args.internetMessageId,
    });
    if (state.status === "draft" || state.status === "sent") draftSubject = state.subject;
  }

  const email = renderDraftReadyEmail({
    account: args.account,
    meetingWhen: args.meetingWhen,
    to: args.to,
    draftSubject,
    body: args.body,
    unaddressed: await unaddressedSpeakers(args.tenantId, args.dealId, args.callId),
    webLink: args.webLink,
  });

  const res = await sendEmail({ to: [args.mailbox], subject: email.subject, html: email.html, text: email.text });
  await recordSentMessage({
    tenantId: args.tenantId,
    dealId: args.dealId,
    callId: args.callId,
    kind: "draft_ready",
    toEmail: args.mailbox,
    subject: email.subject,
    html: email.html,
    text: email.text,
    providerId: res.id || null,
  });
}

/**
 * The company's name as the CRM spells it, or null.
 *
 * Salesforce first because the link is confirmed on 91 deals and the name there
 * is maintained; the deal's own `account` column is deliberately never used, as
 * it holds DealRipe's auto-created key.
 *
 * Returns null on any failure or any doubt. This name goes in a subject line a
 * customer will read, so "no name" is the correct answer whenever we are not
 * sure, and the caller renders a subject without one.
 */
async function crmCustomerName(dealId: string): Promise<string | null> {
  try {
    const { supabaseAdmin } = await import("./supabase");
    const db = supabaseAdmin();
    const { data } = await db
      .from("deals")
      .select("salesforce_account_id, salesforce_link_confidence")
      .eq("id", dealId)
      .maybeSingle();
    if (!data?.salesforce_account_id || data.salesforce_link_confidence !== "confirmed") return null;
    const { loadAccountContext } = await import("./salesforce-context");
    const sf = await loadAccountContext(String(data.salesforce_account_id));
    const name = String(sf?.accountName ?? "").trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

export async function autoDraftFollowUpForCall(args: {
  tenantId: string;
  callId: string;
  dealId: string;
  account: string;
  repEmail: string | null;
  meetingType: string | null;
  /** calls.call_subtype, written by transcript-sync minutes before this runs. */
  callSubtype?: string | null;
  /**
   * The call, verbatim. THE SOURCE the email is written from.
   *
   * This used to be absent and the draft was built from the summary, which is
   * built from the extraction, so it inherited the extraction's shape. That is
   * the same topology that made the recap read like a form, and Eduardo named
   * it: "it's very tied to the checks that we have." The recap was fixed by
   * going to the transcript; the draft never was.
   *
   * Measured over eight real drafts before this changed: six of the eight
   * closed with a near-identical "is there a formal approval process on your
   * end we should plan around", across four different reps and eight different
   * customers. That is DealRipe's own qualification gap list arriving in a
   * customer's inbox as a question, which is exactly what Steven Johnson said
   * he would delete.
   */
  transcript?: string | null;
  /**
   * OPTIONAL. Absent on a general recap, which carries no qualification
   * summary. The draft is written from the transcript, so this is supporting
   * detail rather than the source, and its absence costs a timezone hint and a
   * next-step line rather than the email.
   */
  summary?: PostCallSummary;
  /** Verified commitments from the narrative pass. See FollowUpDraftInput. */
  agreed?: { weOwe: string[]; customerOwes: string[] };
  attendees?: string;
  callDate?: string | null;
  participants: unknown;
  /**
   * True only when transcript-sync is re-attempting a draft that already
   * failed. It gates the "rep already followed up" check below, which exists to
   * stop a RETRY dropping a near-duplicate and was never meant to suppress a
   * first attempt.
   */
  isRetry?: boolean;
}): Promise<{ created: boolean; reason?: string }> {
  const { supabaseAdmin } = await import("./supabase");
  const { allowedMailboxes } = await import("./graph-mail");
  const { recordSentMessage } = await import("./sent-messages");

  // Internal only. Every call with a customer on it earns a follow-up.
  //
  // This used to require new_opportunity, which silently excluded every
  // existing-customer call: a renewal or an expansion conversation got no
  // draft at all. It also contradicted the subtype routing forty lines below,
  // which already varies the draft so a proposal call gets a terms email and a
  // discovery call gets a recap. The generator knew how to write a proposal
  // follow-up and was never asked to.
  //
  // Unclassified is deliberately allowed through. meeting_type is written by
  // transcript-sync and can be null, and refusing on null would turn "we did
  // not classify this" into "this was not a customer call", which is the
  // failure this codebase keeps relearning. The real filter is the
  // customer-side attendee check below: no external attendee, no draft.
  if (args.meetingType === "internal") {
    return { created: false, reason: "internal meeting, no customer to follow up with" };
  }
  const mailbox = (args.repEmail ?? "").trim().toLowerCase();
  if (!mailbox) return { created: false, reason: "no rep email on the deal" };
  if (!allowedMailboxes().includes(mailbox)) {
    return { created: false, reason: `${mailbox} is not on GRAPH_MAIL_ALLOWED_MAILBOXES` };
  }

  const people = Array.isArray(args.participants)
    ? (args.participants as Array<{ email?: string | null; name?: string | null }>)
    : [];
  const customerSide = people.filter((p) => {
    const e = (p?.email ?? "").toLowerCase().trim();
    return e.includes("@") && domainOf(e) !== "magaya.com";
  });
  const customerEmails = customerSide.map((p) => (p.email ?? "").toLowerCase().trim());
  if (customerEmails.length === 0) {
    return { created: false, reason: "no customer-side attendee on the call" };
  }

  // Has the rep already followed up themselves? ONLY ASKED ON A RETRY.
  //
  // A draft exists to save a job, not to duplicate one that is done. On
  // 2026-08-13 three of Ariel's drafts failed transiently and he wrote all
  // three himself within hours; a retry that ignored that would have dropped
  // near-duplicates into his Outlook the next day. This check is what stops the
  // retry being worse than the failure, which is the only thing it was built
  // for.
  //
  // Applying it to the FIRST attempt inverts it. Steven Johnson, 2026-08-27:
  // "I don't really get any of the drafts. I think I've gotten one." He is the
  // fastest follow-up on the team and sends his own thanks-for-connecting
  // within minutes, so on four of his five captured calls the check fired and
  // held the draft. The rule punished the rep who does the right thing quickest
  // and denied it to the one who wanted it most. A first attempt now always
  // writes the draft and the rep decides whether to use it, which is the whole
  // premise: it is a starting point, not a send.
  //
  // A mailbox we could not read returns nothing, which must NOT be read as "no
  // follow-up happened". Failing to check is a reason to hold off on a RETRY,
  // not a licence to write one.
  const callEnd = args.isRetry && args.callDate ? new Date(args.callDate) : null;
  if (callEnd && !Number.isNaN(callEnd.getTime())) {
    const { listMailboxMessages, domainOf: domOf } = await import("./graph-mail");
    const domains = Array.from(new Set(customerEmails.map((e) => domOf(e)).filter(Boolean))) as string[];
    try {
      const msgs = await listMailboxMessages({
        tenantIdOrDomain: "magaya.com",
        mailbox,
        since: callEnd,
        domains,
        maxPages: 3,
      });
      const already = msgs
        // A calendar invite is not a follow-up. See MailMessage.isMeetingMessage:
        // Outlook files invites in the mailbox as outbound messages to the
        // customer's domain, and a rep who books the next meeting on the call
        // and sends the invite would otherwise be read as having already
        // written. That rep is the one who most wants the draft.
        .filter((m) => m.outbound && !m.isMeetingMessage)
        .find((m) => [...m.to, ...m.cc].some((a) => domains.includes(domOf(a) ?? "")));
      if (already) {
        return {
          created: false,
          reason: `rep already emailed the customer after this call ("${already.subject}"), so no draft was written`,
        };
      }
    } catch (err) {
      return {
        created: false,
        reason: `could not read ${mailbox} to check whether the rep already followed up (${
          err instanceof Error ? err.message : String(err)
        }); holding off rather than risking a duplicate`,
      };
    }
  }

  // First names of the customer-side attendees, for the greeting. Same filter
  // that decides who receives the mail, so the greeting and the address line
  // cannot disagree about who this email is for.
  const recipients = customerSide
    .map((p, i) => {
      const name = (p.name ?? "").trim();
      if (name) return name.split(/\s+/)[0];
      const local = customerEmails[i].split("@")[0].split(/[._-]/)[0];
      return local ? local.charAt(0).toUpperCase() + local.slice(1) : "";
    })
    .filter(Boolean)
    .join(", ");

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
  // Supabase reports failure in the result, so `conn.data?.id ?? null` turns a
  // failed lookup into "this rep has no connected calendar", and the draft is
  // then composed as though there were no calendar to check. Four of the six
  // reps do have one. Say which case this is.
  if (conn.error) {
    console.warn(
      `[followup-draft] calendar connection lookup failed for ${mailbox}, drafting as though they have no calendar: ${conn.error.message}`,
    );
  }

  const draftAccountName = await crmCustomerName(args.dealId);

  const res = await createFollowUpDraft({
    mailbox,
    customerDomains: customerDomainsFor(customerEmails),
    customerEmails,
    account: args.account,
    // The CRM's spelling for the subject line, resolved once here rather than
    // trusted from `account`, which is our own deal key. Failure is silent and
    // simply leaves the name off, since a subject with no company name is a
    // findability problem and a subject with the wrong one reaches a customer.
    customerName: draftAccountName,
    summary: args.summary,
    agreed: args.agreed,
    attendees: args.attendees,
    recipients: recipients || undefined,
    callDate: args.callDate ?? null,
    calendarConnectionId: conn.data?.id ?? null,
    callSubtype: args.callSubtype ?? null,
  });
  if (!res.created || !res.draft) return { created: false, reason: res.reason ?? "draft not created" };

  // TELL THE REP IT EXISTS, with a link straight into it.
  //
  // Everything below this line is best effort and must never turn a written
  // draft into a failure: the draft is the product, this is a pointer to it.
  //
  // The subject is READ BACK from the mailbox rather than taken from
  // res.draft.subject. On a reply Graph replaces ours with the thread's, so the
  // draft Ariel Rodriguez spent twenty minutes hunting was called "RE: Magaya /
  // Grupo Orvia (Cost/Budget)" while every record we held said "Following up on
  // our call". Printing our version in the notification would send him looking
  // for a subject that does not exist, which is the exact bug this email is
  // meant to end.
  void notifyDraftReady({
    tenantId: args.tenantId,
    dealId: args.dealId,
    callId: args.callId,
    mailbox,
    account: draftAccountName ?? args.account,
    to: res.draft.to,
    generatedSubject: res.draft.subject,
    body: res.draft.body,
    webLink: res.webLink ?? null,
    internetMessageId: res.draftId ?? null,
    // Central, because Magaya works Central and a rep reading "1:00 PM" wants
    // their own clock. See lib/graph-time.ts for why this is never left to the
    // reader's locale.
    meetingWhen: args.callDate ? formatMeetingWhen(args.callDate) : null,
  }).catch((err: unknown) => {
    console.warn(`[followup-draft] draft-ready notice failed for ${args.account}: ${err instanceof Error ? err.message : err}`);
  });

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
    // GRAPH'S DRAFT ID, in the provider column.
    //
    // Not an overload: for a draft, Graph IS the provider. Nothing was emailed,
    // so there is no Resend id to conflict with, and all 39 existing
    // followup_draft rows carry null here.
    //
    // This is what turns "did the rep send our draft" from a guess into a join.
    // Until now the id was returned by createDraft and discarded one line
    // later, so adoption could only be inferred from time and recipient.
    providerId: res.draftId ?? null,
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
