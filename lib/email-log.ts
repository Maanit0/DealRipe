/**
 * Persist email metadata per deal, and read engagement from it.
 *
 * WHAT THIS CHANGES
 *
 * DealRipe has been reading the mailbox since before the pilot and keeping
 * none of it. Three callers use lib/graph-mail.ts and every one of them reads
 * per call, uses the result once and discards it. So "the customer has gone
 * quiet" and "we never looked at the mailbox" are currently the same absence,
 * and lib/deal-signals-buyer.ts says so on every stalling verdict: ten deals
 * are flagged as losing momentum with the caveat that this counts calls only.
 *
 * With the log, silence becomes a measurement instead of a guess.
 *
 * WHAT IT DELIBERATELY DOES NOT STORE
 *
 * Bodies. Magaya is under NDA and MS_CLIENT_SECRET is effectively a
 * tenant-wide mailbox key because the Application Access Policy was declined,
 * so allowedMailboxes() in software is the only boundary. Metadata answers
 * every signal here. getMessageBody fetches a body on demand when one specific
 * claim needs evidence, and it is not retained.
 *
 * TWO THINGS THAT LOOK LIKE ENGAGEMENT AND ARE NOT
 *
 *   A calendar auto-response. "Accepted: Magaya Demo" is a mail client
 *   answering, not a person. isCalendarResponseSubject already exists for this
 *   and is applied at ingest so no consumer has to remember.
 *
 *   Our own outbound. A rep emailing into silence is the opposite of the
 *   customer engaging, so direction is stored and the engagement reads count
 *   only what came back.
 */

import type { Database } from "./database.types";
import { domainOf, isCalendarResponseSubject, listMailboxMessages, type MailMessage } from "./graph-mail";
import { supabaseAdmin } from "./supabase";

/** Free-mail domains never identify a company. CLAUDE.md: matching %@gmail.com
 *  once returned an unrelated company's account, so a deal whose only customer
 *  contact is free-mail cannot be resolved by domain and is skipped rather
 *  than guessed at. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "live.com", "aol.com", "icloud.com", "me.com", "msn.com", "proton.me", "protonmail.com",
]);

export type IngestResult = {
  mailbox: string;
  messagesRead: number;
  rowsWritten: number;
  skippedNoDeal: number;
  skippedFreeMail: number;
  errors: string[];
};

/**
 * Ingest one rep's mailbox into the log, mapping each message to a deal by the
 * customer's domain.
 *
 * Domain is the only join available: Graph gives addresses, and a deal's
 * identity here is its customer domain. That is why free-mail is skipped
 * outright rather than matched loosely.
 */
export async function ingestMailbox(args: {
  tenantId: string;
  /** The Graph tenant or a domain that resolves to it. */
  graphTenant: string;
  mailbox: string;
  /** The seller's own domain, so direction and customer_side are decidable. */
  sellerDomain: string;
  since: Date;
  dryRun?: boolean;
}): Promise<IngestResult> {
  const db = supabaseAdmin();
  const out: IngestResult = {
    mailbox: args.mailbox,
    messagesRead: 0,
    rowsWritten: 0,
    skippedNoDeal: 0,
    skippedFreeMail: 0,
    errors: [],
  };

  // Build the domain -> deal map.
  //
  // NOT from contacts: that table has no email column at all, only a name and
  // a relationship. The customer's actual addresses live in calls.participants,
  // which is where followup-draft already derives customerEmails from, and in
  // deals.external_id, which for auto-created deals is literally the domain
  // ("auto:cbxglobal.com"). Using both means a deal with no captured call can
  // still be matched, which matters because 48 of 114 open deals have none.
  const seller = args.sellerDomain.trim().toLowerCase();
  const dealByDomain = new Map<string, string>();
  const ambiguous = new Set<string>();
  const claim = (domain: string | null, dealId: string) => {
    if (!domain || domain === seller || FREE_MAIL.has(domain)) return;
    const existing = dealByDomain.get(domain);
    // One domain on two deals cannot be resolved by domain alone. Recording it
    // as ambiguous and dropping it is the same discipline the account matcher
    // uses: decline rather than pick.
    if (existing && existing !== dealId) ambiguous.add(domain);
    else dealByDomain.set(domain, dealId);
  };

  const dealsRes = await db
    .from("deals")
    .select("id, external_id")
    .eq("tenant_id", args.tenantId);
  if (dealsRes.error) {
    out.errors.push(`deals read failed: ${dealsRes.error.message}`);
    return out;
  }
  for (const d of (dealsRes.data ?? []) as Array<{ id: string; external_id: string | null }>) {
    const ext = d.external_id ?? "";
    if (ext.startsWith("auto:")) claim(ext.slice(5).trim().toLowerCase() || null, d.id);
  }

  const callsRes = await db
    .from("calls")
    .select("deal_id, participants")
    .eq("tenant_id", args.tenantId);
  if (callsRes.error) {
    out.errors.push(`calls read failed: ${callsRes.error.message}`);
    return out;
  }
  for (const c of (callsRes.data ?? []) as Array<{ deal_id: string; participants: unknown }>) {
    if (!c.deal_id || !Array.isArray(c.participants)) continue;
    for (const p of c.participants as Array<Record<string, unknown>>) {
      const email = typeof p.email === "string" ? p.email : null;
      claim(domainOf(email), c.deal_id);
    }
  }
  for (const d of ambiguous) dealByDomain.delete(d);

  let messages: MailMessage[];
  try {
    messages = await listMailboxMessages({
      tenantIdOrDomain: args.graphTenant,
      mailbox: args.mailbox,
      since: args.since,
      domains: [...dealByDomain.keys()],
      maxPages: 20,
    });
  } catch (err) {
    out.errors.push(`mailbox read failed: ${err instanceof Error ? err.message : String(err)}`);
    return out;
  }
  out.messagesRead = messages.length;

  type MessageRow = Database["public"]["Tables"]["deal_messages"]["Insert"];
  const rows: MessageRow[] = [];
  for (const m of messages) {
    // Without a stable id we cannot dedupe across mailboxes, and a co-sold
    // thread would be counted once per rep. Skipping is better than counting
    // twice, because these signals are about how often the customer wrote.
    if (!m.internetMessageId) continue;

    const involved = [m.from, ...m.to, ...m.cc].filter(Boolean) as string[];
    const customerDomains = involved
      .map((a) => domainOf(a))
      .filter((d): d is string => !!d && d !== seller && !FREE_MAIL.has(d));
    if (customerDomains.length === 0) {
      if (involved.some((a) => FREE_MAIL.has(domainOf(a) ?? ""))) out.skippedFreeMail += 1;
      continue;
    }
    const dealId = customerDomains.map((d) => dealByDomain.get(d)).find(Boolean);
    if (!dealId) {
      out.skippedNoDeal += 1;
      continue;
    }

    const fromDomain = domainOf(m.from);
    rows.push({
      tenant_id: args.tenantId,
      deal_id: dealId,
      internet_message_id: m.internetMessageId,
      graph_message_id: m.id,
      mailbox: args.mailbox.toLowerCase(),
      conversation_id: m.conversationId,
      direction: m.outbound ? "outbound" : "inbound",
      from_email: m.from,
      from_domain: fromDomain,
      to_emails: m.to,
      cc_emails: m.cc,
      subject: m.subject,
      sent_at: m.at,
      is_calendar_response: isCalendarResponseSubject(m.subject),
      customer_side: !!fromDomain && fromDomain !== seller && !FREE_MAIL.has(fromDomain),
    });
  }

  if (args.dryRun) {
    out.rowsWritten = rows.length;
    return out;
  }

  // Chunked upserts so one oversized batch cannot fail the whole mailbox.
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const res = await db
      .from("deal_messages")
      .upsert(chunk, { onConflict: "tenant_id,internet_message_id,deal_id", ignoreDuplicates: true });
    if (res.error) out.errors.push(`upsert failed: ${res.error.message}`);
    else out.rowsWritten += chunk.length;
  }
  return out;
}

// =====================================================================
// Reading engagement out of the log
// =====================================================================

export type EmailEngagement = {
  /** Days since the CUSTOMER last wrote. Null when they never have. */
  daysSinceCustomerMessage: number | null;
  /** Days since we last wrote to them. Null when we never have. */
  daysSinceOurMessage: number | null;
  /** Distinct people on the customer side who have written. */
  customerWriters: number;
  /**
   * We wrote after their last message and they have not answered.
   *
   * The single most useful negative in the set, and the one no CRM can
   * produce, which is exactly what Kiddom's flag sheet says: "emailing without
   * reply needs the mailbox".
   */
  awaitingReply: boolean;
  /** Total non-calendar messages either way, for judging thread depth. */
  total: number;
  evidence: string;
};

/**
 * Engagement for one deal.
 *
 * Returns null when the log holds nothing for this deal, which the caller must
 * treat as "we have no email record" rather than "the customer is silent".
 * Those are the two facts this whole file exists to separate.
 */
export async function readEmailEngagement(args: {
  tenantId: string;
  dealId: string;
  now?: Date;
}): Promise<EmailEngagement | null> {
  const db = supabaseAdmin();
  const res = await db
    .from("deal_messages")
    .select("direction, customer_side, from_email, sent_at, is_calendar_response")
    .eq("tenant_id", args.tenantId)
    .eq("deal_id", args.dealId)
    .eq("is_calendar_response", false)
    .order("sent_at", { ascending: false })
    .limit(500);
  if (res.error || !res.data || res.data.length === 0) return null;

  const rows = res.data as Array<{
    direction: string;
    customer_side: boolean;
    from_email: string | null;
    sent_at: string | null;
  }>;
  const nowMs = (args.now ?? new Date()).getTime();
  const days = (iso: string | null): number | null => {
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? Math.floor((nowMs - t) / 86_400_000) : null;
  };

  const fromCustomer = rows.filter((r) => r.customer_side);
  const fromUs = rows.filter((r) => !r.customer_side);
  const lastCustomer = fromCustomer[0]?.sent_at ?? null;
  const lastOurs = fromUs[0]?.sent_at ?? null;

  const awaitingReply =
    !!lastOurs && (!lastCustomer || Date.parse(lastOurs) > Date.parse(lastCustomer));
  const writers = new Set(fromCustomer.map((r) => (r.from_email ?? "").toLowerCase()).filter(Boolean));

  const dCust = days(lastCustomer);
  const dOurs = days(lastOurs);
  const evidence = lastCustomer
    ? awaitingReply
      ? `we wrote ${dOurs} day(s) ago and the customer has not answered; they last wrote ${dCust} day(s) ago`
      : `the customer last wrote ${dCust} day(s) ago`
    : `${fromUs.length} message(s) sent and the customer has never written back`;

  return {
    daysSinceCustomerMessage: dCust,
    daysSinceOurMessage: dOurs,
    customerWriters: writers.size,
    awaitingReply,
    total: rows.length,
    evidence,
  };
}


/**
 * EmailEngagement rendered for the briefing prompt.
 *
 * Facts only, no verdict. The model is given what the customer DID and decides
 * what it means for this call; a pre-baked "they have gone quiet" would be a
 * judgement made without the call type, the stage or the agreed next step, all
 * of which the model has and this function does not.
 *
 * Every line is the customer's behaviour or ours, never an inference. "They
 * have not replied in 12 days" is a fact. "They are cooling" is not.
 */
export function emailLinesForBriefing(
  e: EmailEngagement | null,
  status: "present" | "no_record" | "unavailable",
): string[] {
  if (status === "unavailable") {
    return [
      `EMAIL: not read for this deal. Do NOT infer anything from silence; we did not look. Say nothing about email.`,
    ];
  }
  if (status === "no_record" || !e) {
    return [
      `EMAIL: no messages on record for this deal. That means we hold no thread, NOT that the customer has gone quiet. Say nothing about email.`,
    ];
  }
  const out: string[] = [`EMAIL, what the customer has actually done. Ranks above the CRM below and below the calls above.`];
  if (e.daysSinceCustomerMessage === null) {
    out.push(`- The customer has NEVER written to us. Every message on this deal is ours.`);
  } else {
    out.push(`- The customer last wrote ${e.daysSinceCustomerMessage} day(s) ago.`);
  }
  if (e.daysSinceOurMessage !== null) out.push(`- We last wrote ${e.daysSinceOurMessage} day(s) ago.`);
  if (e.awaitingReply) {
    out.push(
      `- WE WROTE LAST AND THEY HAVE NOT ANSWERED. This is the single most useful fact here and no CRM holds it.`,
      `  Do not open the call by asking whether they saw the email. If it is relevant, raise what was in it, not the fact of it.`,
    );
  }
  out.push(
    e.customerWriters === 0
      ? `- Nobody on the customer side has written. We are single-threaded by email.`
      : `- ${e.customerWriters} person/people on the customer side have written on this thread.`,
    `- ${e.total} message(s) on the thread in total, excluding calendar responses.`,
  );
  if (e.evidence) out.push(`- ${e.evidence}`);
  out.push(
    `Use this to judge momentum and who is engaged. Never quote an email back to the customer on the call, and never say "I see you have not replied".`,
  );
  return out;
}
