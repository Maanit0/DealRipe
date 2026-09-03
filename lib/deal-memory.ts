/**
 * What the deal knows, for the artifact that is about to be written.
 *
 * THE FOLLOW-UP DRAFT WAS FLYING ON THE TRANSCRIPT ALONE. Briefings and recaps
 * go through getDealContext; the draft and the re-engagement email each built
 * their own smaller context, which is why every improvement to deal memory had
 * to be made three times and never was.
 *
 * Ten draft-versus-sent pairs read on 2026-09-02 say the gap is not writing
 * quality. In every case where the rep wrote their own, they held something we
 * did not:
 *
 *   Eduardo   a EULA and a corrected proposal   we did not know they existed
 *   Daniel    Gustavo's three draft airway bills   we did not know they were sent
 *   Daniel    a discount pending manager approval  we did not know it was pending
 *   Ariel     six video links                      we held them and promised them instead
 *   Steven    Gina's reply that morning            we had not looked
 *
 * A draft can only be as good as what it knows.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM. It reports what we told the customer
 * we would do on earlier calls, and separately what has actually been sent
 * since. It does NOT assert that a commitment is still outstanding, because
 * nothing here can establish that: an email whose subject looks unrelated may
 * carry the promised file, and a commitment may have been discharged on a call
 * we never captured. The two facts are given side by side and the reader
 * decides, which is the same rule the CRM reads follow: say what was observed,
 * never what was inferred from its absence.
 */

import { readDraftAdoption } from "./draft-adoption";
import { supabaseAdmin } from "./supabase";

/**
 * Strip the mail chrome Exchange prepends to external mail.
 *
 * Magaya's tenant stamps "CAUTION: This email originated from outside your
 * organization" on every inbound message, and Outlook adds "You don't often get
 * email from x. Learn why this is important". Both land at the TOP, so an
 * excerpt taken from the top is the banner and nothing else: the first run of
 * this handed the writer a security warning under the heading "what they said".
 */
function stripMailChrome(body: string): string {
  return body
    .split("\n")
    .filter(
      (l) =>
        !/^\s*CAUTION:/i.test(l) &&
        !/originated from outside your organization/i.test(l) &&
        !/you don'?t often get email from/i.test(l) &&
        !/Learn why this is important/i.test(l) &&
        !/^\s*\[?EXTERNAL\]?\s*:?\s*$/i.test(l),
    )
    .join("\n");
}

export type PriorCommitment = {
  when: string;
  text: string;
  /**
   * Whether the draft carrying this promise actually left the mailbox.
   *
   * "sent" the customer received it, so it is a real promise and we are on the
   * hook. "unsent" it is still sitting in Drafts, so the customer never saw it
   * and offering it as already-promised would invent a commitment. "unknown"
   * Graph could not be reached or the message is gone, which is deliberately
   * NOT folded into either, because the two carry opposite instructions.
   */
  delivery: "sent" | "unsent" | "unknown";
};
export type SentItem = { when: string; subject: string; attachments: string[] };

export type DealMemory = {
  /**
   * Commitments our earlier drafts made on this deal, each carrying whether it
   * was actually sent.
   *
   * This used to say "probably said, not certainly" and hedge the whole list,
   * because nothing here could tell a sent promise from one still in Drafts.
   * It can now: the draft's internetMessageId is on sent_messages.provider_id
   * and readMessageStateByInternetId answers it in one call per draft (median
   * 1 per deal, max 3, measured 2026-09-02). The hedge was not harmless. It
   * put unsent promises in front of the model as things we had told the
   * customer, and the customer had received none of them.
   */
  toldThemWeWould: PriorCommitment[];
  /** What has actually left the rep's mailbox to them since those calls. */
  sentSince: SentItem[];
  /**
   * The customer's most recent inbound message.
   *
   * `excerpt` is FETCHED ON DEMAND AND NEVER STORED. deal_messages holds
   * metadata only, by design: Magaya is under NDA and MS_CLIENT_SECRET is
   * effectively a tenant-wide mailbox key, so bodies are not retained. This is
   * the case lib/email-log.ts reserved getMessageBody for, "when one specific
   * claim needs evidence": knowing they declined on price rewrites the entire
   * email, and a subject line cannot tell you that. Ariel's Orvia draft
   * summarised a proposal the customer had already turned down.
   */
  customerLastWrote: { when: string; subject: string; excerpt: string | null } | null;
};

/**
 * Commitment lines from a follow-up draft we wrote on an earlier call.
 *
 * NOT FROM THE RECAP. The recap's sections are WHAT HAPPENED, CAPTURED ON THIS
 * CALL, STILL OPEN and SUGGESTED NEXT STEP; the first version of this read the
 * head of that document and handed the model a list of captured qualification
 * gates labelled "what we told them we would do". Every line was true and the
 * label was false, which is worse than having nothing.
 *
 * The draft body is where a commitment actually lives: "Steven is checking
 * internally on the PCIT integration".
 */
/**
 * A first-person promise. "I'll send the pricing" and not "can we get 30
 * minutes", which is an ask.
 *
 * Deliberately narrow on the subject: only I/we, because a commitment the
 * CUSTOMER made is not something we owe and putting it here would have the
 * draft apologising for their homework.
 */
const OWED = /\b(?:i|we)(?:'ll|'m going to|'re going to| will| shall| can| am going to| are going to)\s+(?:also\s+|then\s+|go ahead and\s+)?([a-z]{2,})/i;

/**
 * Verbs that are not deliverables.
 *
 * Two groups. The first promises nothing at all ("I'll let you know"). The
 * second describes what happens ON a call, not something we hand over: "that
 * is exactly what we will walk through" is an agenda, and treating it as owed
 * had the draft chasing itself for a conversation that was the meeting.
 */
const NOT_A_DELIVERABLE =
  /^(?:let|know|be|have|look forward|hope|think|say|note|mention|add|assume|imagine|expect|understand|see|leave|keep|accommodate)$|^(?:walk|discuss|go|cover|talk|meet|chat|review|dive|explore|revisit|touch|circle|dig)$/i;

/**
 * A request to THEM, which is the mirror of a commitment and never ours.
 *
 * "Bramwell, when you get a chance, please send me a sample file" is the
 * customer's homework. Recorded as something we owed, it produced a draft
 * apologising for work the customer had not done. Anything that asks is
 * dropped unless the same sentence also carries an explicit "I'll" or "we'll",
 * which is the shape of a genuine trade: "send me the file and I'll get you
 * the quote".
 */
const ASKS_THEM = /\b(?:please|could you|can you|would you|if you could|when you get a chance|on your end)\b/i;
const CLEARLY_OURS = /\b(?:i|we)(?:'ll|'m going to|'re going to| will)\b/i;

// Exported so a fire-rate check imports THIS and cannot drift from it.
export function commitmentBullets(draftText: string): string[] {
  const body = draftText
    // A signature block is not a commitment, and Alexandra's carries a phone
    // number that sentence-splits into fragments.
    .split(/\n\s*(?:Kindly|Best|Thanks|Thank you|Regards|Sincerely|Cheers)\b/i)[0];

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    const key = t.toLowerCase();
    if (t.length < 12 || t.length > 220 || seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    // Bullets were the original and only source. They survive as-is: a rep
    // who bulleted a next step meant it as one.
    if (/^[-*•]\s+/.test(line)) {
      const b = line.replace(/^[-*•]\s+/, "");
      // Ours, not theirs. "Debra will send the org chart" is not something we owe.
      const theirs =
        /^(they|the customer|[A-Z][a-z]+ (will|is going to) (send|share|provide|get back))/i.test(b) ||
        (ASKS_THEM.test(b) && !CLEARLY_OURS.test(b));
      if (!theirs) push(b);
      continue;
    }

    // 39 of 40 drafts measured 2026-09-02 carried no bullet at all, so reading
    // only bullets found commitments on ONE deal in the book and the whole
    // memory was inert. Reps write prose. Split into sentences and keep the
    // ones where we promised something.
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const t = sentence.trim();
      // A question is an ask, not a promise. "Can we get 30 minutes on the
      // calendar" is the single most common line in these drafts and it owes
      // the customer nothing.
      if (!t || t.endsWith("?")) continue;
      if (ASKS_THEM.test(t) && !CLEARLY_OURS.test(t)) continue;
      const m = OWED.exec(t);
      if (!m || NOT_A_DELIVERABLE.test(m[1])) continue;
      push(t);
    }
  }
  return out.slice(0, 6);
}

export async function readDealMemory(args: {
  tenantId: string;
  dealId: string;
  /** The call being written about. Everything before it is history. */
  beforeCallId?: string | null;
}): Promise<DealMemory> {
  const db = supabaseAdmin();
  const empty: DealMemory = { toldThemWeWould: [], sentSince: [], customerLastWrote: null };

  try {
    const [recaps, msgs] = await Promise.all([
      db
        .from("sent_messages")
        .select("call_id, body_text, sent_at, provider_id, to_email")
        .eq("deal_id", args.dealId)
        .eq("kind", "followup_draft")
        .order("sent_at", { ascending: false })
        .limit(6),
      db
        .from("deal_messages")
        .select("direction, subject, sent_at, graph_message_id, mailbox, from_domain, customer_side")
        .eq("tenant_id", args.tenantId)
        .eq("deal_id", args.dealId)
        .order("sent_at", { ascending: false })
        .limit(40),
    ]);

    const toldThemWeWould: PriorCommitment[] = [];
    const priorDrafts = ((recaps.data ?? []) as Array<{
      call_id: string | null;
      body_text: string | null;
      sent_at: string;
      provider_id: string | null;
      to_email: string | null;
    }>)
      // The call being written about is not history for itself.
      .filter((r) => !(args.beforeCallId && r.call_id === args.beforeCallId))
      .map((r) => ({ row: r, bullets: commitmentBullets(r.body_text ?? "") }))
      .filter((d) => d.bullets.length > 0);

    // WHETHER EACH PROMISE ACTUALLY REACHED THE CUSTOMER, from the production
    // verdict rather than a second opinion.
    //
    // The obvious implementation is to look the draft's Message-ID up in the
    // mailbox and see whether it is still a draft. It does not work, and it
    // fails in the direction that matters: Graph REASSIGNS the id when a draft
    // is sent, so the id 404s on precisely the outcome being measured and every
    // sent draft reads as still sitting there. Written that way first, it
    // returned sent=0 across 18 deals against a known adoption rate near a
    // third. lib/draft-adoption.ts already carries the answer, content match and
    // all, so this calls it instead of re-deriving it.
    const domains = Array.from(
      new Set(
        ((msgs.data ?? []) as Array<{ customer_side: boolean | null; from_domain: string | null }>)
          .filter((r) => r.customer_side === true && r.from_domain)
          .map((r) => (r.from_domain as string).toLowerCase()),
      ),
    );
    const delivery = await Promise.all(
      priorDrafts.map(async ({ row }): Promise<PriorCommitment["delivery"]> => {
        // provider_id is the draft's Message-ID and to_email is the mailbox it
        // was created in, which is the REP's own address: a draft is written
        // into the rep's Drafts folder, not sent anywhere.
        if (!row.provider_id || !row.to_email) return "unknown";
        try {
          const { verdict } = await readDraftAdoption({
            dealId: args.dealId,
            account: "",
            callId: row.call_id,
            kind: "followup_draft",
            mailbox: row.to_email,
            draftId: row.provider_id,
            draftText: row.body_text ?? "",
            draftedAt: row.sent_at,
            domains,
          });
          // sent_ours and sent_edited both put OUR words in front of the
          // customer, so the promise landed. sent_own did not: the rep wrote
          // their own message and nothing here knows whether it carried this
          // particular commitment, which is a genuine "did not check" and is
          // kept apart from both answers rather than rounded to either.
          if (verdict === "sent_ours" || verdict === "sent_edited") return "sent";
          if (verdict === "not_sent") return "unsent";
          return "unknown";
        } catch {
          return "unknown";
        }
      }),
    );

    priorDrafts.forEach(({ row, bullets }, i) => {
      for (const b of bullets) {
        toldThemWeWould.push({ when: row.sent_at.slice(0, 10), text: b, delivery: delivery[i] });
      }
    });

    const rows = (msgs.data ?? []) as Array<{
      direction: string;
      subject: string | null;
      sent_at: string;
      graph_message_id: string | null;
      mailbox: string | null;
      from_domain: string | null;
      customer_side: boolean | null;
    }>;
    // Deduped on the day and the thread, not on the row. A co-sold deal is
    // ingested once per rep mailbox, so one message becomes three rows and the
    // block printed "RE: Magaya SOW preparation" three times for one send.
    // Reply prefixes are stripped for the same reason: RE: and FW: of the same
    // subject on the same day are one thread, and listing them separately
    // reads as three pieces of outreach where there was one.
    const seenSends = new Set<string>();
    const sentSince: SentItem[] = [];
    for (const m of rows) {
      if (m.direction !== "outbound") continue;
      const subject = m.subject ?? "(no subject)";
      const thread = subject.replace(/^\s*(?:re|fw|fwd)\s*:\s*/gi, "").trim().toLowerCase();
      const key = `${m.sent_at.slice(0, 10)}|${thread}`;
      if (seenSends.has(key)) continue;
      seenSends.add(key);
      sentSince.push({ when: m.sent_at.slice(0, 10), subject, attachments: [] });
      if (sentSince.length >= 8) break;
    }
    // INBOUND IS NOT THE SAME AS FROM THE CUSTOMER. Dunavant has two Magaya
    // reps on it, so Eduardo's own email to Debra is ingested as INBOUND in
    // Steven's mailbox. The first version of this quoted a colleague's outbound
    // back to the writer under the heading "what they said", which is the house
    // failure exactly: a true row under a false label. customer_side is the
    // column that actually answers it.
    const inbound = rows.find(
      (m) => m.direction === "inbound" && m.customer_side === true && (m.from_domain ?? "") !== "magaya.com",
    );

    // ONE MESSAGE, ON DEMAND, NOT RETAINED. The most recent inbound only:
    // pulling a thread's worth of bodies to summarise a deal would be exactly
    // the retention the metadata-only design exists to avoid.
    let excerpt: string | null = null;
    if (inbound?.graph_message_id && inbound.mailbox) {
      try {
        const { getMessageBody } = await import("./graph-mail");
        const body = await getMessageBody({
          tenantIdOrDomain: "magaya.com",
          mailbox: inbound.mailbox,
          messageId: inbound.graph_message_id,
        });
        if (body) {
          // Above the quoted reply. Everything below it is our own last email
          // coming back, which tells the writer nothing and costs tokens.
          const clean = stripMailChrome(body);
          const cut = clean.search(/\n\s*(From:|On .+ wrote:|-{5,})/);
          excerpt = (cut > 0 ? clean.slice(0, cut) : clean).replace(/\s+/g, " ").trim().slice(0, 900) || null;
        }
      } catch {
        // A body we could not read is not an empty message. Subject and date
        // still stand, and the block says only what it actually has.
        excerpt = null;
      }
    }

    return {
      toldThemWeWould: toldThemWeWould.slice(0, 8),
      sentSince,
      customerLastWrote: inbound
        ? { when: inbound.sent_at.slice(0, 10), subject: inbound.subject ?? "(no subject)", excerpt }
        : null,
    };
  } catch {
    // A memory we could not read is not an empty deal history. The caller
    // renders nothing rather than telling the model the deal has no past.
    return empty;
  }
}

/** The memory as prompt text, or null when there is nothing worth saying. */
export function dealMemoryBlock(m: DealMemory): string | null {
  const parts: string[] = [];
  const lines = (kind: PriorCommitment["delivery"]) =>
    m.toldThemWeWould.filter((c) => c.delivery === kind).map((c) => `- ${c.when}: ${c.text}`);

  // Sent, unsent and unknown are three different instructions to the writer, so
  // they are three blocks. Merging them is what the old single hedged list did,
  // and it put promises the customer never received in front of the model as
  // things we had said.
  const promised = lines("sent");
  if (promised.length > 0) {
    parts.push(
      `WHAT WE TOLD THIS CUSTOMER WE WOULD DO. These went out and they have them, so we are on the hook for each one. If the send history below does not show it landing, say where it is or say when it will be, and never repeat the promise as if it were new:\n` +
        promised.join("\n"),
    );
  }

  const unsent = lines("unsent");
  if (unsent.length > 0) {
    parts.push(
      `DRAFTED ON AN EARLIER CALL AND NEVER SENT. The customer has NOT seen any of this. Do not write "as promised" or "as I mentioned" about it, and do not treat it as owed. It is here for one reason: it is what we meant to do and did not, so if it is still the right move, make it now as a first offer rather than a follow-up:\n` +
        unsent.join("\n"),
    );
  }

  const unsure = lines("unknown");
  if (unsure.length > 0) {
    parts.push(
      `WE OWE THEM THIS, and we could not check whether it was already sent. CARRY IT FORWARD, do not drop it: an open item nobody mentions again is how a deal goes quiet, and this is the most common state for a commitment made in the last few days, which is exactly when it still matters. What you must not do is assert which it is. Never write "as promised" or "as I sent over", and never re-offer it as brand new either. Give them the status and the next date, which reads correctly whether or not they already have it:\n` +
        unsure.join("\n"),
    );
  }
  if (m.sentSince.length > 0) {
    parts.push(
      `WHAT THE REP HAS ALREADY SENT THIS CUSTOMER, most recent first. Subjects only, so a file may have ridden on any of them:\n` +
        m.sentSince.map((s) => `- ${s.when}: ${s.subject}`).join("\n"),
    );
  }
  if (m.customerLastWrote) {
    parts.push(
      `THE CUSTOMER LAST WROTE on ${m.customerLastWrote.when}, subject "${m.customerLastWrote.subject}". If that is after the call, the conversation has moved and this email must meet it where it is rather than recapping a moment that has passed.` +
        (m.customerLastWrote.excerpt ? `\n\nWhat they said:\n${m.customerLastWrote.excerpt}` : ``),
    );
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}
