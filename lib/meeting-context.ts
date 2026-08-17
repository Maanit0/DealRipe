/**
 * What this meeting is, resolved once, before anything acts on it.
 *
 * WHY THIS EXISTS
 *
 * Eight places in this codebase independently decided what a meeting was, each
 * with different inputs and different failure behaviour: join-gate from the
 * invite, call-type-precall from prior calls, deal-context from the
 * extraction, meeting-classify from the transcript, call-quarantine undoing it
 * afterwards, autoDraftFollowUpForCall from meeting_type, resolveWriteTarget
 * from link confidence, capture-classify from Recall's status. They disagreed.
 * The briefing treated Cargoservicesgroup as a sales call and asked a customer
 * mid-implementation what was driving them to look at a new solution; an hour
 * later transcript-sync classified the same call existing_customer.
 *
 * That is the same defect as two tables meaning the same thing, expressed as
 * behaviour. This is the one place that decides, and the actions become
 * policies over its answer rather than investigations of their own.
 *
 * WHAT IT IS BUILT FROM
 *
 * Deterministic sources first, in order of authority:
 *
 *   1. Salesforce customer standing. Customer_Since__c, Customer_Status__c and
 *      Account_Active_Licenses__c are where "existing customer" is actually
 *      recorded. Everything before this guessed it from the calendar title.
 *   2. The open opportunity, specifically Is_Renewal__c and
 *      Opportunity_Type__c. A renewal conversation is not a new-business one.
 *   3. The deal's own captured calls, already classified by transcript-sync.
 *   4. The invite title.
 *
 * CONFIDENCE, AND CONFIRMING LATER
 *
 * Before a call this is `provisional` at best: every input describes the
 * account or previous meetings, never this conversation. After the call the
 * transcript confirms or corrects it, transcript-sync writes the correction to
 * calls.call_subtype, and the next meeting on that deal reads it as history.
 * The loop already turns; this names it. `unknown` is a real answer and is
 * never rounded to discovery, because the cost of guessing "first discovery
 * call" at a customer of six years is the highest in the product.
 */

import {
  preCallTypeFromSubject,
  resolvePreCallType,
  type PreCallType,
  type PreCallTypeRead,
} from "./call-type-precall";
import { domainOf } from "./graph-mail";
import {
  readCustomerStanding,
  readOpportunitySituation,
  type CustomerStanding,
  type OpportunitySituation,
} from "./salesforce-context";
import { supabaseAdmin } from "./supabase";

/**
 * How much of this we actually established.
 *
 *   confirmed    the transcript has been read; this describes the conversation
 *                that happened
 *   provisional  resolved before the call from the account, the deal's history
 *                and the invite. Good enough to act on, not a fact about this
 *                conversation
 *   unknown      nothing load-bearing resolved. Act conservatively and say so
 */
export type ContextConfidence = "confirmed" | "provisional" | "unknown";

export type MeetingParties = {
  /** Customer-side attendees, by address. */
  customerEmails: string[];
  customerDomains: string[];
  /** The seller's own people, so nothing ever asks a rep to brief himself. */
  internalEmails: string[];
  /** True when we could not read an attendee list at all. */
  unknownAttendees: boolean;
};

export type MeetingContext = {
  tenantId: string;
  dealId: string;
  callId: string | null;
  account: string;

  /** What kind of conversation this is, and why. */
  meeting: PreCallTypeRead;
  confidence: ContextConfidence;

  /** Are they already a customer. The question the title was being asked. */
  standing: CustomerStanding;
  /** The open opportunity, with its renewal flag and type. */
  opportunity: OpportunitySituation;

  parties: MeetingParties;

  /** Every input that contributed, for a diagnostic to print. */
  provenance: string[];
};

function partiesFrom(participants: unknown, internalDomain = "magaya.com"): MeetingParties {
  const people = Array.isArray(participants)
    ? (participants as Array<{ email?: string | null }>)
    : null;
  if (!people || people.length === 0) {
    return {
      customerEmails: [],
      customerDomains: [],
      internalEmails: [],
      unknownAttendees: true,
    };
  }
  const emails = people
    .map((p) => (p?.email ?? "").toLowerCase().trim())
    .filter((e) => e.includes("@"));
  const customerEmails = emails.filter((e) => domainOf(e) !== internalDomain);
  return {
    customerEmails,
    customerDomains: [
      ...new Set(customerEmails.map((e) => domainOf(e)).filter((d): d is string => Boolean(d))),
    ],
    internalEmails: emails.filter((e) => domainOf(e) === internalDomain),
    unknownAttendees: emails.length === 0,
  };
}

/**
 * The Salesforce opportunity stage, as a call type.
 *
 * Magaya's stage names carry their SQL level ("SQL 3 - Proposal Validation
 * (Prove)"), which is the same ladder the briefing already reasons about. A
 * deal sitting at Proposal Validation is not about to have a first discovery
 * call, and Loomis proved the cost of ignoring it: an opportunity at SQL 3 and
 * a title of "IT REVEIW - MAGAYA CUSTOMS COMPLIANCE" resolved to unknown, so
 * the briefing fell back to its own guidance with nothing to go on.
 *
 * Deliberately weak evidence. It describes where the DEAL is, not what today's
 * meeting is for, so it only ever fills an `unknown` and never overrides a
 * title or the deal's captured history.
 */
function typeFromOpportunityStage(stage: string | null | undefined): PreCallType | null {
  const s = (stage ?? "").toLowerCase();
  if (!s) return null;
  const m = /sql\s*([0-5])/.exec(s);
  const level = m ? Number(m[1]) : null;
  if (level !== null) {
    if (level <= 1) return "discovery";
    // SQL2 (Solution Finalization) declines to answer.
    //
    // It is the boundary stage: a deal there may have demoed or may still be in
    // discovery, and mapping it to demo produced the only two errors the
    // backtest gained when opportunity stage was added. An `unknown` here costs
    // the briefing its stage hint and falls back to prose; a wrong `demo` tells
    // a rep not to run discovery on a call that is still discovery. The first
    // is recoverable and the second is not.
    if (level === 2) return null;
    return "proposal";
  }
  if (/negotiat|agreement|proposal|contract|closing/.test(s)) return "proposal";
  if (/solution|demo|evaluat/.test(s)) return "demo";
  if (/lead|qualify|develop|prospect/.test(s)) return "discovery";
  return null;
}

/**
 * Fold the CRM's answer into the type resolved from history and the title.
 *
 * The CRM outranks both for the two things it actually knows. It knows whether
 * they are a customer, which no calendar title reliably tells you, and it knows
 * whether the open deal is a renewal. It does NOT know what today's meeting is
 * about, so it never overrides demo versus proposal versus follow-up.
 */
function applyCrm(
  base: PreCallTypeRead,
  standing: CustomerStanding,
  opportunity: OpportunitySituation,
  subject: string | null | undefined,
): { meeting: PreCallTypeRead; notes: string[] } {
  const notes: string[] = [];

  // An internal meeting is internal regardless of what the CRM says about the
  // company, so that decision stands untouched.
  if (base.type === "internal") return { meeting: base, notes };

  if (standing.status === "customer") {
    notes.push(`Salesforce: ${standing.detail}`);

    // A customer with an open NON-renewal opportunity is being sold something
    // new. That is a real sales conversation and must not be flattened into a
    // support check-in, so the subject and history keep deciding the shape of
    // it. What changes is that discovery framing is off the table.
    const expanding =
      opportunity.status === "found" && opportunity.isRenewal === false;

    if (expanding && base.type !== "existing_customer") {
      if (base.type === "discovery" || base.type === "unknown") {
        return {
          meeting: {
            type: "follow_up",
            source: "history",
            reason: `they are an existing customer (${standing.detail}) with an open non-renewal opportunity, so this is an expansion conversation rather than a first discovery call`,
          },
          notes,
        };
      }
      return { meeting: base, notes };
    }

    if (base.type !== "existing_customer") {
      return {
        meeting: {
          type: "existing_customer",
          source: "history",
          reason: `Salesforce records them as a customer (${standing.detail})`,
        },
        notes,
      };
    }
    return { meeting: base, notes };
  }

  if (standing.status === "unavailable") {
    // Explicitly NOT a downgrade to prospect. Say we could not check.
    notes.push(`Salesforce customer standing could not be read: ${standing.detail}`);
  } else {
    notes.push(`Salesforce: ${standing.detail}`);
  }

  if (opportunity.status === "found") {
    notes.push(`open opportunity: ${opportunity.detail}`);
    if (opportunity.isRenewal === true) {
      return {
        meeting: {
          type: "existing_customer",
          source: "history",
          reason: `the open Salesforce opportunity is flagged as a renewal, so this is a renewal conversation and not new business`,
        },
        notes,
      };
    }
    // A pricing-shaped opportunity type is weaker evidence than the title about
    // THIS meeting, so it only fills an unknown.
    if (base.type === "unknown" && /renew|upsell|expansion/i.test(opportunity.opportunityType ?? "")) {
      return {
        meeting: {
          type: "follow_up",
          source: "history",
          reason: `the open opportunity is type "${opportunity.opportunityType}", so this account is already engaged`,
        },
        notes,
      };
    }
  } else if (opportunity.status === "unavailable") {
    notes.push(`open opportunity could not be read: ${opportunity.detail}`);
  }

  // Nothing in the CRM moved it. Fall back to the title, which may still carry
  // a signal the history did not.
  if (base.type === "unknown") {
    const fromSubject = preCallTypeFromSubject(subject);
    if (fromSubject) return { meeting: fromSubject, notes };

    // Last resort before giving up: where the opportunity sits. Weaker than
    // anything above, and better than telling the briefing nothing at all.
    if (opportunity.status === "found") {
      const fromStage = typeFromOpportunityStage(opportunity.stage);
      if (fromStage) {
        return {
          meeting: {
            type: fromStage,
            source: "history",
            reason: `the open Salesforce opportunity is at stage "${opportunity.stage}"`,
          },
          notes,
        };
      }
    }
  }
  return { meeting: base, notes };
}

/**
 * Resolve everything known about an upcoming or just-finished meeting.
 *
 * Best-effort by contract. Every integration read here can fail, and each one
 * failing degrades the answer rather than throwing: a briefing with a
 * provisional context is far better than no briefing, and a context that says
 * which inputs were missing is far better than one that quietly guessed.
 */
export async function resolveMeetingContext(args: {
  tenantId: string;
  dealId: string;
  callId?: string | null;
  subject?: string | null;
  /** Attendees from the invite or the calls row. */
  participants?: unknown;
  /** Only consider prior calls before this instant. */
  beforeIso?: string | null;
  /** Set once the transcript has been read, which is what confirms the type. */
  transcriptRead?: boolean;
}): Promise<MeetingContext> {
  const db = supabaseAdmin();
  const provenance: string[] = [];

  const dealRes = await db
    .from("deals")
    .select("account, salesforce_account_id, salesforce_link_confidence, rolldog_opportunity_id")
    .eq("id", args.dealId)
    .maybeSingle();
  if (dealRes.error) {
    provenance.push(`deal read failed: ${dealRes.error.message}`);
  }
  const deal = dealRes.data ?? null;

  // Type from the deal's own history and the invite title.
  const base = await resolvePreCallType({
    tenantId: args.tenantId,
    dealId: args.dealId,
    subject: args.subject,
    beforeIso: args.beforeIso,
  });
  provenance.push(`history and title: ${base.type} (${base.reason})`);

  // Salesforce, which is where customer standing actually lives.
  //
  // Read only when the account link is trustworthy. salesforce_link_confidence
  // fails closed below "confirmed" for writes, and reading the WRONG account's
  // customer status would be worse than reading none: it would tell a rep that
  // a brand new prospect has been a customer since 2019.
  let standing: CustomerStanding = {
    status: "unavailable",
    detail: "the deal has no Salesforce account linked",
  };
  let opportunity: OpportunitySituation = {
    status: "unavailable",
    detail: "the deal has no Salesforce account linked",
  };
  const accountId = deal?.salesforce_account_id ?? null;
  const linkOk = (deal?.salesforce_link_confidence ?? "") === "confirmed";
  if (accountId && !linkOk) {
    const why = `Salesforce account ${accountId} is linked at confidence "${deal?.salesforce_link_confidence ?? "none"}", not "confirmed", so it was not read`;
    standing = { status: "unavailable", detail: why };
    opportunity = { status: "unavailable", detail: why };
  } else if (accountId) {
    [standing, opportunity] = await Promise.all([
      readCustomerStanding(accountId).catch(
        (e): CustomerStanding => ({
          status: "unavailable",
          detail: e instanceof Error ? e.message : String(e),
        }),
      ),
      readOpportunitySituation(accountId).catch(
        (e): OpportunitySituation => ({
          status: "unavailable",
          detail: e instanceof Error ? e.message : String(e),
        }),
      ),
    ]);
  }

  const { meeting, notes } = applyCrm(base, standing, opportunity, args.subject);
  provenance.push(...notes);
  if (meeting.type !== base.type) {
    provenance.push(`CRM changed the read from ${base.type} to ${meeting.type}`);
  }

  // Confidence. The transcript is the only thing that confirms what a meeting
  // actually was; everything before it describes the account.
  let confidence: ContextConfidence;
  if (args.transcriptRead) confidence = "confirmed";
  else if (meeting.type === "unknown") confidence = "unknown";
  else confidence = "provisional";

  let participants = args.participants;
  if (participants === undefined && args.callId) {
    const c = await db.from("calls").select("participants").eq("id", args.callId).maybeSingle();
    if (c.error) provenance.push(`attendee read failed: ${c.error.message}`);
    participants = c.data?.participants;
  }

  return {
    tenantId: args.tenantId,
    dealId: args.dealId,
    callId: args.callId ?? null,
    account: deal?.account ?? args.dealId,
    meeting,
    confidence,
    standing,
    opportunity,
    parties: partiesFrom(participants),
    provenance,
  };
}

// =====================================================================
// Policies
//
// What each action does with the answer. Kept here, next to the resolution,
// so the rules are readable side by side instead of scattered across the
// files that enforce them.
// =====================================================================

export type ActionVerdict = { act: boolean; reason: string };

/** Should we send a pre-call briefing for this meeting. */
export function shouldBrief(ctx: MeetingContext): ActionVerdict {
  if (ctx.meeting.type === "internal") {
    return { act: false, reason: `not a customer call: ${ctx.meeting.reason}` };
  }
  if (ctx.parties.unknownAttendees && ctx.meeting.type === "unknown") {
    return {
      act: false,
      reason: "no attendee list and nothing identifies the meeting, so there is nothing to brief on",
    };
  }
  return { act: true, reason: `${ctx.meeting.type} call (${ctx.confidence})` };
}

/**
 * Is a first-discovery framing allowed.
 *
 * "unknown" allows it, deliberately: with no evidence either way an early
 * framing is the safer error on a genuinely new deal, and the prompt is
 * separately instructed not to assume a first conversation.
 */
export function allowsDiscovery(ctx: MeetingContext): boolean {
  return ctx.meeting.type === "discovery" || ctx.meeting.type === "unknown";
}

/**
 * Should a follow-up draft be written into the rep's Outlook.
 *
 * Today autoDraftFollowUpForCall gates on `meeting_type === "new_opportunity"`,
 * which silently excludes every existing-customer expansion conversation. This
 * is the policy that replaces it when that path is next touched; it is exported
 * now so the rule lives in one place rather than being reinvented there.
 */
export function shouldDraftFollowUp(ctx: MeetingContext): ActionVerdict {
  if (ctx.meeting.type === "internal") {
    return { act: false, reason: "internal meeting" };
  }
  if (ctx.parties.customerEmails.length === 0) {
    return { act: false, reason: "no customer-side attendee to write to" };
  }
  return { act: true, reason: `${ctx.meeting.type} call with ${ctx.parties.customerEmails.length} customer attendee(s)` };
}

/**
 * What to call this relationship at the top of a briefing, or null to use the
 * deal's SQL stage.
 *
 * Only overrides the stage when the stage would actively mislead: a customer
 * shown as "Lead", or a renewal shown as new business. Ordinary new-business
 * deals keep their stage, which is the useful thing to see there.
 */
export function standingLabel(ctx: MeetingContext): string | null {
  if (ctx.opportunity.status === "found" && ctx.opportunity.isRenewal === true) {
    return "Renewal";
  }
  if (ctx.standing.status === "customer") {
    const impl = ctx.standing.implementation;
    if (impl && !/complete/i.test(impl)) return "Existing customer, in implementation";
    return "Existing customer";
  }
  if (ctx.meeting.type === "existing_customer") return "Existing customer";
  return null;
}

/** One line for a log or a diagnostic. */
export function describeContext(ctx: MeetingContext): string {
  return (
    `${ctx.account}: ${ctx.meeting.type} (${ctx.confidence}, via ${ctx.meeting.source}) ` +
    `because ${ctx.meeting.reason}`
  );
}

export type { PreCallType };
