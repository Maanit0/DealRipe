/**
 * Keep the RSVP instead of overwriting it.
 *
 * calendar-sync refreshes calls.participants on every pass so the roster stays
 * current. That is correct for the roster and lossy for the response: an
 * attendee who declined on Monday and accepted on Wednesday leaves a row that
 * says "accepted" and no evidence they ever hesitated, and one who was removed
 * from the invite leaves nothing whatsoever.
 *
 * This is the only capture gap where DealRipe already has the data and deletes
 * it. Graph returns responseStatus per attendee, calendar-sync stores it, and
 * lib/attendee-context.ts reads it at render time to say who has accepted.
 * Nothing keeps it.
 *
 * WHAT COUNTS AS AN EVENT. A change, and only a change. Writing a row per
 * attendee per five-minute sync would produce a sync log rather than a
 * trajectory, which is the mistake deal_signal_snapshots made by putting a
 * capturedAt inside its own payload and reporting 47 changes across 48 days
 * when there were 8.
 *
 * BEST EFFORT BY DESIGN. calendar-sync decides whether to dispatch a bot to a
 * customer meeting. Instrumentation beside it must never be able to fail that,
 * so every path here swallows its own errors after logging them.
 */

import { isSeller } from "./attendees";
import { readParticipants, type Participant } from "./speaker-match";
import { supabaseAdmin } from "./supabase";

/** Graph's own vocabulary, plus one of ours. */
export type ResponseValue = "accepted" | "declined" | "tentativelyAccepted" | "none" | "organizer" | "removed" | string;

export type ResponseChange = {
  email: string;
  displayName: string | null;
  customerSide: boolean | null;
  /** Null on the first observation of this person on this meeting. */
  fromResponse: ResponseValue | null;
  toResponse: ResponseValue;
  previousObservedAt: string | null;
};

function normalise(p: Participant): { email: string; name: string | null; response: string } | null {
  const email = (p.email ?? "").trim().toLowerCase();
  // No address, no identity. A display name cannot be followed across reads and
  // guessing an address from one invents a person, which is worse than a gap.
  if (!email) return null;
  return { email, name: (p.name ?? "").trim() || null, response: (p.responseStatus ?? "none").trim() || "none" };
}

function domainSide(email: string): boolean | null {
  const domain = email.split("@")[1] ?? "";
  if (!domain) return null;
  return !isSeller(email);
}

/**
 * Compare the roster we stored against the one Graph just returned.
 *
 * Pure, so it can be tested without a database and cannot disagree with what
 * the writer persists.
 */
export function diffResponses(args: {
  stored: unknown;
  incoming: ReadonlyArray<Participant>;
  previousObservedAt?: string | null;
}): ResponseChange[] {
  const prior = readParticipants(args.stored);
  const out: ResponseChange[] = [];

  // A legacy string[] roster carries no addresses, so nothing in it can be
  // compared. Treat it as "we have never seen this meeting's roster" rather
  // than as an empty invite: the incoming people are first observations, which
  // is true, instead of being reported as newly added.
  const before = new Map<string, { name: string | null; response: string }>();
  if (prior.status === "ok") {
    for (const p of prior.participants) {
      const n = normalise(p);
      if (n) before.set(n.email, { name: n.name, response: n.response });
    }
  }

  // CUSTOMER SIDE ONLY, and this is a bug fix rather than a scoping preference.
  //
  // Shipped 2026-09-08 without it and measured the next morning: 817 events
  // across TEN distinct (call, person) pairs, three of them flapping
  // none -> removed -> none -> removed several hundred times.
  //
  // The cause is the trap this module's own comment already names. The
  // ORGANIZER IS NOT IN participants, and who the organizer is depends on whose
  // calendar the meeting was read from: Alexandra is absent from the attendee
  // list on her own meeting and present when the same meeting is read from
  // another rep's mailbox. calendar-sync runs every five minutes across six
  // calendars, so the stored roster alternates and the diff calls each swap a
  // removal.
  //
  // Restricting to the customer side removes the whole class, because a
  // customer's presence does not depend on which of our mailboxes we happened
  // to read. It also matches what this log is FOR: "the economic buyer declined
  // the demo" is the signal. A colleague joining is already covered by
  // newColleagues in lib/attendee-context.ts, which reads the roster directly
  // and never diffs it.
  const seen = new Set<string>();
  for (const p of args.incoming) {
    const n = normalise(p);
    if (!n) continue;
    if (domainSide(n.email) !== true) continue;
    seen.add(n.email);
    const was = before.get(n.email);
    if (was && was.response === n.response) continue;
    out.push({
      email: n.email,
      displayName: n.name,
      customerSide: domainSide(n.email),
      fromResponse: was ? was.response : null,
      toResponse: n.response,
      previousObservedAt: was ? args.previousObservedAt ?? null : null,
    });
  }

  // Removal is a response, and a strong one. An economic buyer dropped from a
  // demo invite is invisible in every other table we keep.
  for (const [email, was] of before) {
    if (seen.has(email)) continue;
    if (domainSide(email) !== true) continue;
    out.push({
      email,
      displayName: was.name,
      customerSide: domainSide(email),
      fromResponse: was.response,
      toResponse: "removed",
      previousObservedAt: args.previousObservedAt ?? null,
    });
  }

  return out;
}

/**
 * Persist the changes. Never throws.
 *
 * Called from calendar-sync immediately before the update that overwrites
 * calls.participants, which is the exact line where the fact is lost.
 */
/**
 * Set once the table is known to be absent, so deploying ahead of
 * supabase/add-calendar-response-events.sql costs one log line per process
 * rather than one every five minutes for every meeting whose roster moved.
 * Still loud, and still visibly a failure, just not a flood.
 */
let tableMissing = false;

export async function recordResponseChanges(args: {
  tenantId: string;
  dealId: string;
  callId: string;
  meetingStart: string | null;
  changes: ResponseChange[];
}): Promise<number> {
  if (args.changes.length === 0 || tableMissing) return 0;
  try {
    const res = await supabaseAdmin()
      .from("calendar_response_events")
      .insert(
        args.changes.map((c) => ({
          tenant_id: args.tenantId,
          deal_id: args.dealId,
          call_id: args.callId,
          email: c.email,
          display_name: c.displayName,
          customer_side: c.customerSide,
          from_response: c.fromResponse,
          to_response: c.toResponse,
          meeting_start: args.meetingStart,
          previous_observed_at: c.previousObservedAt,
        })),
      )
      .select("id");
    if (res.error) {
      // PGRST205 is "table not in the schema cache", i.e. the migration has not
      // been applied. Distinguished from a real write failure, which must keep
      // reporting every time it happens.
      if (/schema cache|does not exist/i.test(res.error.message)) {
        tableMissing = true;
        console.error(
          `[rsvp-log] calendar_response_events is missing, RSVP history is NOT being recorded. ` +
            `Apply supabase/add-calendar-response-events.sql. Silencing this message for the rest of this process.`,
        );
        return 0;
      }
      console.error(`[rsvp-log] write failed (${args.changes.length} rows, call=${args.callId}): ${res.error.message}`);
      return 0;
    }
    return res.data?.length ?? 0;
  } catch (err) {
    console.error("[rsvp-log] write threw, continuing:", err);
    return 0;
  }
}
