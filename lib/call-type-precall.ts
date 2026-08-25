/**
 * What kind of call this is, decided BEFORE it happens.
 *
 * lib/meeting-classify.ts answers the same question from the transcript, which
 * is the wrong side of the call for a briefing. `calls.meeting_type` and
 * `calls.call_subtype` are written by transcript-sync AFTER capture, so at
 * briefing time they are null for the meeting being briefed and the briefing
 * has never had this input at all.
 *
 * The cost of not having it, measured by the prescription ledger across five
 * reps: 25% follow-through on discovery calls, and 0% on demos, follow-ups and
 * existing-customer calls. Cargoservicesgroup was a customer mid-implementation
 * discussing patch 14.2 being asked "what's driving you to look at a new
 * solution", and Unitedchb was a demo ending "appreciate the demo" being asked
 * the same. The reps were right to ignore both.
 *
 * Two rules this is built on:
 *
 *   DETERMINISTIC FIRST. The strongest evidence is the deal's OWN captured
 *   history, which is already classified and sitting in the calls table. A deal
 *   whose last call was a demo is not about to have a first discovery call. No
 *   model is needed to know that and none is used.
 *
 *   UNKNOWN IS A RESULT. When there is no history and the subject says nothing,
 *   this returns "unknown" with a reason rather than defaulting to discovery.
 *   classifyCallSubtype defaults to "discovery" on failure and says so in its
 *   own comment; doing that here would put a first-discovery briefing in front
 *   of a signed customer, which is the exact failure being fixed.
 */

import { readCustomerStanding, type CustomerStanding } from "./salesforce-context";
import { supabaseAdmin } from "./supabase";

export type PreCallType =
  | "discovery"
  | "demo"
  | "proposal"
  | "follow_up"
  | "existing_customer"
  | "internal"
  /** No history and no signal in the subject. Brief without assuming a stage. */
  | "unknown";

export type PreCallTypeRead = {
  type: PreCallType;
  /**
   * Where it came from, so a briefing that gets this wrong can be traced to the
   * evidence rather than to a guess.
   *   standing Account.Type says they already buy from Magaya
   *   outcome  the deal is won in the CRM, so they are a customer
   *   history  the deal's own captured calls, already classified
   *   subject  the calendar title
   *   none     nothing to go on
   */
  source: "standing" | "outcome" | "history" | "subject" | "gates" | "none";
  reason: string;
};

/**
 * Subject patterns, ordered most specific first.
 *
 * These mirror the guidance that has been in the briefing prompt as prose since
 * the Alexandra week (onboarding and proposal walkthroughs read as first
 * discovery calls). Encoding them here makes the decision inspectable and
 * testable instead of leaving it to the model to notice mid-generation.
 */
const SUBJECT_RULES: Array<{ type: PreCallType; re: RegExp; label: string }> = [
  // Existing customer first: a kickoff or a training is not a sales call at all,
  // and getting this wrong qualifies someone who has already paid.
  {
    type: "existing_customer",
    re: /\b(onboarding|kick\s?off|kickoff|training|implementation|go[-\s]?live|support|health\s?check|qbr|business\s+review|office\s+hours|check[-\s]?in)\b/i,
    label: "reads as an existing-customer meeting",
  },
  {
    type: "internal",
    re: /\b(internal|all[-\s]?hands|stand\s?up|standup|1[-:\s]?on[-:\s]?1|one[-\s]?on[-\s]?one|team\s+(meeting|sync|dinner)|interview|candidate|payroll|benefits)\b/i,
    label: "reads as an internal meeting",
  },
  {
    type: "proposal",
    re: /\b(proposal|pricing|price|quote|estimate|contract|redline|negotiat|renewal|terms|sow|order\s+form)\b/i,
    label: "reads as a pricing or contract conversation",
  },
  {
    type: "demo",
    re: /\b(demo|demonstration|walk\s?through|walkthrough|presentation|storyboard|deep\s?dive)\b/i,
    label: "reads as a demo or walkthrough",
  },
  {
    type: "follow_up",
    re: /\b(cont\.?|continued|follow[-\s]?up|next\s+steps?|part\s+2|additional\s+session|recap|touch\s?base)\b/i,
    label: "reads as a conversation already in progress",
  },
  {
    type: "discovery",
    re: /\b(intro|introduction|discovery|first\s+call|initial)\b/i,
    label: "reads as an early conversation",
  },
];

/** Ordering used to decide whether history has already moved past a stage. */
const ADVANCEMENT: Record<string, number> = {
  discovery: 1,
  demo: 2,
  follow_up: 2,
  proposal: 3,
};

export function preCallTypeFromSubject(subject: string | null | undefined): PreCallTypeRead | null {
  const s = (subject ?? "").trim();
  if (!s) return null;
  for (const rule of SUBJECT_RULES) {
    if (rule.re.test(s)) {
      return { type: rule.type, source: "subject", reason: `the title ${rule.label}` };
    }
  }
  return null;
}

/**
 * Resolve the kind of call about to happen.
 *
 * History outranks the subject, with one deliberate exception: a subject that
 * reads as an existing-customer or internal meeting wins outright, because
 * those are the two errors that cost the most in front of a rep and the title
 * is explicit evidence about THIS meeting where history is evidence about
 * previous ones.
 */
async function resolveFromHistoryAndSubject(args: {
  tenantId: string;
  dealId: string;
  subject: string | null | undefined;
  /**
   * Only consider calls before this instant. Defaults to now.
   *
   * In production nothing later can have a subtype yet, since transcript-sync
   * writes it after capture. It matters for a re-run or a backfill, where
   * without the bound this reads calls that had not happened when the briefing
   * went out and quietly grades itself with the answers. Same leak the recap
   * path closed with asOf.
   */
  beforeIso?: string | null;
}): Promise<PreCallTypeRead> {
  const fromSubject = preCallTypeFromSubject(args.subject);
  if (fromSubject && (fromSubject.type === "existing_customer" || fromSubject.type === "internal")) {
    return fromSubject;
  }

  const db = supabaseAdmin();

  // A won deal is a customer, and that outranks anything the invite title says.
  //
  // Mollaxpanama, Treecorp and Eosits all closed won and then took calls on
  // 2026-08-18 that would have been briefed as new business, asking a paying
  // customer what is driving them to look at a new solution. Outcome is a
  // recorded fact rather than an inference from a subject line, so it is read
  // first.
  //
  // A LOST deal deliberately gets no special case: a dead opportunity taking a
  // new call usually IS new business, and forcing existing_customer there would
  // tell the rep they had a customer who never bought.
  //
  // KNOWN GAP: outcome_label answers "did a deal close while we were watching",
  // which is a deliberately narrower question than "are they a customer".
  // Treecorp closed won 2026-08-10 and Eosits 2026-07-29, both BEFORE DealRipe
  // captured its first call on them, so outcome-sync leaves them unlabelled as
  // only_historical (correctly: we did not influence those wins) and they still
  // route as new business here. The right customer test is Account.Type, read
  // through readCustomerStanding in lib/salesforce-context.ts, per the note in
  // CLAUDE.md that Customer_Status__c does not mean what it says. That read is
  // not wired in yet because it costs a Salesforce round trip inside
  // briefing-sync's five-minute loop.
  const dealOutcome = await db
    .from("deals")
    .select("outcome_label")
    .eq("tenant_id", args.tenantId)
    .eq("id", args.dealId)
    .maybeSingle();
  if (dealOutcome.error) {
    console.warn(
      `[call-type] outcome read failed for deal ${args.dealId}, continuing without it: ${dealOutcome.error.message}`,
    );
  } else if (dealOutcome.data?.outcome_label === "won") {
    return {
      type: "existing_customer",
      source: "outcome",
      reason: "the deal is recorded as won in the CRM, so this is a customer conversation",
    };
  }
  const prior = await db
    .from("calls")
    .select("meeting_type, call_subtype, scheduled_start, call_date")
    .eq("tenant_id", args.tenantId)
    .eq("deal_id", args.dealId)
    .not("call_subtype", "is", null)
    .lt("scheduled_start", args.beforeIso ?? new Date().toISOString())
    .order("scheduled_start", { ascending: false })
    .limit(6);

  if (prior.error) {
    // Say what could not be read. Falling through to the subject alone is the
    // right behaviour, but doing it silently would make a briefing that ignores
    // a deal's whole history look identical to one for a brand new deal.
    console.warn(
      `[call-type] prior-call read failed for deal ${args.dealId}, falling back to the invite title alone: ${prior.error.message}`,
    );
    return (
      fromSubject ?? {
        type: "unknown",
        source: "none",
        reason: "the deal's history could not be read and the title says nothing about the stage",
      }
    );
  }

  const rows = prior.data ?? [];

  // A deal with any existing-customer call is an existing customer. That does
  // not revert.
  if (rows.some((r) => r.meeting_type === "existing_customer")) {
    return {
      type: "existing_customer",
      source: "history",
      reason: "a previous call on this deal was an existing-customer meeting",
    };
  }

  // Narrow to the types this module actually understands rather than trusting
  // whatever string is in the column. call_subtype is free text in the
  // database, and a value transcript-sync starts writing tomorrow would
  // otherwise flow straight through as a PreCallType nothing handles.
  const KNOWN: ReadonlySet<string> = new Set<PreCallType>([
    "discovery",
    "demo",
    "proposal",
    "follow_up",
    "existing_customer",
  ]);
  const subtypes = rows
    .map((r) => r.call_subtype)
    .filter((s): s is PreCallType => typeof s === "string" && KNOWN.has(s));

  if (subtypes.length > 0) {
    const latest = subtypes[0];
    const furthest = subtypes.reduce(
      (best, s) => ((ADVANCEMENT[s] ?? 0) > (ADVANCEMENT[best] ?? 0) ? s : best),
      subtypes[0],
    );

    // The subject may legitimately advance the deal past its history: a deal
    // whose last call was a demo, with "Proposal Review" on the invite, is a
    // proposal call. It may never take it BACKWARDS.
    if (fromSubject && (ADVANCEMENT[fromSubject.type] ?? 0) > (ADVANCEMENT[furthest] ?? 0)) {
      return {
        type: fromSubject.type,
        source: "subject",
        reason: `${fromSubject.reason}, ahead of the last captured call (${latest})`,
      };
    }

    // Never brief discovery on a deal that has already demoed or quoted.
    if ((ADVANCEMENT[furthest] ?? 0) >= 2) {
      return {
        type: furthest === latest ? latest : furthest,
        source: "history",
        reason: `this deal has already had a ${furthest} call`,
      };
    }
    return {
      type: latest,
      source: "history",
      reason: `the last captured call on this deal was ${latest}`,
    };
  }

  if (fromSubject) return fromSubject;
  return {
    type: "unknown",
    source: "none",
    reason: "no captured history on this deal and the title says nothing about the stage",
  };
}

/**
 * Is a first-discovery framing appropriate.
 *
 * The single question the briefing prompt actually needs answered. "unknown"
 * counts as yes, because with no evidence either way an early framing is the
 * safer error on a new deal, and the prompt is separately told not to assume.
 */
export function allowsDiscoveryFraming(type: PreCallType): boolean {
  return type === "discovery" || type === "unknown";
}


// ---------------------------------------------------------------------------
// Customer standing
// ---------------------------------------------------------------------------

const STANDING_TTL_MS = 6 * 60 * 60 * 1000;
const standingCache = new Map<string, { at: number; value: CustomerStanding }>();

/**
 * readCustomerStanding, memoised for six hours.
 *
 * briefing-sync fires every five minutes across every rep's calendar, and this
 * would otherwise be a describe plus a query per event. Whether a company buys
 * from Magaya does not change on a five-minute cadence.
 *
 * An `unavailable` result is deliberately NOT cached. Caching it would let one
 * transient Salesforce failure tell every briefing for six hours that we did
 * not check, which is the same absence-as-evidence trap one layer up.
 */
async function cachedStanding(accountId: string): Promise<CustomerStanding> {
  const hit = standingCache.get(accountId);
  if (hit && Date.now() - hit.at < STANDING_TTL_MS) return hit.value;
  const value = await readCustomerStanding(accountId);
  if (value.status !== "unavailable") standingCache.set(accountId, { at: Date.now(), value });
  return value;
}

/**
 * Resolve the call type, then refuse to frame a paying customer as a prospect.
 *
 * WHY THIS IS A POST-PASS RATHER THAN A FIRST CHECK. Account.Type answers "do
 * they buy from us", not "what is this meeting". A customer taking a demo of a
 * new module is still a demo, and that is more useful to the rep than
 * "existing customer", so standing only overrides a verdict that would license
 * first-discovery framing. allowsDiscoveryFraming is the existing definition of
 * exactly that, and reusing it means the two cannot drift apart.
 *
 * WHY IT IS NEEDED AT ALL, given the won-deal check inside. outcome_label
 * answers "did a deal close while we were watching", which is deliberately
 * narrower. Treecorp closed won 2026-08-10 and Eosits 2026-07-29, both before
 * DealRipe captured its first call, so outcome-sync leaves them unlabelled and
 * correctly claims no credit. They are still customers, and both took calls on
 * 2026-08-18 that would have asked them what is driving them to look at a new
 * solution.
 *
 * Fails open: prospect, unavailable, no linked account and any thrown error all
 * leave the original verdict alone. Telling a customer of six years that we
 * think they are a prospect is the expensive error, but inventing an
 * existing-customer framing from a failed read is the same mistake mirrored.
 */
export async function resolvePreCallType(args: {
  tenantId: string;
  dealId: string;
  subject: string | null | undefined;
  beforeIso?: string | null;
}): Promise<PreCallTypeRead> {
  let base = await resolveFromHistoryAndSubject(args);
  if (!allowsDiscoveryFraming(base.type)) return base;

  // A THIRD DETERMINISTIC TIER, when history and the title both said nothing.
  //
  // roughly 60% of meetings resolve to "unknown": a deal DealRipe joined late,
  // or a title like "Magaya / Acme". The deal's own qualification record still
  // knows things the invite does not, and the reasoning is the same one this
  // file already applies to call history, one level deeper: a deal whose
  // proposal has been DELIVERED is not about to have a first discovery call,
  // exactly as a deal whose last call was a demo is not.
  //
  // Only runs on "unknown". A confident read from history or the title is
  // evidence about THIS meeting and outranks a fact about the deal.
  if (base.type === "unknown") {
    const gated = await typeFromQualificationRecord(args.tenantId, args.dealId);
    if (gated) base = gated;
  }

  const db = supabaseAdmin();
  const deal = await db
    .from("deals")
    .select("salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", args.tenantId)
    .eq("id", args.dealId)
    .maybeSingle();
  if (deal.error) {
    console.warn(
      `[call-type] account read failed for deal ${args.dealId}, keeping ${base.type}: ${deal.error.message}`,
    );
    return base;
  }
  const accountId = deal.data?.salesforce_account_id;
  // A link below `confirmed` may be the wrong account entirely, and this
  // codebase already fails closed on that everywhere it writes.
  if (!accountId || deal.data?.salesforce_link_confidence !== "confirmed") return base;

  let standing: CustomerStanding;
  try {
    standing = await cachedStanding(accountId);
  } catch (err) {
    console.warn(
      `[call-type] customer standing threw for deal ${args.dealId}, keeping ${base.type}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return base;
  }
  if (standing.status !== "customer") return base;

  return {
    type: "existing_customer",
    source: "standing",
    reason: `Salesforce says this account already buys from Magaya (${standing.detail}), so a first-discovery framing would be wrong`,
  };
}


/**
 * What the deal's own qualification record implies about the next call.
 *
 * Deliberately narrow. These gates can rule discovery OUT with confidence and
 * cannot pin the exact kind of call, so this returns only the two verdicts the
 * evidence actually supports and nothing else.
 *
 *   proposal delivered, or stage at SQL3 or beyond -> "proposal". SQL3 is
 *     literally named "Proposal Validation (Prove)", so a deal that has reached
 *     it is being briefed for a proposal conversation, not a first meeting.
 *
 *   demo completed and nothing later -> "follow_up". The demo has happened, so
 *     the next conversation picks up from it. Returning "demo" here would brief
 *     a rep to run the demo they already ran.
 *
 * Returns null when neither holds, leaving "unknown", which is a result.
 */
async function typeFromQualificationRecord(
  tenantId: string,
  dealId: string,
): Promise<PreCallTypeRead | null> {
  const db = supabaseAdmin();
  const [fx, dealRow] = await Promise.all([
    db
      .from("field_extractions")
      .select("framework_field_key, status")
      .eq("tenant_id", tenantId)
      .eq("deal_id", dealId)
      .eq("status", "Yes"),
    db.from("deals").select("stage_key").eq("tenant_id", tenantId).eq("id", dealId).maybeSingle(),
  ]);
  // A failed read is not evidence of anything. Leave it unknown.
  if (fx.error) return null;
  const yes = new Set(
    ((fx.data ?? []) as Array<{ framework_field_key: string }>).map((r) => r.framework_field_key),
  );
  const stage = ((dealRow.data as { stage_key?: string | null } | null)?.stage_key ?? "").toUpperCase();
  const stageNum = /SQL(\d)/.exec(stage)?.[1];

  if (yes.has("sql2_proposal_delivered")) {
    return { type: "proposal", source: "gates", reason: "a proposal has already been delivered on this deal" };
  }
  if (stageNum && Number(stageNum) >= 3) {
    return { type: "proposal", source: "gates", reason: `the deal is at ${stage}, past the point of a first conversation` };
  }
  if (yes.has("sql2_demo_completed")) {
    return { type: "follow_up", source: "gates", reason: "the demo has already been given, so this picks up from it" };
  }
  return null;
}
