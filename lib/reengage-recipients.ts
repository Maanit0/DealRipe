/**
 * Who one re-engagement email is addressed to.
 *
 * The roster used to be the union of every non-Magaya participant across the
 * last four captured calls, unfiltered beyond the domain. Two failures on
 * 2026-08-31 came straight out of that: IFF Inc was drafted to TEN addresses on
 * a note whose first line reads "Carrie," and which asks whether she would like
 * the owner on a call "rather than working through you as the go-between", and
 * Apexcargo was drafted to `noreply@sender.zohocalendar.in`, which sat on the
 * invite as a participant.
 *
 * The model already chooses one person, in the greeting. Nothing connected that
 * choice to the To line.
 */

import { domainOf } from "./graph-mail";
import { supabaseAdmin } from "./supabase";

/**
 * Addresses no human reads.
 *
 * Matched on the LOCAL PART and on the host, because a calendar system's sender
 * domain is as reliable a tell as its mailbox name.
 */
const SYSTEM_LOCAL = /^(no-?reply|do-?not-?reply|notifications?|automated|mailer-daemon|postmaster|bounce|alerts?|calendar|invites?)([+._-]|$)/i;
const SYSTEM_HOST = /(^|\.)(sender|mail|mailer|notifications?|calendar|bounces?)\./i;

export function isSystemAddress(email: string): boolean {
  const e = email.toLowerCase().trim();
  const [local, host] = e.split("@");
  if (!local || !host) return true;
  return SYSTEM_LOCAL.test(local) || SYSTEM_HOST.test(host) || /zohocalendar|calendly|calendar\.google/.test(host);
}

export type Roster = {
  /** People who have actually written back to us, most recent first. */
  engaged: string[];
  /** People on a call who have never replied by mail, most recent call first. */
  quiet: string[];
};

/**
 * Split the roster by whether the person has ever replied.
 *
 * MEASURED, not guessed: `deal_messages` stores direction and from_email, so
 * "this person answers us" is a fact in the table rather than an inference from
 * who happened to be on an invite.
 *
 * A stale log makes everyone look quiet, which is why the caller must treat an
 * empty `engaged` as "nobody has replied OR we have not ingested", never as the
 * first alone. Ingest currently runs by hand.
 */
export async function rosterForDeal(tenantId: string, dealId: string, callParticipants: string[]): Promise<Roster> {
  const candidates = callParticipants
    .map((e) => e.toLowerCase().trim())
    .filter((e) => e.includes("@") && !isSystemAddress(e));

  const { data } = await supabaseAdmin()
    .from("deal_messages")
    .select("from_email, sent_at")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId)
    .eq("direction", "inbound")
    .order("sent_at", { ascending: false });

  const repliedAt = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ from_email: string | null; sent_at: string }>) {
    const e = (r.from_email ?? "").toLowerCase().trim();
    if (e && !repliedAt.has(e)) repliedAt.set(e, r.sent_at);
  }

  const engaged = candidates.filter((e) => repliedAt.has(e)).sort((a, b) => (repliedAt.get(b) ?? "").localeCompare(repliedAt.get(a) ?? ""));
  const quiet = candidates.filter((e) => !repliedAt.has(e));
  return { engaged, quiet };
}

/**
 * The single address this draft goes to.
 *
 * ONE PERSON, and the rest are dropped rather than cc'd. A re-engagement asks
 * something the recipient can answer alone, and half of them are questions the
 * person would not want their colleagues reading.
 *
 * `invited_but_silent` INVERTS the rule and is the whole reason the roster is
 * split rather than sorted. That flag exists to reach the person who sat in the
 * room and never spoke, so the best recipient is the one who has NOT written
 * back. Sending it to the account's most talkative contact asks the wrong human
 * a question only the quiet one can answer.
 */
export function pickRecipient(roster: Roster, flagId: string): string | null {
  const order = flagId === "invited_but_silent" ? [...roster.quiet, ...roster.engaged] : [...roster.engaged, ...roster.quiet];
  return order[0] ?? null;
}

/** Non-Magaya, non-system addresses from the deal's captured calls. */
export function customerCandidates(participants: string[], sellerDomain: string): string[] {
  const out = new Set<string>();
  for (const raw of participants) {
    const e = (raw ?? "").toLowerCase().trim();
    if (!e.includes("@")) continue;
    if (domainOf(e) === sellerDomain) continue;
    if (isSystemAddress(e)) continue;
    out.add(e);
  }
  return [...out];
}
