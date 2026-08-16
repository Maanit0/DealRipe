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
  stageMoved: OutcomeRead;
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
  | { status: "read"; mailbox: string; domains: string[]; outbound: MailMessage[] }
  | { status: "no_rep" }
  | { status: "no_mailbox_access"; mailbox: string }
  | { status: "no_domains" }
  | { status: "bad_call_date"; at: string }
  | { status: "unavailable"; mailbox: string; error: string };

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
    return { status: "read", mailbox: rep, domains, outbound };
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
 * Source: deal_signal_snapshots, written every 4 hours by lib/snapshot.ts,
 * holding Rolldog's own stage verbatim in signals.rolldog.
 *
 * Deliberately NOT signals.stage, which is DealRipe's stage inferred from the
 * extraction. That moves when a call confirms a field, which would make this
 * column measure our own extraction rather than the customer's CRM.
 *
 * A Salesforce-only deal has no Rolldog opportunity and therefore reports
 * unknown, permanently. That is correct: we do not read a Salesforce stage on
 * this path, and reporting its absence as "no movement" would be an invented
 * negative about a deal that may well have moved.
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

  const before = rolldogOf(beforeRes.data.signals);
  const after = rolldogOf(afterRes.data.signals);
  if (!before || !after) {
    const which = !before && !after ? "neither snapshot" : !before ? "the earlier snapshot" : "the later snapshot";
    return {
      value: "unknown",
      reason: `${which} carries a Rolldog reading, so we did not check, which is not the same as the stage not moving`,
    };
  }

  const from = stageOf(before);
  const to = stageOf(after);
  if (from === null || to === null) {
    return { value: "unknown", reason: "a Rolldog reading carries no stage" };
  }
  if (from === to) {
    return { value: "no", reason: `stage was ${from} on ${beforeRes.data.snapshot_date} and still ${to} on ${afterRes.data.snapshot_date}` };
  }
  return { value: "yes", reason: `stage moved ${from} to ${to} by ${afterRes.data.snapshot_date}` };
}

// =====================================================================

/**
 * All three, run together. Independent of each other by design: a deal can
 * book a next meeting without an email, and move stage without either.
 *
 * Returns the mailbox read alongside them so the caller can reuse it for the
 * end-commitment email pass instead of paying for it twice.
 */
export async function readCallOutcomes(
  call: OutcomeCall,
): Promise<CallOutcomes & { mail: PostCallMailRead }> {
  const mail = await readPostCallCustomerMail(call);
  const [nextMeeting, draftSent, stageMoved] = await Promise.all([
    readNextMeeting(call),
    readDraftSent(call, mail),
    readStageMoved(call),
  ]);
  return { nextMeeting, draftSent, stageMoved, mail };
}
