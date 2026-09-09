/**
 * The events a deal actually produces, dated, between "nothing happened" and
 * "closed won".
 *
 * WHY MICRO OUTCOMES ARE THE LEARNABLE UNIT HERE.
 *
 * DealRipe has observed 26 closes, and five of the losses are a single hygiene
 * sweep Mitch Nemmers ran in 90 seconds on 2026-08-07. Nothing can be learned
 * from that, and waiting for more means waiting quarters: Magaya's cycle is
 * about 45 days and the pilot started mid-July.
 *
 * But a deal emits dozens of smaller, unambiguous events on the way. An NDA
 * comes back executed. A demo gets booked after a discovery call. A deal that
 * went quiet for three weeks puts a meeting back on the calendar. A stage moves.
 * Each of those is a real thing that either happened or did not, each carries a
 * date, and together they run to hundreds a month against 26 closes a quarter.
 *
 * That is the substrate. "Which question preceded the decision-process gate
 * flipping on 14 deals" is answerable in weeks. "Which question wins deals" is
 * not answerable this year.
 *
 * EVERY OUTCOME CARRIES ITS EVIDENCE AND A SOURCE POINTER, so any claim built
 * on this is auditable back to the row that produced it. That is the rule the
 * company brain has to obey or it becomes the hardcoded CALIBRATION constant in
 * lib/forecast-room.ts, which asserts 90% against a rep's 63% and was never
 * computed from a Magaya outcome.
 *
 * WHAT IT REFUSES TO DO. It never infers an outcome from an absence. A deal
 * with no NDA row did not "fail to sign an NDA"; we have no evidence either
 * way, and half this codebase's scar tissue is that distinction.
 */

import { supabaseAdmin } from "./supabase";

export type MicroOutcomeKind =
  /** An agreement came back executed. Adobe Sign said so. */
  | "nda_executed"
  | "quote_executed"
  /** A meeting was scheduled that had not been scheduled before. */
  | "meeting_booked"
  /**
   * The same, split by what KIND of meeting it was. A second discovery call
   * usually means the first did not land; a demo is an advance; a proposal call
   * is late stage. One label averages a retreat with an advance.
   */
  | "meeting_booked_discovery"
  | "meeting_booked_demo"
  | "meeting_booked_proposal"
  | "meeting_booked_follow_up"
  | "meeting_booked_customer"
  /** A demo followed a discovery call on the same deal. */
  | "demo_after_discovery"
  /** Silence of 14+ days, then a meeting or an inbound reply. */
  | "reengaged_after_silence"
  /** The CRM stage moved forward, per Salesforce's own field history. */
  | "stage_advanced"
  /** A qualification gate flipped. Forward-looking only; no history exists. */
  | "gate_flipped"
  /** The macro outcomes. Rare, and deliberately not the training target. */
  | "closed_won"
  | "closed_lost";

export type MicroOutcome = {
  dealId: string;
  kind: MicroOutcomeKind;
  /** When it happened in the world. */
  occurredAt: string;
  /** Human-readable, and safe to print: no customer prose. */
  evidence: string;
  /** Which table and row said so, so any claim is auditable. */
  source: { table: string; id: string };
};

const SILENCE_DAYS = 14;

type Msg = {
  id: string;
  deal_id: string;
  direction: string;
  customer_side: boolean | null;
  is_machine_sender: boolean | null;
  is_calendar_response: boolean;
  sent_at: string | null;
  agreement_kind: string | null;
  agreement_state: string | null;
};

type Call = {
  id: string;
  deal_id: string;
  call_date: string | null;
  scheduled_start: string | null;
  call_subtype: string | null;
  meeting_type: string | null;
};

async function pageAll<T>(table: string, cols: string, tenantId: string | null): Promise<T[]> {
  const db = supabaseAdmin() as unknown as {
    from: (t: string) => { select: (c: string) => unknown };
  };
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: unknown = db.from(table).select(cols);
    if (tenantId) q = (q as { eq: (a: string, b: string) => unknown }).eq("tenant_id", tenantId);
    q = (q as { order: (c: string, o: unknown) => unknown }).order("id", { ascending: true });
    q = (q as { range: (a: number, b: number) => unknown }).range(from, from + 999);
    const res = (await (q as Promise<{ data: T[] | null; error: { message: string } | null }>));
    // A failed page is not an empty page. Returning what we have would under-
    // report every outcome downstream and look like a quiet deal book.
    if (res.error) throw new Error(`${table} read failed: ${res.error.message}`);
    const rows = res.data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const day = (s: string | null | undefined) => String(s ?? "").slice(0, 10);

/**
 * Every micro outcome DealRipe can evidence, across the whole tenant.
 *
 * Loaded in bulk rather than per deal: the learning join wants all of them at
 * once, and 204 deals of per-deal queries is 1,200 round trips.
 */
export async function detectMicroOutcomes(tenantId: string): Promise<MicroOutcome[]> {
  const [msgs, calls, crm, gates, deals] = await Promise.all([
    pageAll<Msg>(
      "deal_messages",
      "id, deal_id, direction, customer_side, is_machine_sender, is_calendar_response, sent_at, agreement_kind, agreement_state",
      tenantId,
    ),
    pageAll<Call>("calls", "id, deal_id, call_date, scheduled_start, call_subtype, meeting_type", tenantId),
    pageAll<{ id: string; deal_id: string | null; field: string; old_value: string | null; new_value: string | null; changed_at: string }>(
      "crm_field_events",
      "id, deal_id, field, old_value, new_value, changed_at",
      tenantId,
    ),
    pageAll<{ id: string; deal_id: string; framework_field_key: string; from_status: string | null; to_status: string; occurred_at: string | null; observed_at: string }>(
      "field_extraction_events",
      "id, deal_id, framework_field_key, from_status, to_status, occurred_at, observed_at",
      tenantId,
    ),
    pageAll<{ id: string; outcome_label: string | null; outcome_close_date: string | null; outcome_reason: string | null }>(
      "deals",
      "id, outcome_label, outcome_close_date, outcome_reason",
      tenantId,
    ),
  ]);

  const out: MicroOutcome[] = [];

  // --- agreements executed -------------------------------------------------
  for (const m of msgs) {
    if (m.agreement_state !== "executed" || !m.sent_at) continue;
    const kind = m.agreement_kind === "nda" ? "nda_executed" : m.agreement_kind === "quote" ? "quote_executed" : null;
    if (!kind) continue;
    out.push({
      dealId: m.deal_id,
      kind,
      occurredAt: m.sent_at,
      evidence: `Adobe Sign reported the ${m.agreement_kind} executed`,
      source: { table: "deal_messages", id: m.id },
    });
  }

  // --- meetings, and the demo-after-discovery sequence ---------------------
  const callsByDeal = new Map<string, Call[]>();
  for (const c of calls) callsByDeal.set(c.deal_id, [...(callsByDeal.get(c.deal_id) ?? []), c]);

  for (const [dealId, list] of callsByDeal) {
    const sorted = list
      .filter((c) => c.call_date || c.scheduled_start)
      .sort((a, b) => day(a.call_date ?? a.scheduled_start).localeCompare(day(b.call_date ?? b.scheduled_start)));

    // Every meeting after the first is one that got booked while the deal was
    // already running, which is the thing worth counting. The first meeting is
    // the BDR's work, not the deal's progression.
    //
    // AND THE TYPE MATTERS. A second discovery call, a demo, and a proposal
    // call are three different events wearing one label: the first often means
    // the first call did not land, the second is the step a Magaya briefing
    // most often asks for, the third is late-stage. Collapsing them into
    // "meeting_booked" averages a retreat with an advance. Both the generic
    // kind and the specific one are emitted, so a caller can ask either
    // question without re-deriving the sequence.
    for (let i = 1; i < sorted.length; i++) {
      const c = sorted[i];
      const at = String(c.call_date ?? c.scheduled_start);
      out.push({
        dealId,
        kind: "meeting_booked",
        occurredAt: at,
        evidence: `meeting ${i + 1} on the deal${c.call_subtype ? ` (${c.call_subtype})` : ""}`,
        source: { table: "calls", id: c.id },
      });
      // call_subtype is written by transcript-sync AFTER capture, so a meeting
      // that has not happened yet, or whose bot never got in, has none. That is
      // "unclassified", never a category of its own invention.
      if (c.call_subtype && c.call_subtype !== "internal") {
        out.push({
          dealId,
          kind: `meeting_booked_${c.call_subtype}` as MicroOutcomeKind,
          occurredAt: at,
          evidence: `a ${c.call_subtype} call was the next meeting`,
          source: { table: "calls", id: c.id },
        });
      }
    }

    // A demo that follows a discovery call. Named separately because it is the
    // single most common next step a Magaya briefing asks for.
    const firstDiscovery = sorted.find((c) => c.call_subtype === "discovery");
    if (firstDiscovery) {
      const demo = sorted.find(
        (c) =>
          c.call_subtype === "demo" &&
          day(c.call_date ?? c.scheduled_start) > day(firstDiscovery.call_date ?? firstDiscovery.scheduled_start),
      );
      if (demo) {
        out.push({
          dealId,
          kind: "demo_after_discovery",
          occurredAt: String(demo.call_date ?? demo.scheduled_start),
          evidence: "a demo followed the discovery call",
          source: { table: "calls", id: demo.id },
        });
      }
    }
  }

  // --- re-engagement after silence ----------------------------------------
  //
  // Silence is measured on REAL two-way contact: machine senders and calendar
  // auto-responses are not the customer, and counting them once made a robot's
  // reply look like the only human contact on Master Cargo.
  const contactByDeal = new Map<string, string[]>();
  for (const m of msgs) {
    if (m.is_calendar_response || m.is_machine_sender || !m.sent_at) continue;
    contactByDeal.set(m.deal_id, [...(contactByDeal.get(m.deal_id) ?? []), m.sent_at]);
  }
  for (const m of msgs) {
    // The re-engagement itself is an INBOUND message from the customer after a
    // gap. An outbound chase is us trying, not them responding.
    if (m.direction !== "inbound" || m.customer_side !== true) continue;
    if (m.is_calendar_response || m.is_machine_sender || !m.sent_at) continue;
    const prior = (contactByDeal.get(m.deal_id) ?? [])
      .filter((t) => t < String(m.sent_at))
      .sort();
    const last = prior[prior.length - 1];
    if (!last) continue;
    const gap = (Date.parse(String(m.sent_at)) - Date.parse(last)) / 86_400_000;
    if (!Number.isFinite(gap) || gap < SILENCE_DAYS) continue;
    out.push({
      dealId: m.deal_id,
      kind: "reengaged_after_silence",
      occurredAt: m.sent_at,
      evidence: `customer wrote after ${Math.round(gap)} days of silence`,
      source: { table: "deal_messages", id: m.id },
    });
  }

  // --- stage advanced ------------------------------------------------------
  //
  // Forward only, and "forward" is decided positionally where we can. Rolldog
  // ids run 200/202/204/208; Salesforce stage names are free text, so any
  // change with a new value counts and the direction is left to the reader
  // rather than guessed at from a string.
  for (const e of crm) {
    if (!e.deal_id || e.field !== "StageName") continue;
    if (!e.new_value || e.new_value === e.old_value) continue;
    out.push({
      dealId: e.deal_id,
      kind: "stage_advanced",
      occurredAt: e.changed_at,
      evidence: `CRM stage ${e.old_value ?? "(none)"} -> ${e.new_value}`,
      source: { table: "crm_field_events", id: e.id },
    });
  }

  // --- gate flipped --------------------------------------------------------
  //
  // Only real transitions. A from_status of null is the backfilled floor, which
  // records what was already true rather than something that moved, and
  // counting it would date every deal's whole qualification history to the day
  // the table was created.
  for (const g of gates) {
    if (g.from_status === null) continue;
    if (g.from_status === g.to_status) continue;
    out.push({
      dealId: g.deal_id,
      kind: "gate_flipped",
      occurredAt: g.occurred_at ?? g.observed_at,
      evidence: `${g.framework_field_key}: ${g.from_status} -> ${g.to_status}`,
      source: { table: "field_extraction_events", id: g.id },
    });
  }

  // --- macro --------------------------------------------------------------
  for (const d of deals) {
    if (d.outcome_label !== "won" && d.outcome_label !== "lost") continue;
    out.push({
      dealId: d.id,
      kind: d.outcome_label === "won" ? "closed_won" : "closed_lost",
      occurredAt: d.outcome_close_date ?? "",
      evidence: d.outcome_reason ? `closed ${d.outcome_label}: ${d.outcome_reason}` : `closed ${d.outcome_label}`,
      source: { table: "deals", id: d.id },
    });
  }

  return out.filter((o) => o.occurredAt).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}
