/**
 * Should DealRipe join this meeting at all?
 *
 * Auto-join used to mean "any external attendee who is not on a denylist".
 * That inverts the burden: someone has to predict every non-customer a rep
 * will ever meet. It survived a two-rep pilot because both calendars were
 * known by name. It does not survive six reps, where the calendars contain
 * 1-on-1s with a VP, benefits calls, candidate interviews and personal
 * appointments that nobody has enumerated.
 *
 * So the test is inverted too: join only where there is POSITIVE evidence this
 * is a commercial conversation. Mark described the motion himself, a BDR takes
 * a lead, creates the Account in Salesforce, fills the Sales Development
 * section, and only then does the rep take the call. So a real sales meeting
 * almost always has a CRM record standing behind it before it starts, and that
 * record is the evidence.
 *
 * The failure modes are deliberately asymmetric. Skipping a real sales call
 * costs one missing recap that a rep will mention. Joining an interview or a
 * 1-on-1 is an incident that reaches the CRO. When evidence is absent and the
 * invite itself is unreadable, this abstains.
 */

import { getAnthropicClient, getAnthropicModel } from "./anthropic";
import { rolldogOppIdForDeal } from "./pilot-config";
import { getAccountContextByDomain } from "./salesforce-context";
import { supabaseAdmin } from "./supabase";

export type JoinReason =
  | "known_deal" // DealRipe already tracks this counterparty
  | "salesforce_account" // a BDR created the account before the call
  | "invite_reads_commercial" // no CRM record, but the invite is plainly a sales call
  | "no_evidence" // nothing says this is a customer conversation
  | "invite_reads_internal"; // the invite is plainly not a sales call

export type JoinVerdict = {
  join: boolean;
  reason: JoinReason;
  detail: string;
};

/**
 * Decide whether an auto-join candidate is a commercial meeting.
 *
 * Hand-seeded pilot deals never reach here; they are known-good by definition.
 * This governs only deals DealRipe would create on the fly.
 */
export async function shouldJoinAutoMeeting(args: {
  tenantId: string;
  dealExternalId: string;
  domain: string;
  address: string;
  isFreeMail: boolean;
  subject: string | null;
  attendeeEmails: ReadonlyArray<string>;
  /** The company the rep works for. Without it the classifier cannot tell who
   *  is selling to whom, and "Magaya Software intro call" reads as a vendor
   *  pitching the rep rather than the rep's own discovery call. */
  sellerName?: string;
}): Promise<JoinVerdict> {
  const { tenantId, dealExternalId, domain, isFreeMail, subject, address } = args;
  const db = supabaseAdmin();

  // 1. A deal we already track, but ONLY if the deal itself carries commercial
  //    evidence. A bare auto-deal is not evidence: it was created by the old
  //    ungated auto-join, so trusting it makes every past mistake permanent.
  //    An auto-deal named after a person launders that person's internal
  //    meetings through the gate forever, which is exactly what happened with
  //    an "All Magaya Leaders Mtg" and a team dinner.
  const existing = await db
    .from("deals")
    .select("id, account, rolldog_opportunity_id")
    .eq("tenant_id", tenantId)
    .eq("external_id", dealExternalId)
    .maybeSingle();

  // Rolldog mappings live in two places in this codebase: the deals column and
  // the static map in pilot-config. deal-context.ts consults both, and so must
  // this, or a mapped opportunity like IFF reads as "no CRM record".
  const mappedOpp =
    existing.data?.rolldog_opportunity_id ?? rolldogOppIdForDeal(dealExternalId) ?? null;
  if (mappedOpp) {
    return {
      join: true,
      reason: "known_deal",
      detail: `Rolldog opportunity on "${existing.data?.account ?? dealExternalId}"`,
    };
  }

  if (existing.data) {
    // Prior calls that actually produced something. meeting_type is null on
    // rows captured before that column existed, so requiring it would throw
    // away real history; outcome='captured' covers those. Discarded and
    // no-content outcomes are excluded, which is the point.
    const prior = await db
      .from("calls")
      .select("id, outcome, meeting_type")
      .eq("tenant_id", tenantId)
      .eq("deal_id", existing.data.id)
      .limit(50);
    const real = (prior.data ?? []).filter(
      (c) =>
        c.outcome === "captured" ||
        c.meeting_type === "new_opportunity" ||
        c.meeting_type === "existing_customer",
    ).length;
    if (real > 0) {
      return {
        join: true,
        reason: "known_deal",
        detail: `${real} prior customer call(s) on "${existing.data.account}"`,
      };
    }
    // Otherwise keep going. The deal exists but has never been confirmed to be
    // a customer, so it earns no more trust than a stranger.
  }

  // 2. A Salesforce account exists for the domain, which in Magaya's motion
  //    means a BDR qualified and recorded this company before the call was
  //    booked. Meaningless for consumer mail, so skip it there.
  if (!isFreeMail) {
    try {
      const ctx = await getAccountContextByDomain(domain, [address]);
      if (ctx) {
        return { join: true, reason: "salesforce_account", detail: `Salesforce account "${ctx.accountName}"` };
      }
    } catch {
      // Salesforce being unreachable must not silently turn the gate into a
      // blanket "no". Fall through to reading the invite.
    }
  }

  // 3. No CRM record. Read the invite. A transcript is not needed to tell
  //    "Flexible Vacation time off" from "Magaya <> Z Transportation: Proposal
  //    Review", and a genuinely new inbound prospect deserves to be recorded.
  return classifyInvite({
    subject,
    attendeeEmails: args.attendeeEmails,
    domain,
    sellerName: args.sellerName ?? "the rep's own company",
  });
}

/**
 * Judge a meeting from its invite alone. Abstains toward "do not join": with no
 * API key, an unreadable subject, or any error, the answer is no.
 */
export async function classifyInvite(args: {
  subject: string | null;
  attendeeEmails: ReadonlyArray<string>;
  domain: string;
  sellerName: string;
}): Promise<JoinVerdict> {
  const subject = (args.subject ?? "").trim();
  if (!process.env.ANTHROPIC_API_KEY || subject.length < 3) {
    return { join: false, reason: "no_evidence", detail: "no CRM record and no readable invite subject" };
  }

  // Naming the seller is load-bearing. Without it "Magaya Software intro call"
  // reads as a vendor called Magaya Software pitching the rep, and a real
  // discovery call gets declined.
  const system = `A sales rep who works at ${args.sellerName} has this calendar invite. Decide whether it is an EXTERNAL COMMERCIAL meeting, meaning ${args.sellerName} is selling to or serving a prospect or customer.

Reply with exactly one word: commercial or other.

commercial: discovery, intro, demo, proposal, pricing, negotiation, renewal, QBR, onboarding, implementation, check-in with a customer, or any call whose purpose is ${args.sellerName} selling to or serving another company. The subject often contains ${args.sellerName} alongside the other company's name; that is ${args.sellerName} selling, not being sold to.
other: internal ${args.sellerName} team meetings, all-hands, leadership meetings and team dinners, 1-on-1s, HR and benefits, payroll and IT vendors that ${args.sellerName} BUYS from, recruiting and candidate interviews, personal appointments, and social calls.

When genuinely unsure, answer other.`;

  const user = `Invite subject: ${subject}
External attendee domain: ${args.domain}
Attendees: ${args.attendeeEmails.slice(0, 12).join(", ") || "(none listed)"}`;

  try {
    const resp = await getAnthropicClient().messages.create({
      model: getAnthropicModel(),
      max_tokens: 5,
      temperature: 0,
      system,
      messages: [{ role: "user", content: user }],
    });
    const text = resp.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .toLowerCase();
    if (text.includes("commercial")) {
      return { join: true, reason: "invite_reads_commercial", detail: `no CRM record; invite reads commercial ("${subject}")` };
    }
    return { join: false, reason: "invite_reads_internal", detail: `invite reads non-commercial ("${subject}")` };
  } catch {
    return { join: false, reason: "no_evidence", detail: "no CRM record and invite classification failed" };
  }
}
