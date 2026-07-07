/**
 * Server-side read layer for the live UI.
 *
 * The demo pages (pipeline, deal, prepare, extract) render the `Deal`
 * shape from lib/seed-data.ts. This module returns that exact shape, but
 * sourced from Supabase for a real tenant (e.g. "magaya"), so the same
 * components can render live pilot data.
 *
 * Tenant-scoped: every query filters by tenant_id. Pass the tenant UUID
 * (from the authenticated user's JWT claim, see middleware) or resolve a
 * slug with resolveTenantId() first.
 *
 * Reconstructing ExtractionResult: field_extractions stores answer /
 * evidence / confidence for answered fields. A row with an answer is
 * treated as status "Yes"; fields without a row default to "Unknown" when
 * read (consumers use `?? "Unknown"`). The No-vs-Unknown distinction is
 * not yet persisted (no status column); add one if the UI needs to show
 * an explicit red "No" for live deals.
 */

import { supabaseAdmin } from "./supabase";
import type { Contact, CallRecord, Deal } from "./seed-data";
import type { ExtractionResult } from "./scotsman";

const RELATIONSHIPS = [
  "champion",
  "influencer",
  "economic_buyer",
  "user",
  "unknown",
] as const;
type Relationship = (typeof RELATIONSHIPS)[number];

function asRelationship(v: unknown): Relationship {
  return RELATIONSHIPS.includes(v as Relationship) ? (v as Relationship) : "unknown";
}

function asParticipants(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

function rowToContact(r: {
  id: string;
  name: string;
  role: string | null;
  relationship: unknown;
  last_contacted_at: string | null;
}): Contact {
  return {
    id: r.id,
    name: r.name,
    role: r.role ?? "",
    relationship: asRelationship(r.relationship),
    lastContactedAt: r.last_contacted_at,
  };
}

function rowToCall(r: {
  id: string;
  deal_id: string;
  call_date: string | null;
  duration_minutes: number | null;
  participants: unknown;
  source: "gong" | "manual_paste" | "recall_ai" | null;
  transcript_id: string | null;
  has_been_extracted: boolean;
}): CallRecord {
  return {
    id: r.id,
    dealId: r.deal_id,
    date: r.call_date ?? "",
    durationMinutes: r.duration_minutes ?? 0,
    participants: asParticipants(r.participants),
    // The UI CallRecord union is gong | manual_paste; recall_ai (the
    // DealRipe bot) renders as a synced call.
    source: r.source === "manual_paste" ? "manual_paste" : "gong",
    transcriptId: r.transcript_id,
    hasBeenExtracted: r.has_been_extracted,
  };
}

function buildExtraction(
  rows: Array<{
    framework_field_key: string;
    status: "Yes" | "No" | "Unknown";
    answer: string | null;
    evidence: string | null;
    confidence: number | null;
  }>,
): ExtractionResult {
  const out: ExtractionResult = {};
  for (const r of rows) {
    if (r.status === "Yes" && r.answer) {
      out[r.framework_field_key] = {
        status: "Yes",
        answer: r.answer,
        evidence: r.evidence ?? "",
        confidence: r.confidence ?? 0,
      };
    } else if (r.status === "No") {
      out[r.framework_field_key] = { status: "No" };
    } else {
      out[r.framework_field_key] = { status: "Unknown" };
    }
  }
  return out;
}

/**
 * The deal's cumulative call-verified extraction: the field_extractions
 * roll-up (one row per field, latest call wins). This is the single source of
 * truth for confirmed-vs-gap in both the deal UI and the briefings, so they
 * never disagree. Rolldog is deliberately NOT merged in here; CRM-reported
 * values live in the separate day-0 baseline and never flip a gate.
 */
export async function getDealExtraction(dealId: string): Promise<ExtractionResult> {
  const db = supabaseAdmin();
  const fx = await db
    .from("field_extractions")
    .select("framework_field_key, status, answer, evidence, confidence")
    .eq("deal_id", dealId);
  if (fx.error) throw new Error(`field_extractions read failed: ${fx.error.message}`);
  return buildExtraction(fx.data ?? []);
}

function rowToDeal(
  d: {
    id: string;
    tenant_id: string;
    account: string;
    industry: string | null;
    arr: number | null;
    stage_key: string;
    days_in_stage: number | null;
    rep_forecast_probability: number | null;
    rep_forecast_close_date: string | null;
    rep_notes: string | null;
  },
  contacts: Contact[],
  calls: CallRecord[],
  extraction: ExtractionResult,
): Deal {
  return {
    id: d.id,
    tenantId: d.tenant_id,
    account: d.account,
    industry: d.industry ?? "",
    arr: d.arr ?? 0,
    stageKey: d.stage_key,
    daysInStage: d.days_in_stage ?? 0,
    repForecastProbability: d.rep_forecast_probability ?? 0,
    repForecastCloseDate: d.rep_forecast_close_date ?? "",
    contacts,
    calls,
    extraction,
    repNotes: d.rep_notes ?? "",
  };
}

const DEAL_COLS =
  "id, tenant_id, account, industry, arr, stage_key, days_in_stage, rep_forecast_probability, rep_forecast_close_date, rep_notes";

/**
 * All deals for a tenant, fully populated (contacts, calls, extraction).
 * Batched: one query each for deals, contacts, calls, field_extractions.
 */
export async function getDealsForTenant(tenantId: string): Promise<Deal[]> {
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select(DEAL_COLS)
    .eq("tenant_id", tenantId)
    .order("arr", { ascending: false });
  if (dealsRes.error) throw new Error(`deals read failed: ${dealsRes.error.message}`);
  const deals = dealsRes.data ?? [];
  if (deals.length === 0) return [];

  const dealIds = deals.map((d) => d.id);

  const [contactsRes, callsRes, fxRes] = await Promise.all([
    db
      .from("contacts")
      .select("id, deal_id, name, role, relationship, last_contacted_at")
      .in("deal_id", dealIds),
    db
      .from("calls")
      .select(
        "id, deal_id, call_date, duration_minutes, participants, source, transcript_id, has_been_extracted",
      )
      .in("deal_id", dealIds)
      .order("call_date", { ascending: false }),
    db
      .from("field_extractions")
      .select("deal_id, framework_field_key, status, answer, evidence, confidence")
      .in("deal_id", dealIds),
  ]);
  if (contactsRes.error) throw new Error(`contacts read failed: ${contactsRes.error.message}`);
  if (callsRes.error) throw new Error(`calls read failed: ${callsRes.error.message}`);
  if (fxRes.error) throw new Error(`field_extractions read failed: ${fxRes.error.message}`);

  const contactsByDeal = new Map<string, Contact[]>();
  for (const c of contactsRes.data ?? []) {
    const list = contactsByDeal.get(c.deal_id) ?? [];
    list.push(rowToContact(c));
    contactsByDeal.set(c.deal_id, list);
  }
  const callsByDeal = new Map<string, CallRecord[]>();
  for (const c of callsRes.data ?? []) {
    const list = callsByDeal.get(c.deal_id) ?? [];
    list.push(rowToCall(c));
    callsByDeal.set(c.deal_id, list);
  }
  const fxByDeal = new Map<string, typeof fxRes.data>();
  for (const r of fxRes.data ?? []) {
    const list = fxByDeal.get(r.deal_id) ?? [];
    list.push(r);
    fxByDeal.set(r.deal_id, list);
  }

  return deals.map((d) =>
    rowToDeal(
      d,
      contactsByDeal.get(d.id) ?? [],
      callsByDeal.get(d.id) ?? [],
      buildExtraction(fxByDeal.get(d.id) ?? []),
    ),
  );
}

/**
 * A single deal for a tenant, by deal id. Returns null if not found in
 * this tenant (which also enforces the tenant boundary on direct id access).
 */
export async function getDealForTenant(
  tenantId: string,
  dealId: string,
): Promise<Deal | null> {
  const db = supabaseAdmin();
  const dealRes = await db
    .from("deals")
    .select(DEAL_COLS)
    .eq("tenant_id", tenantId)
    .eq("id", dealId)
    .maybeSingle();
  if (dealRes.error) throw new Error(`deal read failed: ${dealRes.error.message}`);
  if (!dealRes.data) return null;
  const d = dealRes.data;

  const [contactsRes, callsRes, fxRes] = await Promise.all([
    db
      .from("contacts")
      .select("id, deal_id, name, role, relationship, last_contacted_at")
      .eq("deal_id", d.id),
    db
      .from("calls")
      .select(
        "id, deal_id, call_date, duration_minutes, participants, source, transcript_id, has_been_extracted",
      )
      .eq("deal_id", d.id)
      .order("call_date", { ascending: false }),
    db
      .from("field_extractions")
      .select("deal_id, framework_field_key, status, answer, evidence, confidence")
      .eq("deal_id", d.id),
  ]);
  if (contactsRes.error) throw new Error(`contacts read failed: ${contactsRes.error.message}`);
  if (callsRes.error) throw new Error(`calls read failed: ${callsRes.error.message}`);
  if (fxRes.error) throw new Error(`field_extractions read failed: ${fxRes.error.message}`);

  return rowToDeal(
    d,
    (contactsRes.data ?? []).map(rowToContact),
    (callsRes.data ?? []).map(rowToCall),
    buildExtraction(fxRes.data ?? []),
  );
}

// ====================================================================
// Upcoming call + briefing status (for the live UI)
// ====================================================================

export type UpcomingCall = {
  /** Meeting start, ISO (UTC). */
  scheduledStart: string;
  /** When the pre-call briefing was sent, or null if not yet. */
  briefingSentAt: string | null;
};

/** The soonest future scheduled call for a single deal, or null. */
export async function getUpcomingCallForDeal(
  tenantId: string,
  dealId: string,
): Promise<UpcomingCall | null> {
  const db = supabaseAdmin();
  const res = await db
    .from("calls")
    .select("scheduled_start, briefing_sent_at")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId)
    .not("scheduled_start", "is", null)
    .gte("scheduled_start", new Date().toISOString())
    .order("scheduled_start", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (res.error || !res.data || !res.data.scheduled_start) return null;
  return {
    scheduledStart: res.data.scheduled_start,
    briefingSentAt: res.data.briefing_sent_at ?? null,
  };
}

/** Soonest future scheduled call per deal for a tenant, keyed by deal id. */
export async function getUpcomingCallsForTenant(
  tenantId: string,
): Promise<Record<string, UpcomingCall>> {
  const db = supabaseAdmin();
  const res = await db
    .from("calls")
    .select("deal_id, scheduled_start, briefing_sent_at")
    .eq("tenant_id", tenantId)
    .not("scheduled_start", "is", null)
    .gte("scheduled_start", new Date().toISOString())
    .order("scheduled_start", { ascending: true });
  if (res.error || !res.data) return {};
  const out: Record<string, UpcomingCall> = {};
  for (const r of res.data) {
    if (!r.scheduled_start) continue;
    if (!out[r.deal_id]) {
      out[r.deal_id] = {
        scheduledStart: r.scheduled_start,
        briefingSentAt: r.briefing_sent_at ?? null,
      };
    }
  }
  return out;
}

/**
 * Format an UpcomingCall for the UI: the meeting time, and the briefing
 * status ("sent 9:31 AM" or "briefing ~9:30 AM" = 30 min before start).
 */
export function describeUpcomingCall(u: UpcomingCall): {
  when: string;
  briefing: string;
} {
  const start = new Date(u.scheduledStart);
  const when = start.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  if (u.briefingSentAt) {
    const sent = new Date(u.briefingSentAt).toLocaleString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
    return { when, briefing: `Briefing sent ${sent}` };
  }
  const sendAt = new Date(start.getTime() - 30 * 60 * 1000).toLocaleString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  return { when, briefing: `Briefing sends ~${sendAt}` };
}
