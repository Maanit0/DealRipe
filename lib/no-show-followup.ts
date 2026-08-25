/**
 * No-show follow-up, drafted into the rep's own Outlook.
 *
 * WHAT THIS USED TO BE, AND WHY THAT WAS NOT ENOUGH.
 *
 * It generated a warm paragraph and emailed it TO THE REP as a formatted
 * preview to copy out by hand. Two things were wrong with that, and both showed
 * up in the same artifact (ABI Connect, 2026-08-25):
 *
 * 1. It ended "Would you like to pick a new time, or is there anything else I
 *    can help answer over email?" We hold the rep's calendar. Asking a customer
 *    who has already failed to show up to go and find a time is handing the
 *    work back to the person who just dropped it. Two or three real openings
 *    turn a rescheduling into a reply.
 *
 * 2. It arrived as a picture of an email in a different email. The post-call
 *    follow-up has landed in the rep's Outlook drafts since it shipped, which
 *    is the only form a rep actually sends. A no-show follow-up is more time
 *    sensitive than a recap, not less.
 *
 * So this now does what the post-call path does: real openings from the rep's
 * calendar, the rep's own voice from their sent mail, a draft on the customer
 * thread. Never sent. We hold Mail.ReadWrite and deliberately not Mail.Send.
 *
 * The rep-facing preview email remains as the FALLBACK, for a mailbox that is
 * not on the Graph allowlist or a Graph call that fails. Handing the rep
 * nothing because the good path was unavailable would be a regression on the
 * thing this replaced.
 */

import { runModel } from "./model-run";
import { renderNoShowDraftEmail } from "./emails/no-show-draft";
import {
  customerDomainsFor,
  findCustomerThread,
  freeSlots,
  learnSignature,
  readExistingMeetingWith,
  voiceSamples,
  type ProposedSlot,
} from "./followup-draft";
import { repName } from "./display-names";
import {
  allowedMailboxes,
  createDraft,
  createReplyDraft,
  domainOf,
  listMailboxMessages,
} from "./graph-mail";
import { MailerConfigError, sendEmail } from "./mailer";
import { repEmailForDeal } from "./pilot-config";
import { recordSentMessage } from "./sent-messages";
import { supabaseAdmin } from "./supabase";

const GRAPH_TENANT = "magaya.com";

/**
 * The Outlook path is OFF until switched on.
 *
 * A draft appearing in a rep's own drafts folder is a change they can see, and
 * the standing rule on this pilot is that Mark and the six reps hear about
 * anything visible before it happens. The post-call draft has been landing in
 * their Outlook for weeks so the mechanism is familiar, but a no-show draft is
 * new and arrives at a moment the rep is already reacting to.
 *
 * Unset, this falls back to emailing the rep the text, which is exactly what
 * shipped before. Set NO_SHOW_OUTLOOK_DRAFT_ENABLED=1 once the reps have been
 * told.
 */
function outlookDraftEnabled(): boolean {
  return (process.env.NO_SHOW_OUTLOOK_DRAFT_ENABLED ?? "").trim() === "1";
}

export type NoShowDraft = { subject: string; body: string };

export type NoShowResult = {
  /** True when something reached the rep: an Outlook draft, or the fallback email. */
  sent: boolean;
  to?: string;
  reason?: string;
  /** How it reached them, so a log distinguishes the good path from the fallback. */
  delivery?: "outlook_draft" | "rep_email" | "none";
  /** The generated text, so a preview can show it without writing anything. */
  draft?: NoShowDraft;
};

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

// =====================================================================
// How this rep has handled a missed meeting before
// =====================================================================

/**
 * Phrases a rep uses when a meeting did not happen.
 *
 * Deliberately narrow and literal. A loose pattern pulls in "missed the
 * deadline" and "we should reschedule the kickoff", and a voice sample that is
 * not actually a no-show email teaches the model the wrong register for the one
 * email where register is the whole product.
 */
const NO_SHOW_PHRASES: ReadonlyArray<RegExp> = Object.freeze([
  /\bmissed (you|each other|our call|the call|our meeting)\b/i,
  /\bwe (must have )?(just )?missed\b/i,
  /\bsorry (we|i) (missed|did not|didn't)\b/i,
  /\b(did ?n[o']?t|couldn'?t) connect\b/i,
  /\bwas ?n[o']?t able to (join|make it)\b/i,
  /\bhad trouble (joining|connecting)\b/i,
  /\bcatch you (on|at) (the|our)\b/i,
  /\breschedul/i,
  /\bfind (another|a new|a better) time\b/i,
]);

export type VoiceRead =
  /** Samples of this rep writing after a missed meeting. The best case. */
  | { status: "no_show_samples"; samples: string[] }
  /** No missed-meeting mail found, so their ordinary customer voice. */
  | { status: "general_samples"; samples: string[] }
  /** The mailbox was read and holds nothing usable. */
  | { status: "no_samples"; samples: [] }
  /** The mailbox could not be read. NOT the same as the rep having no voice. */
  | { status: "unavailable"; samples: []; error: string };

/**
 * How this rep writes when a meeting did not happen.
 *
 * Their own past no-show emails first, because that is the exact register and
 * every rep has their own: some open with an apology, some assume good faith,
 * some go straight to a time. Falling back to general customer mail is right,
 * but the two are reported separately, since a draft written from the general
 * pool is a weaker claim about voice and the log should say so.
 */
export async function readNoShowVoice(mailbox: string): Promise<VoiceRead> {
  try {
    const msgs = await listMailboxMessages({
      tenantIdOrDomain: GRAPH_TENANT,
      mailbox,
      since: new Date(Date.now() - 365 * 86_400_000),
      maxPages: 6,
    });
    const me = domainOf(mailbox);
    const hits = msgs
      .filter((m) => m.outbound)
      .filter((m) => [...m.to, ...m.cc].some((r) => domainOf(r) && domainOf(r) !== me))
      .filter((m) => NO_SHOW_PHRASES.some((re) => re.test(`${m.subject}\n${m.preview}`)))
      .slice(0, 4)
      .map((m) => `Subject: ${m.subject}\n${m.preview}`);
    if (hits.length > 0) return { status: "no_show_samples", samples: hits };
  } catch (err) {
    return { status: "unavailable", samples: [], error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const general = await voiceSamples(mailbox);
    if (general.length > 0) return { status: "general_samples", samples: general };
    return { status: "no_samples", samples: [] };
  } catch (err) {
    return { status: "unavailable", samples: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// =====================================================================
// The draft
// =====================================================================

/**
 * The register, written down rather than described.
 *
 * Maanit's own words for what this email is: warm, short, assumes good faith,
 * and proposes times instead of asking whether they would like to propose some.
 * Kept verbatim in the prompt because "concise and warm" is an instruction the
 * model interprets and an example is an instruction it copies.
 */
const REGISTER_EXAMPLE = `Hi Carla,

I noticed we missed each other on our call today, and I completely understand that things come up. I wanted to make sure everything is okay on your end, and there are no worries on mine. If you are still interested, I am happy to find a time that works better for you. Would any of these work?

Tuesday September 1 at 10:00 AM
Wednesday September 2 at 2:00 PM
Thursday September 3 at 11:00 AM

Happy to send an invite for whichever suits, and if none of them work just tell me what does.`;

export async function generateNoShowDraft(args: {
  account: string;
  contactName: string | null;
  slots: ReadonlyArray<ProposedSlot>;
  /** A meeting already on the rep's calendar with this customer, if any. */
  alreadyBooked?: string | null;
  voice?: VoiceRead;
  repFirstName?: string | null;
  signature?: string | null;
  context?: string;
}): Promise<NoShowDraft | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const system = `You draft a short follow-up email FROM a B2B sales rep TO a customer who did not join a scheduled call.

WHAT THIS EMAIL IS FOR. Getting the meeting back on the calendar. Everything else is warmth around that.

Rules:
- No em-dashes or en-dashes anywhere. Use commas or periods. Hard rule.
- Short. Four to six sentences plus the times. Warm, confident, direct. Never guilt-tripping, never apologetic on the rep's behalf, never salesy filler, never "I hope this email finds you well".
- Assume good faith out loud. Things come up, no worries on our end.
- PROPOSE THE TIMES YOU ARE GIVEN, each on its own line, exactly as written. Do not invent, adjust or reword a time, and do not offer a time you were not given: these come from the rep's real calendar and a time they cannot honour is worse than no time at all.
- Never end by asking whether they would like to pick a new time. That hands the scheduling back to the person who just missed the call. End by offering to send the invite, and by asking what works if none of these do.
- Do not invent facts, numbers, deal specifics or reasons they missed the call.
- Use the contact's first name if given.
- Do NOT write a signature or sign-off; one is appended.
- The subject is at most six words and reads like a person wrote it: "Missed you today, Karla", "Sorry we missed each other". Never the account name, never a label like "Missed Connection", never a colon.

THE REGISTER, as an example rather than a description. Match this tone and this length:
${REGISTER_EXAMPLE}

Return a single JSON object, no prose, no markdown fences:
{ "subject": string, "body": string }`;

  const slotLines = args.slots.map((s) => s.label);
  const voiceBlock =
    args.voice && args.voice.samples.length > 0
      ? [
          args.voice.status === "no_show_samples"
            ? `HOW THIS REP HAS WRITTEN AFTER A MISSED MEETING BEFORE. Match this voice, not the example's wording:`
            : `HOW THIS REP WRITES TO CUSTOMERS. No missed-meeting mail of theirs was found, so match the register loosely:`,
          ...args.voice.samples.map((s, i) => `--- sample ${i + 1} ---\n${s}`),
        ].join("\n")
      : "";

  const user = [
    `ACCOUNT: ${args.account}`,
    args.contactName
      ? `CONTACT: ${args.contactName} (use the first name "${firstName(args.contactName)}")`
      : `CONTACT: unknown (open with a warm, name-free greeting)`,
    args.context ? `CONTEXT: ${args.context}` : "",
    args.alreadyBooked
      ? `ALREADY REBOOKED: the rep's calendar already holds a meeting with this customer on ${args.alreadyBooked}. Do NOT propose any times. Acknowledge the miss, say you are set for that time, and keep it to three sentences.`
      : slotLines.length > 0
        ? `TIMES THE REP IS FREE, use these verbatim, one per line:\n${slotLines.map((l) => `- ${l}`).join("\n")}`
        : `NO TIMES AVAILABLE: the rep's calendar could not be read or holds no clean openings. Do NOT invent times. Ask what their next few days look like and offer to work around them.`,
    voiceBlock,
    ``,
    `Write the follow-up JSON. Return JSON only.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const resp = await runModel({
      task: "no_show_draft",
      maxTokens: 700,
      temperature: 0.4,
      system,
      messages: [{ role: "user", content: user }],
    });
    const block = resp.message.content.find((b) => b.type === "text");
    const text = block && "text" in block ? block.text : "";
    const s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    const o = JSON.parse(s) as { subject?: string; body?: string };
    if (typeof o.subject !== "string" || typeof o.body !== "string") return null;

    // AUTO-FIX, never regenerate. Same tiering the briefing linter uses: a dash
    // substitution is exact and lossless, and re-running a model over one
    // character is absurd.
    const clean = (v: string) => v.replace(/\s*[—–]\s*/g, ", ");
    const sig = (args.signature ?? "").trim() || (args.repFirstName ? `Thanks,\n${args.repFirstName}` : "");
    const body = sig ? `${clean(o.body).trim()}\n\n${sig}` : clean(o.body).trim();
    return { subject: clean(o.subject), body };
  } catch (err) {
    console.warn(
      `[no-show] draft generation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// =====================================================================
// Orchestration
// =====================================================================

/**
 * Draft a no-show follow-up into the rep's Outlook. Returns a reason instead of
 * throwing, so the transcript-sync pipeline is never affected.
 *
 * Skips a call with no customer stakeholder, which is how internal placeholders
 * stay out of a rep's drafts folder.
 */
export async function draftNoShowFollowup(args: {
  tenantId: string;
  callId: string;
  /** Archive to sent_messages, write nothing to Outlook and email nobody. */
  dryRun?: boolean;
  /**
   * Generate and return the text, writing NOTHING anywhere.
   *
   * Also bypasses the two "someone already handled this" guards, since the
   * point of a preview is to read what today's code produces for a call that
   * has usually already been drafted for. Never use it on the live path.
   */
  previewOnly?: boolean;
}): Promise<NoShowResult> {
  const db = supabaseAdmin();

  const call = await db
    .from("calls")
    .select("id, deal_id, participants, scheduled_start, call_date")
    .eq("tenant_id", args.tenantId)
    .eq("id", args.callId)
    .maybeSingle();
  if (call.error || !call.data?.deal_id) {
    return { sent: false, delivery: "none", reason: `call ${args.callId} not found or has no deal` };
  }

  const deal = await db
    .from("deals")
    .select("id, account, external_id, rep_email, industry")
    .eq("tenant_id", args.tenantId)
    .eq("id", call.data.deal_id)
    .maybeSingle();
  if (deal.error || !deal.data) {
    return { sent: false, delivery: "none", reason: `deal for call ${args.callId} not found` };
  }

  const mailbox = (repEmailForDeal(deal.data.external_id ?? "") ?? deal.data.rep_email ?? "").trim().toLowerCase();
  if (!mailbox) return { sent: false, delivery: "none", reason: `no rep email for deal ${deal.data.external_id}` };

  // Already drafted for this call. The idempotency marker is the archive row,
  // the same way the post-call draft does it, so a transcript-sync retry cannot
  // put two near-identical apologies in a rep's drafts folder.
  const prior = await db
    .from("sent_messages")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("call_id", args.callId)
    .eq("kind", "no_show_draft")
    .limit(1);
  if ((prior.data ?? []).length > 0 && !args.previewOnly) {
    return { sent: false, delivery: "none", reason: "no-show follow-up already drafted for this call" };
  }

  // A customer stakeholder must exist for this to be a real external no-show
  // rather than an internal placeholder.
  const contactsRes = await db
    .from("contacts")
    .select("name, relationship")
    .eq("tenant_id", args.tenantId)
    .eq("deal_id", deal.data.id);
  const contacts = (contactsRes.data ?? []) as Array<{ name: string | null; relationship: string | null }>;
  const champion = contacts.find((c) => c.relationship === "champion")?.name ?? null;
  const anyContact = champion ?? contacts.find((c) => c.name)?.name ?? null;

  const participants = Array.isArray(call.data.participants)
    ? (call.data.participants as Array<Record<string, unknown>>)
    : [];
  const customerSide = participants.filter((p) => {
    const email = typeof p.email === "string" ? p.email.toLowerCase() : "";
    const d = domainOf(email);
    return Boolean(d) && d !== "magaya.com";
  });
  const customerEmails = customerSide.map((p) => String(p.email).toLowerCase());

  let contactName = anyContact;
  if (!contactName && customerSide.length > 0) {
    const inv = customerSide[0];
    contactName = (typeof inv.name === "string" ? inv.name : null) ?? null;
  }
  if (!anyContact && customerSide.length === 0) {
    return {
      sent: false,
      delivery: "none",
      reason: "no customer stakeholder; skipping (likely internal placeholder)",
    };
  }

  // Domains from the invite only. The contacts table carries no address, so a
  // deal whose invite named nobody external has nothing to match a thread or a
  // booked meeting against, and an empty list means those reads are skipped
  // rather than run against the wrong company.
  const domains = customerDomainsFor(customerEmails);

  // HAS THE REP ALREADY HANDLED IT.
  //
  // A no-show is usually noticed within minutes and reps often write straight
  // away, so this fires more often here than it does after a real call. An
  // unreadable mailbox holds the draft rather than risking a duplicate: failing
  // to check is not the same as checking and finding nothing.
  const callAt = call.data.scheduled_start ?? call.data.call_date ?? null;
  const since = callAt ? new Date(callAt) : null;
  // Graph READS (has the rep already written, how do they write) are safe and
  // run either way. Only the WRITE is gated.
  const canUseGraph = allowedMailboxes().includes(mailbox);
  const canWriteDraft = canUseGraph && outlookDraftEnabled();
  if (canUseGraph && !args.previewOnly && since && !Number.isNaN(since.getTime()) && domains.length > 0) {
    try {
      const msgs = await listMailboxMessages({
        tenantIdOrDomain: GRAPH_TENANT,
        mailbox,
        since,
        domains,
        maxPages: 3,
      });
      const already = msgs
        .filter((m) => m.outbound)
        .find((m) => [...m.to, ...m.cc].some((a) => domains.includes(domainOf(a) ?? "")));
      if (already) {
        return {
          sent: false,
          delivery: "none",
          reason: `rep already emailed the customer after the missed call ("${already.subject}"), so no draft was written`,
        };
      }
    } catch (err) {
      return {
        sent: false,
        delivery: "none",
        reason: `could not read ${mailbox} to check whether the rep already reached out (${
          err instanceof Error ? err.message : String(err)
        }); holding off rather than risking a duplicate`,
      };
    }
  }

  // The rep's calendar: what is already booked, and what is genuinely open.
  const conn = await db
    .from("microsoft_connections")
    .select("id")
    .eq("user_principal_name", mailbox)
    .maybeSingle();
  if (conn.error) {
    console.warn(
      `[no-show] calendar connection lookup failed for ${mailbox}, drafting with no proposed times: ${conn.error.message}`,
    );
  }
  const connectionId = conn.data?.id ?? null;

  let alreadyBooked: string | null = null;
  let slots: ProposedSlot[] = [];
  if (connectionId) {
    // A no-show that was rescheduled on the spot is the common case, and
    // proposing three times for a meeting the customer has already rebooked is
    // the worst thing this email can do. Read the calendar first.
    const booked = await readExistingMeetingWith(connectionId, domains);
    if (booked.status === "found") {
      alreadyBooked = booked.meeting.label;
    } else {
      if (booked.status === "unavailable") {
        console.warn(`[no-show] calendar read failed for ${mailbox}: ${booked.error}`);
      }
      slots = await freeSlots(connectionId, { count: 3 }).catch(() => [] as ProposedSlot[]);
    }
  }

  const voice = canUseGraph
    ? await readNoShowVoice(mailbox)
    : ({ status: "no_samples", samples: [] } as VoiceRead);

  const draft = await generateNoShowDraft({
    account: deal.data.account,
    contactName,
    slots,
    alreadyBooked,
    voice,
    repFirstName: repName(mailbox),
    signature: learnSignature(voice.samples, repName(mailbox)),
    context: deal.data.industry ? `The account is in: ${deal.data.industry}.` : undefined,
  });
  if (!draft) {
    return { sent: false, to: mailbox, delivery: "none", reason: "draft generation returned null" };
  }

  const detail = [
    alreadyBooked ? `already rebooked ${alreadyBooked}` : `${slots.length} times proposed`,
    `voice ${voice.status}`,
  ].join(", ");

  if (args.previewOnly) {
    return { sent: false, to: mailbox, delivery: "none", reason: `preview only, nothing written (${detail})`, draft };
  }

  const archive = renderNoShowDraftEmail({
    account: deal.data.account,
    contactName,
    callDate: callAt,
    draft,
  });

  if (args.dryRun) {
    await recordSentMessage({
      tenantId: args.tenantId,
      dealId: deal.data.id,
      callId: args.callId,
      kind: "no_show_draft",
      toEmail: mailbox,
      subject: archive.subject,
      html: archive.html,
      text: archive.text,
      providerId: null,
    });
    return { sent: false, to: mailbox, delivery: "none", reason: `dry-run: archived only (${detail})` };
  }

  // THE OUTLOOK DRAFT. On the customer thread where one exists, so the reply
  // lands in the conversation they are already reading.
  if (canWriteDraft) {
    try {
      let draftId: string | null = null;
      let onThread = false;
      const thread = domains.length > 0 ? await findCustomerThread(mailbox, domains).catch(() => null) : null;
      if (thread) {
        const res = await createReplyDraft({
          tenantIdOrDomain: GRAPH_TENANT,
          mailbox,
          messageId: thread.id,
          body: draft.body,
          // Graph's createReply addresses whoever sent the LAST message on the
          // thread, which on a BDR-booked meeting is the BDR. The people who
          // missed the call are the people this is for.
          toRecipients: customerEmails.length > 0 ? customerEmails : undefined,
        });
        draftId = res.id;
        onThread = true;
      } else if (customerEmails.length > 0) {
        const res = await createDraft({
          tenantIdOrDomain: GRAPH_TENANT,
          mailbox,
          subject: draft.subject,
          body: draft.body,
          to: customerEmails.map((email) => ({ email })),
        });
        draftId = res.id;
      }

      if (draftId) {
        await recordSentMessage({
          tenantId: args.tenantId,
          dealId: deal.data.id,
          callId: args.callId,
          kind: "no_show_draft",
          toEmail: mailbox,
          subject: draft.subject,
          html: archive.html,
          text: draft.body,
          // GRAPH'S DRAFT ID. Nothing was emailed, so there is no Resend id to
          // conflict with, and this is what lets a later pass ask whether the
          // rep actually sent what we wrote.
          providerId: draftId,
        });
        return {
          sent: true,
          to: mailbox,
          delivery: "outlook_draft",
          reason: `${onThread ? "reply draft on the customer thread" : "new draft"} in ${mailbox} (${detail})`,
        };
      }
    } catch (err) {
      console.warn(
        `[no-show] Outlook draft failed for ${mailbox}, falling back to the rep email: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // FALLBACK. The Outlook path is switched off, the mailbox is not on the
  // allowlist, there was nobody to address, or Graph refused. Hand the rep the
  // text rather than nothing.
  try {
    const res = await sendEmail({ to: mailbox, subject: archive.subject, html: archive.html, text: archive.text });
    await recordSentMessage({
      tenantId: args.tenantId,
      dealId: deal.data.id,
      callId: args.callId,
      kind: "no_show_draft",
      toEmail: mailbox,
      subject: archive.subject,
      html: archive.html,
      text: archive.text,
      providerId: res.id || null,
    });
    return {
      sent: true,
      to: mailbox,
      delivery: "rep_email",
      reason: `${
        canUseGraph && !outlookDraftEnabled()
          ? "Outlook drafting is off (NO_SHOW_OUTLOOK_DRAFT_ENABLED unset)"
          : "no Outlook draft written"
      }, emailed the text to the rep instead (${detail})`,
    };
  } catch (err) {
    if (err instanceof MailerConfigError) {
      return { sent: false, to: mailbox, delivery: "none", reason: `mailer not configured: ${err.message}` };
    }
    return { sent: false, to: mailbox, delivery: "none", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The old name. Kept so the transcript-sync call sites read the same, and
 * because "send" is what the pipeline is doing from its own point of view.
 */
export const sendNoShowFollowup = draftNoShowFollowup;
