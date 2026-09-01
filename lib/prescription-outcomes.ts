/**
 * What is deterministically true after a call.
 *
 * The scorer answers "did the rep do what we told them" from the transcript.
 * This answers the three things we can know without a model: did a next
 * meeting get booked, did the rep email the customer, did the CRM stage move.
 *
 * Every function here returns three states and a reason. "no" is a recorded
 * negative: we looked and it is not there. "unknown" is we did not look, or
 * could not. The reason string exists so a diagnostic can print WHY a row is
 * unknown without reimplementing the rule, which is the other half of the
 * discipline: a checker that can disagree with the code it checks will.
 *
 * None of these are inferred from each other and none default to false.
 */

import type { Tristate } from "./database.types";
import {
  allowedMailboxes,
  domainOf,
  isCalendarResponseSubject,
  listMailboxMessages,
  type MailMessage,
} from "./graph-mail";
import { repEmailForDeal } from "./pilot-config";
import type { SalesforceReadStatus, SalesforceSnapshot } from "./salesforce-stage";
import type { RolldogReadStatus, RolldogSnapshot } from "./snapshot";
import { supabaseAdmin } from "./supabase";

const GRAPH_TENANT = "magaya.com";

/** A three-state answer that says why. */
export type OutcomeRead = { value: Tristate; reason: string };

/** The call being scored, resolved once and passed to each read. */
export type OutcomeCall = {
  tenantId: string;
  callId: string;
  dealId: string;
  /** When the call happened (ISO). scheduled_start, else call_date. */
  at: string;
  /** calls.participants, used for the customer side. */
  participants: unknown;
  /** deals.rep_email, or the pilot map. Null when the deal has neither. */
  repEmail: string | null;
  dealExternalId: string | null;
};

/**
 * Outcomes that are permanently unanswerable for a call, so a caller can stop
 * retrying them. Distinct from a transient "unknown".
 */
export type CallOutcomes = {
  nextMeeting: OutcomeRead;
  draftSent: OutcomeRead;
  /** The customer's CRM said so. Proof. Safe to show a CRO. */
  stageMoved: OutcomeRead;
  /** Our own evidence said so. Learning only. Never shown as proof. */
  qualificationAdvanced: OutcomeRead;
};

/** Call outcomes with no content of their own. Mirrors lib/briefing-history.ts. */
const NO_CONTENT = new Set([
  "no_conversation",
  "no_show",
  "rescheduled",
  "placeholder",
  "capture_failed",
  "duplicate",
]);

export function repEmailFor(call: {
  repEmail: string | null;
  dealExternalId: string | null;
}): string | null {
  const mapped = call.dealExternalId ? repEmailForDeal(call.dealExternalId) : null;
  const email = (mapped ?? call.repEmail ?? "").trim().toLowerCase();
  return email.length > 0 ? email : null;
}

/** Customer-side addresses on the call. Same filter the draft path uses. */
export function customerEmailsOf(participants: unknown): string[] {
  const people = Array.isArray(participants)
    ? (participants as Array<{ email?: string | null }>)
    : [];
  return people
    .map((p) => (p?.email ?? "").toLowerCase().trim())
    .filter((e) => e.includes("@") && domainOf(e) !== "magaya.com");
}

// =====================================================================
// 1. Does the deal have a next meeting after this call
// =====================================================================

/**
 * Source: the calls table, which lib/calendar-sync.ts fills from each rep's
 * Microsoft calendar, keyed on iCalUId.
 *
 * "no" requires that the calendar has actually been read since the call.
 * microsoft_connections.last_synced_at is stamped on every Graph token use
 * (lib/microsoft-graph.ts), so a connection last synced before the call means
 * we are looking at a calendar that predates the thing we are asking about,
 * and the honest answer is unknown.
 *
 * One limit worth stating, because it produces genuine false negatives:
 * calendar-sync only creates a calls row for a meeting that resolves to a
 * pilot or auto deal through resolveMeetingDeal. A next meeting booked under a
 * subject and attendee set that does not resolve leaves no row. So "no" here
 * means "no meeting we would have captured", not "no meeting exists".
 */
export async function readNextMeeting(call: OutcomeCall): Promise<OutcomeRead> {
  const db = supabaseAdmin();

  const later = await db
    .from("calls")
    .select("id, scheduled_start, call_date, outcome, title")
    .eq("tenant_id", call.tenantId)
    .eq("deal_id", call.dealId)
    .gt("scheduled_start", call.at)
    .order("scheduled_start", { ascending: true })
    .limit(10);
  if (later.error) {
    return { value: "unknown", reason: `calls lookup failed: ${later.error.message}` };
  }

  const real = (later.data ?? []).filter((c) => !(c.outcome && NO_CONTENT.has(c.outcome)));
  if (real.length > 0) {
    const next = real[0];
    return {
      value: "yes",
      reason: `next meeting ${next.scheduled_start ?? next.call_date ?? "date unknown"}${
        next.title ? ` ("${next.title}")` : ""
      }`,
    };
  }

  // Nothing found. Before calling that a "no", establish that we were looking
  // at a calendar read after the call happened.
  const rep = repEmailFor(call);
  if (!rep) {
    return { value: "unknown", reason: "no rep email on the deal, so no calendar to check" };
  }
  const conn = await db
    .from("microsoft_connections")
    .select("id, last_synced_at")
    .eq("tenant_id", call.tenantId)
    .eq("user_principal_name", rep)
    .maybeSingle();
  if (conn.error) {
    return {
      value: "unknown",
      reason: `calendar connection lookup failed for ${rep}: ${conn.error.message}`,
    };
  }
  if (!conn.data) {
    return { value: "unknown", reason: `${rep} has no connected calendar` };
  }
  const synced = conn.data.last_synced_at;
  if (!synced) {
    return { value: "unknown", reason: `${rep}'s calendar has never been synced` };
  }
  if (Date.parse(synced) < Date.parse(call.at)) {
    return {
      value: "unknown",
      reason: `${rep}'s calendar was last synced ${synced}, before this call, so nothing booked since would be visible`,
    };
  }

  return {
    value: "no",
    reason: `${rep}'s calendar was synced ${synced} and holds no later meeting on this deal`,
  };
}

// =====================================================================
// 2. Did the rep email the customer after the call
// =====================================================================

/**
 * The rep's mail to this customer after the call, read once.
 *
 * Shared, because two things need it and it is the most expensive read on
 * this path: the draft-sent outcome below, and the end-commitment email pass
 * in lib/prescription-scoring.ts. Fetching it twice per call would double the
 * Graph load for one answer.
 *
 * Says which of the five cases it is. "The rep sent nothing" and "we could not
 * look" are not the same fact and never collapse to the same value.
 */
export type PostCallMailRead =
  | {
      status: "read";
      mailbox: string;
      domains: string[];
      /** Mail the REP wrote to the customer after the call. */
      outbound: MailMessage[];
      /**
       * Mail the CUSTOMER wrote back after the call.
       *
       * Carried separately because the two answer different questions and only
       * one of them is about the rep. `readDraftSent` wants outbound alone: a
       * customer replying is not the rep following up. Commitment scoring wants
       * both, because a commitment has two parties and the evidence often sits
       * on the customer's side of the thread.
       *
       * Medovlog, 2026-08-31: "Nick sends the services list by Friday August 28,
       * Magaya sends the revised proposal by Wednesday September 2" scored 'no'
       * against 1 outbound message, while 13 inbound ones sat in the same
       * thread, three of them DocuSign "Completed: You're copied on Magaya Quote
       * Agreement". The deal closed WON the next day.
       */
      inbound: MailMessage[];
    }
  | { status: "no_rep" }
  | { status: "no_mailbox_access"; mailbox: string }
  | { status: "no_domains" }
  | { status: "bad_call_date"; at: string }
  | { status: "unavailable"; mailbox: string; error: string };

/**
 * E-signature services, whose mail is evidence a commitment was kept.
 *
 * A signature confirmation is written by neither the rep nor the customer, so
 * a filter that keeps only the customer's domain drops the single clearest
 * proof a deal moved. Medovlog's three "Completed: You're copied on Magaya
 * Quote Agreement" notices come from echosign.com, and the commitment they
 * settle scored as not kept because of it.
 *
 * WHAT WE HAVE SEEN, not a claim of completeness. Magaya sends through Adobe
 * Sign; another tenant will use something else and this list will be wrong for
 * them until someone looks.
 */
const SIGNATURE_SERVICE_DOMAINS = [
  "echosign.com",
  "adobesign.com",
  "docusign.net",
  "docusign.com",
  "hellosign.com",
  "dropboxsign.com",
  "pandadoc.com",
];

export function isSignatureServiceDomain(domain: string | null | undefined): boolean {
  const d = (domain ?? "").toLowerCase();
  return SIGNATURE_SERVICE_DOMAINS.some((s) => d === s || d.endsWith(`.${s}`));
}

export async function readPostCallCustomerMail(
  call: OutcomeCall,
): Promise<PostCallMailRead> {
  const rep = repEmailFor(call);
  if (!rep) return { status: "no_rep" };
  if (!allowedMailboxes().includes(rep)) {
    return { status: "no_mailbox_access", mailbox: rep };
  }

  const domains = Array.from(
    new Set(
      customerEmailsOf(call.participants)
        .map((e) => domainOf(e))
        .filter((d): d is string => Boolean(d)),
    ),
  );
  if (domains.length === 0) return { status: "no_domains" };

  const since = new Date(call.at);
  if (Number.isNaN(since.getTime())) return { status: "bad_call_date", at: call.at };

  try {
    const msgs = await listMailboxMessages({
      tenantIdOrDomain: GRAPH_TENANT,
      mailbox: rep,
      since,
      domains,
      maxPages: 3,
    });
    const outbound = msgs
      .filter((m) => m.outbound)
      .filter((m) => [...m.to, ...m.cc].some((a) => domains.includes(domainOf(a) ?? "")))
      // Outlook's own acceptances and invite forwards are outbound mail the rep
      // did not write. "Accepted: Magaya Demo" was being counted as the rep
      // following up, which credits a click as work.
      .filter((m) => !isCalendarResponseSubject(m.subject));
    // The customer's own mail, PLUS the signing service's. Not the seller's own
    // domain: a Magaya address arriving inbound is a colleague on the thread,
    // and crediting that as the customer replying is the mistake this filter
    // exists to prevent.
    const inbound = msgs
      .filter((m) => !m.outbound)
      .filter((m) => {
        const from = domainOf(m.from ?? "");
        return domains.includes(from ?? "") || isSignatureServiceDomain(from);
      })
      .filter((m) => !isCalendarResponseSubject(m.subject));
    return { status: "read", mailbox: rep, domains, outbound, inbound };
  } catch (err) {
    return {
      status: "unavailable",
      mailbox: rep,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * NOT "did the rep send our draft".
 *
 * We hold Mail.ReadWrite and deliberately not Mail.Send, so the draft sits in
 * the rep's Outlook and they send it themselves. We do not persist the Graph
 * draft message id, so a sent message cannot be joined back to the draft we
 * wrote. What this measures is whether an outbound message to the customer
 * left the rep's mailbox after the call, which is the closest honest thing.
 * Joining the two properly needs the draft id stored at creation, which
 * belongs with the follow-up recipients change.
 *
 * The mailbox read is the same one at lib/followup-draft.ts, which already
 * refuses to treat an unreadable mailbox as "no follow-up happened".
 */
export async function readDraftSent(
  call: OutcomeCall,
  prefetched?: PostCallMailRead,
): Promise<OutcomeRead> {
  const mail = prefetched ?? (await readPostCallCustomerMail(call));
  switch (mail.status) {
    case "no_rep":
      return { value: "unknown", reason: "no rep email on the deal" };
    case "no_mailbox_access":
      return {
        value: "unknown",
        reason: `${mail.mailbox} is not on GRAPH_MAIL_ALLOWED_MAILBOXES`,
      };
    case "no_domains":
      return { value: "unknown", reason: "no customer-side attendee on the call to match against" };
    case "bad_call_date":
      return { value: "unknown", reason: `call has an unparseable date: ${mail.at}` };
    case "unavailable":
      return {
        value: "unknown",
        reason: `could not read ${mail.mailbox}'s mailbox: ${mail.error}`,
      };
    case "read": {
      const sent = mail.outbound[0];
      if (sent) {
        return { value: "yes", reason: `outbound mail to the customer: "${sent.subject}"` };
      }
      return {
        value: "no",
        reason: `${mail.mailbox}'s mailbox was read and holds no mail the rep wrote to ${mail.domains.join(", ")} after the call`,
      };
    }
  }
}

// =====================================================================
// 3. Did the CRM stage move across the call
// =====================================================================

type SnapshotSignals = {
  rolldog?: RolldogSnapshot | null;
  rolldogRead?: RolldogReadStatus;
  salesforce?: SalesforceSnapshot | null;
  salesforceRead?: SalesforceReadStatus;
  /** DealRipe's own stage, inferred from the extraction. */
  stage?: string;
  /** Framework fields the calls have answered Yes. The learning signal. */
  answered?: string[];
};

/**
 * Whether a stored snapshot actually carries a Rolldog reading.
 *
 * rolldogRead was added with this work. Snapshots written before it carry no
 * status at all, and for those the presence of a rolldog block is itself
 * evidence the read succeeded: the block only exists because Rolldog answered.
 * A block-less snapshot with no status is genuinely ambiguous (no opportunity,
 * failed read, or a deals lookup that failed) and is treated as unknown.
 */
function rolldogOf(signals: unknown): RolldogSnapshot | null {
  const s = (signals ?? {}) as SnapshotSignals;
  if (s.rolldogRead === "read") return s.rolldog ?? null;
  if (s.rolldogRead === undefined && s.rolldog) return s.rolldog;
  return null;
}

/** The stage identity to compare. Prefer the key; fall back to the name. */
function stageOf(snap: RolldogSnapshot): string | null {
  return snap.stageKey ?? snap.stageName ?? null;
}

/**
 * The same question of a Salesforce block, and the same refusal to guess.
 *
 * `salesforceRead === undefined` means the snapshot predates this field, so we
 * genuinely do not know whether Salesforce was read that day. It returns null
 * and the caller reports unknown, exactly as it does for an old rolldog-less
 * snapshot. There is deliberately no `s.salesforce` fallback for the undefined
 * case: unlike the rolldog block, this one never existed before the status
 * field did, so a block with no status cannot occur and inventing a path for
 * it would be dead code that looks like a rule.
 */
function salesforceOf(signals: unknown): SalesforceSnapshot | null {
  const s = (signals ?? {}) as SnapshotSignals;
  return s.salesforceRead === "read" ? (s.salesforce ?? null) : null;
}

/**
 * Which opportunity a Salesforce stage belongs to, so two snapshots are only
 * compared when they describe the SAME opportunity.
 *
 * 45 of Magaya's 91 linked accounts carry more than one opportunity and the
 * snapshot records the most recently created open one. If a new opportunity is
 * created between two snapshots, the chosen opportunity flips and the stage
 * changes with it. That is not the deal advancing, it is us looking at a
 * different record, and reporting it as movement would manufacture exactly the
 * outcome this ledger exists to measure honestly.
 */
function sameOpportunity(a: SalesforceSnapshot, b: SalesforceSnapshot): boolean {
  return a.opportunityId === b.opportunityId;
}

/**
 * Source: deal_signal_snapshots, written every 4 hours by lib/snapshot.ts,
 * holding Rolldog's own stage verbatim in signals.rolldog.
 *
 * Deliberately NOT signals.stage, which is DealRipe's stage inferred from the
 * extraction. That moves when a call confirms a field, which would make this
 * column measure our own extraction rather than the customer's CRM. That
 * refusal still stands and is the whole point of this column: it is the PROOF
 * column, and it is worth having precisely because it does not depend on
 * anything DealRipe reports about itself. The self-referential view lives
 * beside it in readQualificationAdvanced and is never quoted as proof.
 *
 * BOTH CRMs, since 2026-08-20. Rolldog first, then the Salesforce opportunity
 * stage. Before that this path read Rolldog alone, so a Salesforce-only deal
 * reported unknown permanently: 59 of 111 Magaya deals are Salesforce-only and
 * 15 have no link, so 74 of 111 could never report movement and
 * outcome_stage_moved was unknown on 243 of 283 prescriptions. Kiddom is
 * Salesforce throughout and would have been unknown on every row.
 *
 * What has NOT changed is the refusal to report an unreadable CRM as "no". A
 * deal we could not read is a deal we did not check.
 */
export async function readStageMoved(call: OutcomeCall): Promise<OutcomeRead> {
  const db = supabaseAdmin();
  const day = call.at.slice(0, 10);

  const [beforeRes, afterRes] = await Promise.all([
    db
      .from("deal_signal_snapshots")
      .select("snapshot_date, signals")
      .eq("tenant_id", call.tenantId)
      .eq("deal_id", call.dealId)
      .lt("snapshot_date", day)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Strictly after the call's day. The row for the call's own day is upserted
    // through the day, so it may hold a value read before the call started and
    // cannot be used as the "after" side.
    db
      .from("deal_signal_snapshots")
      .select("snapshot_date, signals")
      .eq("tenant_id", call.tenantId)
      .eq("deal_id", call.dealId)
      .gt("snapshot_date", day)
      .order("snapshot_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  if (beforeRes.error) {
    return { value: "unknown", reason: `snapshot lookup failed: ${beforeRes.error.message}` };
  }
  if (afterRes.error) {
    return { value: "unknown", reason: `snapshot lookup failed: ${afterRes.error.message}` };
  }
  if (!beforeRes.data) {
    return { value: "unknown", reason: `no snapshot before ${day}` };
  }
  if (!afterRes.data) {
    return { value: "unknown", reason: `no snapshot after ${day} yet` };
  }

  const wasOn = beforeRes.data.snapshot_date;
  const nowOn = afterRes.data.snapshot_date;

  // --- Rolldog, where the deal has an opportunity there.
  const rdBefore = rolldogOf(beforeRes.data.signals);
  const rdAfter = rolldogOf(afterRes.data.signals);
  if (rdBefore && rdAfter) {
    const from = stageOf(rdBefore);
    const to = stageOf(rdAfter);
    if (from !== null && to !== null) {
      return from === to
        ? { value: "no", reason: `Rolldog stage was ${from} on ${wasOn} and still ${to} on ${nowOn}` }
        : { value: "yes", reason: `Rolldog stage moved ${from} to ${to} by ${nowOn}` };
    }
    // A reading with no stage is the nine linked opportunities sitting at 0 or
    // -1 with a null name. That is a fact about their CRM, not a parse
    // failure, and it is not "did not move": fall through to Salesforce, which
    // for seven of those nine is the system that actually knows.
  }

  // --- Salesforce, which is the only CRM for 59 of 111 deals.
  const sfBefore = salesforceOf(beforeRes.data.signals);
  const sfAfter = salesforceOf(afterRes.data.signals);
  if (sfBefore && sfAfter) {
    if (!sameOpportunity(sfBefore, sfAfter)) {
      return {
        value: "unknown",
        reason:
          `the Salesforce opportunity changed between ${wasOn} and ${nowOn} ` +
          `(${sfBefore.opportunityId} to ${sfAfter.opportunityId}), so the two stages describe ` +
          `different records and comparing them would invent a move`,
      };
    }
    return sfBefore.stageName === sfAfter.stageName
      ? {
          value: "no",
          reason: `Salesforce stage was ${sfBefore.stageName} on ${wasOn} and still ${sfAfter.stageName} on ${nowOn}`,
        }
      : {
          value: "yes",
          reason: `Salesforce stage moved ${sfBefore.stageName} to ${sfAfter.stageName} by ${nowOn}`,
        };
  }

  // --- Neither CRM answered on both sides. Say which, so the row explains
  // itself without anyone re-running the read against a CRM that has since
  // moved on.
  const describe = (
    label: string,
    b: unknown | null,
    a: unknown | null,
  ): string | null => (b && a ? null : !b && !a ? `no ${label} reading on either side` : !b ? `no ${label} reading on ${wasOn}` : `no ${label} reading on ${nowOn}`);

  const why = [describe("Rolldog", rdBefore, rdAfter), describe("Salesforce", sfBefore, sfAfter)]
    .filter(Boolean)
    .join("; ");

  return {
    value: "unknown",
    reason: `${why}. We did not check, which is not the same as the stage not moving`,
  };
}

/**
 * Did DealRipe's OWN read of the deal advance across this call?
 *
 * THE COMPANION TO readStageMoved, AND DELIBERATELY A DIFFERENT INSTRUMENT.
 *
 * readStageMoved asks what the customer's CRM said. It is the proof column,
 * it is worth having because it is independent of us, and it is silent
 * whenever a rep has not touched their CRM. Reps at Magaya frequently have
 * not: nine linked opportunities sit at stage 0 or -1 with a null name, and
 * seven of those deals had already closed in the other system.
 *
 * This asks a question we can always answer: did the call produce qualification
 * evidence that was not there before. It is self-referential by construction,
 * so it TRAINS the loop and is never shown to a customer as evidence a deal
 * moved. Anything reporting to a CRO uses readStageMoved. Anything learning
 * uses this. A caller that wants "did the deal move" without saying which kind
 * of evidence it means has not finished thinking.
 *
 * The primitive is the answered-field set rather than the inferred stage.
 * signals.stage is itself derived from the extraction, so a stage change is a
 * lossy summary of the thing we actually care about: WHICH fields this call
 * newly evidenced. A call can answer four fields without crossing a stage
 * boundary, and that call did work the ledger should record.
 *
 * A shrinking set is reported as no rather than yes. Fields go from Yes back
 * to Unknown when lib/grounding.ts cannot find the evidence quote in the
 * transcript, which is a correction to a previous read and not the deal
 * going backwards.
 */
export async function readQualificationAdvanced(call: OutcomeCall): Promise<OutcomeRead> {
  const db = supabaseAdmin();
  const day = call.at.slice(0, 10);

  const [beforeRes, afterRes] = await Promise.all([
    db
      .from("deal_signal_snapshots")
      .select("snapshot_date, signals")
      .eq("tenant_id", call.tenantId)
      .eq("deal_id", call.dealId)
      .lt("snapshot_date", day)
      .order("snapshot_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db
      .from("deal_signal_snapshots")
      .select("snapshot_date, signals")
      .eq("tenant_id", call.tenantId)
      .eq("deal_id", call.dealId)
      .gt("snapshot_date", day)
      .order("snapshot_date", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  if (beforeRes.error || afterRes.error) {
    const msg = beforeRes.error?.message ?? afterRes.error?.message ?? "unknown error";
    return { value: "unknown", reason: `snapshot lookup failed: ${msg}` };
  }
  if (!beforeRes.data) return { value: "unknown", reason: `no snapshot before ${day}` };
  if (!afterRes.data) return { value: "unknown", reason: `no snapshot after ${day} yet` };

  const before = (beforeRes.data.signals ?? {}) as SnapshotSignals;
  const after = (afterRes.data.signals ?? {}) as SnapshotSignals;

  // An absent array is not an empty one. A snapshot written before `answered`
  // existed would otherwise read as "this deal had answered nothing", making
  // every field on the later side look newly gained.
  if (!Array.isArray(before.answered) || !Array.isArray(after.answered)) {
    const which =
      !Array.isArray(before.answered) && !Array.isArray(after.answered)
        ? "neither snapshot"
        : !Array.isArray(before.answered)
          ? `the ${beforeRes.data.snapshot_date} snapshot`
          : `the ${afterRes.data.snapshot_date} snapshot`;
    return {
      value: "unknown",
      reason: `${which} records an answered-field set, so there is nothing to compare`,
    };
  }

  const had = new Set(before.answered);
  const gained = after.answered.filter((f) => !had.has(f));
  const stageNote =
    before.stage && after.stage && before.stage !== after.stage
      ? `, and our stage read moved ${before.stage} to ${after.stage}`
      : "";

  if (gained.length > 0) {
    const shown = gained.slice(0, 4).join(", ");
    const rest = gained.length > 4 ? ` and ${gained.length - 4} more` : "";
    return {
      value: "yes",
      reason: `the calls newly evidenced ${gained.length} field(s) by ${afterRes.data.snapshot_date}: ${shown}${rest}${stageNote}`,
    };
  }

  const lost = before.answered.filter((f) => !new Set(after.answered).has(f));
  const lostNote = lost.length > 0 ? ` (${lost.length} field(s) went back to unproven, which is a correction rather than a reversal)` : "";
  return {
    value: "no",
    reason: `no field moved to answered between ${beforeRes.data.snapshot_date} and ${afterRes.data.snapshot_date}${lostNote}`,
  };
}

// =====================================================================

/**
 * All four, run together. Independent of each other by design: a deal can
 * book a next meeting without an email, and move stage without either.
 *
 * Returns the mailbox read alongside them so the caller can reuse it for the
 * end-commitment email pass instead of paying for it twice.
 */
export async function readCallOutcomes(
  call: OutcomeCall,
): Promise<CallOutcomes & { mail: PostCallMailRead }> {
  const mail = await readPostCallCustomerMail(call);
  const [nextMeeting, draftSent, stageMoved, qualificationAdvanced] = await Promise.all([
    readNextMeeting(call),
    readDraftSent(call, mail),
    readStageMoved(call),
    readQualificationAdvanced(call),
  ]);
  return { nextMeeting, draftSent, stageMoved, qualificationAdvanced, mail };
}
