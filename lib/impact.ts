/**
 * Impact scoreboard, the renewal artifact.
 *
 * Tallies DealRipe's quantifiable value across the pilot from data already
 * captured: recaps and briefings sent, qualification fields captured that a rep
 * never typed, calls captured, risks surfaced, deals whose CRM DealRipe updated.
 * Turns "it felt useful" into a number the CRO can put against a price at
 * pilot-end. Every time estimate is stated on the page so the model is defensible.
 */

import { isMeaningfulContact } from "./contacts-extract";
import { supabaseAdmin } from "./supabase";

// Conservative per-item time estimates (minutes). Stated on the scoreboard.
const RECAP_MIN = 10; // manual note-writing after a call
const BRIEFING_MIN = 15; // pre-call prep + research
const FIELD_MIN = 1; // manual CRM field entry

const NO_CONTENT = new Set(["no_conversation", "no_show", "rescheduled", "placeholder", "capture_failed"]);
const BUYER_RE = /budget|cfo|chief financ|owner|final|economic|controller/i;

export type ImpactBreakdown = { label: string; count: number; minEach: number; hours: number };

export type ImpactScoreboard = {
  hoursSaved: number;
  breakdown: ImpactBreakdown[];
  recapsSent: number;
  briefingsSent: number;
  callsCaptured: number;
  fieldsAutoLogged: number;
  dealsWrittenBack: number;
  darkBuyersSurfaced: number;
  noShowsCaught: number;
  dealsTracked: number;
};

export async function buildImpactScoreboard(tenantId: string): Promise<ImpactScoreboard> {
  const db = supabaseAdmin();
  const [msgs, fe, calls, contacts, deals] = await Promise.all([
    db.from("sent_messages").select("kind").eq("tenant_id", tenantId),
    db.from("field_extractions").select("status").eq("tenant_id", tenantId),
    db
      .from("calls")
      .select("id, outcome, scheduled_start, call_date, has_been_extracted")
      .eq("tenant_id", tenantId),
    db.from("contacts").select("relationship, role, last_contacted_at").eq("tenant_id", tenantId),
    db.from("deals").select("id, dealripe_last_writeback_at").eq("tenant_id", tenantId),
  ]);

  const kinds = (msgs.data ?? []) as Array<{ kind: string }>;
  const recapsSent = kinds.filter((m) => m.kind === "recap").length;
  const briefingsSent = kinds.filter((m) => m.kind === "briefing").length;
  const fieldsAutoLogged = ((fe.data ?? []) as Array<{ status: string }>).filter(
    (f) => f.status === "Yes",
  ).length;

  const now = Date.now();
  const callRows = (calls.data ?? []) as Array<{
    outcome: string | null;
    scheduled_start: string | null;
    call_date: string | null;
    has_been_extracted: boolean;
  }>;
  const callsCaptured = callRows.filter(
    (c) => c.has_been_extracted && !(c.outcome && NO_CONTENT.has(c.outcome)),
  ).length;
  const noShowsCaught = callRows.filter((c) => {
    if (!c.outcome || !NO_CONTENT.has(c.outcome)) return false;
    const t = Date.parse(c.scheduled_start ?? c.call_date ?? "");
    return Number.isFinite(t) && t <= now;
  }).length;

  const contactRows = (contacts.data ?? []) as Array<{
    relationship: string | null;
    role: string | null;
    last_contacted_at: string | null;
  }>;
  const darkBuyersSurfaced = contactRows.filter(
    (c) =>
      isMeaningfulContact(c) &&
      !c.last_contacted_at &&
      (String(c.relationship) === "economic_buyer" || BUYER_RE.test(String(c.role ?? ""))),
  ).length;

  const dealRows = (deals.data ?? []) as Array<{ dealripe_last_writeback_at: string | null }>;
  const dealsWrittenBack = dealRows.filter((d) => d.dealripe_last_writeback_at).length;
  const dealsTracked = dealRows.length;

  const breakdown: ImpactBreakdown[] = [
    { label: "Post-call recaps auto-written", count: recapsSent, minEach: RECAP_MIN, hours: (recapsSent * RECAP_MIN) / 60 },
    { label: "Pre-call briefings prepared", count: briefingsSent, minEach: BRIEFING_MIN, hours: (briefingsSent * BRIEFING_MIN) / 60 },
    { label: "Qualification fields captured (never typed by a rep)", count: fieldsAutoLogged, minEach: FIELD_MIN, hours: (fieldsAutoLogged * FIELD_MIN) / 60 },
  ];
  const hoursSaved = breakdown.reduce((s, b) => s + b.hours, 0);

  return {
    hoursSaved,
    breakdown,
    recapsSent,
    briefingsSent,
    callsCaptured,
    fieldsAutoLogged,
    dealsWrittenBack,
    darkBuyersSurfaced,
    noShowsCaught,
    dealsTracked,
  };
}
