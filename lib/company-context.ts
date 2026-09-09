/**
 * What DealRipe knows about a COMPANY, as opposed to about one deal.
 *
 * Everything else here is deal-level or gate-level: lib/deal-journey.ts folds
 * one deal's history, lib/sales-brain.ts answers one question about one gate.
 * There has been no object holding the company's own motion, so a question like
 * "where does this sales process stick" has had nowhere to be asked.
 *
 * ---------------------------------------------------------------------------
 * FACTS ONLY. NO VERDICTS. This is the line the whole module is built on.
 * ---------------------------------------------------------------------------
 *
 * "84 deals reached a demo and 41 reached a proposal" is a fact. "The demo to
 * proposal step is a bottleneck" is an inference, and it does not belong here.
 * The reason is not fastidiousness: an inference written into the context
 * becomes an input to the next inference, and two hops later nobody can tell
 * which claims were measured and which were asserted. That is exactly how the
 * hardcoded CALIBRATION constant in lib/forecast-room.ts came to sit in a
 * product surface asserting 90% against a rep's 63%, computed from nothing.
 *
 * So every field here is a count, a span, a distribution or a coverage
 * statement. A reader (a person, or a model given this as context) draws the
 * conclusions, and can be argued with, because the numbers underneath are all
 * present.
 *
 * THREE STATES, NEVER TWO. Every measurement is `measured`, `insufficient` or
 * `not_measured`. Yesterday's work is the argument: "we can measure it and
 * there is no signal yet" is a real answer, distinct from "it works" and from
 * "it is not built", and collapsing them is how a demo becomes a claim.
 *
 * COMPUTED, NEVER AUTHORED. Nothing in here is hand-written. The moment a human
 * types a finding into this structure it stops being falsifiable.
 *
 * NDA. Counts and distributions only. No transcript text, no email bodies, no
 * customer names beyond the account label. This is deliberately the one
 * derived object that is safe to reason over without handling call content.
 */

import type { Json } from "./database.types";
import { supabaseAdmin } from "./supabase";

/** Every measurement says which of the three it is. */
export type Measured<T> =
  | { state: "measured"; value: T; n: number }
  /** We looked, and there is not enough to say. Carries what there was. */
  | { state: "insufficient"; n: number; needed: number }
  /** Nothing has computed this yet. NOT the same as zero. */
  | { state: "not_measured"; why: string };

export type Span = { from: string | null; to: string | null; days: number | null };

export type CompanyContext = {
  tenant: string;
  generatedAt: string;

  /** What DealRipe can SEE, per channel, and from when. */
  observability: {
    channels: Array<{
      channel: string;
      rows: number;
      span: Span;
      /** What this channel structurally cannot show, stated as fact. */
      blindSpots: string[];
    }>;
    /** The deal's own first captured conversation, which is not first contact. */
    firstObservedConversation: string | null;
    dealsEverObserved: number;
    dealsTotal: number;
  };

  /** The shape of the book. */
  book: {
    deals: number;
    byStage: Record<string, number>;
    byOutcome: Record<string, number>;
    /** new_opportunity vs existing_customer vs unclassified, from captured calls. */
    bySegment: Record<string, number>;
    withSalesforceAccount: number;
    withRolldogOpportunity: number;
  };

  /** How a deal actually moves: meetings, their kinds, and the sequences seen. */
  motion: {
    capturedConversations: number;
    callRowsWithoutConversation: number;
    byCallType: Record<string, number>;
    /** Ordered pairs of consecutive captured call types, with counts. */
    transitions: Array<{ from: string; to: string; count: number }>;
    /** Days between consecutive captured conversations on the same deal. */
    daysBetweenCalls: Measured<{ median: number; p25: number; p75: number }>;
  };

  /** The qualification framework as it is actually answered, gate by gate. */
  framework: {
    fields: number;
    /** Per gate: how many deals have it answered, open, or never touched. */
    gates: Array<{
      gate: string;
      stageKey: string | null;
      answered: number;
      open: number;
      /** Deals where a transition was actually recorded, not just a floor. */
      observedMoves: number;
    }>;
  };

  /** What leaves and arrives: documents and agreements. */
  artifacts: {
    attachmentsSeen: number;
    byClassification: Record<string, number>;
    agreementsSeen: number;
    byAgreementState: Record<string, number>;
    dealsWithADocument: number;
  };

  /** What DealRipe told reps to do, and the raw follow-through counts. */
  prescriptions: {
    total: number;
    byKind: Record<string, number>;
    byFollowed: Record<string, number>;
    scored: number;
    targetingAGate: number;
  };

  /** People, and the limits of what the current schema can hold. */
  people: {
    contacts: number;
    /** Stated because it governs every stakeholder question that can be asked. */
    schemaLimits: string[];
    rsvpEventsSeen: number;
    byResponse: Record<string, number>;
  };
};

async function page<T>(table: string, cols: string, tenantId: string | null): Promise<T[]> {
  const db = supabaseAdmin() as unknown as { from: (t: string) => { select: (c: string) => unknown } };
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: unknown = db.from(table).select(cols);
    if (tenantId) q = (q as { eq: (a: string, b: string) => unknown }).eq("tenant_id", tenantId);
    q = (q as { order: (c: string, o: unknown) => unknown }).order("id", { ascending: true });
    q = (q as { range: (a: number, b: number) => unknown }).range(from, from + 999);
    const res = (await (q as Promise<{ data: T[] | null; error: { message: string } | null }>));
    // A failed page is not an empty one. Half a context that looks whole is
    // worse than none, because every number in it reads as complete.
    if (res.error) throw new Error(`${table} read failed: ${res.error.message}`);
    const rows = res.data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const MIN_CONVERSATION_CHARS = 2000;
const day = (s: string | null | undefined) => String(s ?? "").slice(0, 10);
const tally = <T>(rows: T[], f: (r: T) => string | null | undefined): Record<string, number> => {
  const o: Record<string, number> = {};
  for (const r of rows) {
    const k = f(r);
    if (k === null || k === undefined || k === "") continue;
    o[k] = (o[k] ?? 0) + 1;
  }
  return o;
};
function spanOf(dates: string[]): Span {
  const s = dates.filter(Boolean).sort();
  if (s.length === 0) return { from: null, to: null, days: null };
  const from = s[0];
  const to = s[s.length - 1];
  const d = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  return { from, to, days: Number.isFinite(d) ? Math.round(d) : null };
}

export async function buildCompanyContext(tenantId: string, slug: string): Promise<CompanyContext> {
  const [deals, calls, transcripts, msgs, atts, extractions, gateEvents, crmEvents, activities, rx, rsvp, contacts, ticks] =
    await Promise.all([
      page<{ id: string; stage_key: string; outcome_label: string | null; salesforce_account_id: string | null; rolldog_opportunity_id: string | null }>(
        "deals", "id, stage_key, outcome_label, salesforce_account_id, rolldog_opportunity_id", tenantId),
      page<{ id: string; deal_id: string; call_date: string | null; scheduled_start: string | null; call_subtype: string | null; meeting_type: string | null }>(
        "calls", "id, deal_id, call_date, scheduled_start, call_subtype, meeting_type", tenantId),
      page<{ call_id: string; body: string | null }>("transcripts", "id, call_id, body", null),
      page<{ sent_at: string | null; agreement_kind: string | null; agreement_state: string | null }>(
        "deal_messages", "id, sent_at, agreement_kind, agreement_state", tenantId),
      page<{ deal_id: string | null; classification: string | null; first_seen_at: string }>(
        "deal_attachments", "id, deal_id, classification, first_seen_at", tenantId),
      page<{ deal_id: string; framework_field_key: string; status: string }>(
        "field_extractions", "id, deal_id, framework_field_key, status", tenantId),
      page<{ deal_id: string; framework_field_key: string; from_status: string | null; observed_at: string }>(
        "field_extraction_events", "id, deal_id, framework_field_key, from_status, observed_at", tenantId),
      page<{ changed_at: string }>("crm_field_events", "id, changed_at", tenantId),
      page<{ occurred_at: string | null; created_at_source: string | null; is_ours: boolean }>(
        "crm_activities", "id, occurred_at, created_at_source, is_ours", tenantId),
      page<{ kind: string; followed: string; scored_at: string | null; framework_field_keys: string[] | null; issued_at: string }>(
        "prescribed_actions", "id, kind, followed, scored_at, framework_field_keys, issued_at", tenantId),
      page<{ to_response: string; observed_at: string }>("calendar_response_events", "id, to_response, observed_at", tenantId),
      page<{ id: string }>("contacts", "id", tenantId),
      page<{ observed_at: string }>("rolldog_gate_events", "id, observed_at", tenantId),
    ]);

  const chars = new Map(transcripts.map((t) => [t.call_id, String(t.body ?? "").length]));
  const real = calls
    .filter((c) => (chars.get(c.id) ?? 0) >= MIN_CONVERSATION_CHARS)
    .map((c) => ({ ...c, at: day(c.call_date ?? c.scheduled_start) }))
    .filter((c) => c.at);

  // Segment per deal, from its captured calls. An existing_customer call
  // anywhere marks the deal, because Account.Type is a property of the company
  // rather than of one meeting. A deal with no captured call is "unclassified",
  // never "new": meeting_type is written AFTER capture.
  const segByDeal = new Map<string, string>();
  for (const c of real) {
    if (!c.meeting_type || c.meeting_type === "internal") continue;
    if (c.meeting_type === "existing_customer" || !segByDeal.has(c.deal_id)) segByDeal.set(c.deal_id, c.meeting_type);
  }

  // Call-type transitions, per deal, in order.
  const byDeal = new Map<string, typeof real>();
  for (const c of real) byDeal.set(c.deal_id, [...(byDeal.get(c.deal_id) ?? []), c]);
  const transitions = new Map<string, number>();
  const gaps: number[] = [];
  for (const list of byDeal.values()) {
    const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at));
    for (let i = 1; i < sorted.length; i++) {
      const k = `${sorted[i - 1].call_subtype ?? "unclassified"} ${sorted[i].call_subtype ?? "unclassified"}`;
      transitions.set(k, (transitions.get(k) ?? 0) + 1);
      const d = (Date.parse(sorted[i].at) - Date.parse(sorted[i - 1].at)) / 86_400_000;
      if (Number.isFinite(d) && d >= 0) gaps.push(d);
    }
  }
  gaps.sort((a, b) => a - b);
  const q = (p: number) => gaps[Math.floor(gaps.length * p)] ?? 0;

  // Gate-level: answered vs open, and how many moves were actually OBSERVED as
  // opposed to seeded. A from_status of null is the backfilled floor.
  const gateKeys = [...new Set(extractions.map((e) => e.framework_field_key))].sort();
  const movesByGate = tally(gateEvents.filter((g) => g.from_status !== null), (g) => g.framework_field_key);

  const firstObserved = real.map((c) => c.at).sort()[0] ?? null;

  return {
    tenant: slug,
    generatedAt: new Date().toISOString(),

    observability: {
      channels: [
        {
          channel: "captured conversations",
          rows: real.length,
          span: spanOf(real.map((c) => c.at)),
          blindSpots: [
            "A meeting the bot never got into produces no transcript, and a lobby timeout cannot distinguish 'the meeting ran without us' from 'it never happened'.",
            `${calls.length - real.length} meeting rows carry no conversation.`,
          ],
        },
        {
          channel: "email",
          rows: msgs.length,
          span: spanOf(msgs.map((m) => day(m.sent_at))),
          blindSpots: [
            "Mapped to deals by customer DOMAIN only, so free-mail contacts are skipped entirely and a domain claimed by two deals is dropped from both.",
            "Reaches back only as far as the ingest has been run, which is not first contact.",
          ],
        },
        {
          channel: "Salesforce field history",
          rows: crmEvents.length,
          span: spanOf(crmEvents.map((e) => day(e.changed_at))),
          blindSpots: ["Four tracked fields only: Amount, CloseDate, StageName, ForecastCategoryName. It says what moved, never why."],
        },
        {
          channel: "rep-logged CRM activity",
          rows: activities.filter((a) => !a.is_ours).length,
          span: spanOf(activities.map((a) => day(a.occurred_at ?? a.created_at_source))),
          blindSpots: [`${activities.filter((a) => a.is_ours).length} of ${activities.length} rows are DealRipe's own writes and are excluded from this count.`],
        },
        {
          channel: "calendar RSVP",
          rows: rsvp.length,
          span: spanOf(rsvp.map((r) => day(r.observed_at))),
          blindSpots: ["Forward-only: calls.participants was overwritten on every sync until the log was built, so nothing before that exists."],
        },
        {
          channel: "checklist ticks",
          rows: ticks.length,
          span: spanOf(ticks.map((t) => day(t.observed_at))),
          blindSpots: ["Rolldog exposes current state and has no history endpoint, so everything before the sweep began is unrecoverable."],
        },
        {
          channel: "documents",
          rows: atts.length,
          span: spanOf(atts.map((a) => day(a.first_seen_at))),
          blindSpots: ["Filenames and types only. No file contents are stored."],
        },
      ],
      firstObservedConversation: firstObserved,
      dealsEverObserved: byDeal.size,
      dealsTotal: deals.length,
    },

    book: {
      deals: deals.length,
      byStage: tally(deals, (d) => d.stage_key),
      byOutcome: tally(deals, (d) => d.outcome_label ?? "open"),
      bySegment: (() => {
        const o: Record<string, number> = {};
        for (const d of deals) {
          const k = segByDeal.get(d.id) ?? "unclassified";
          o[k] = (o[k] ?? 0) + 1;
        }
        return o;
      })(),
      withSalesforceAccount: deals.filter((d) => d.salesforce_account_id).length,
      withRolldogOpportunity: deals.filter((d) => d.rolldog_opportunity_id).length,
    },

    motion: {
      capturedConversations: real.length,
      callRowsWithoutConversation: calls.length - real.length,
      byCallType: tally(real, (c) => c.call_subtype ?? "unclassified"),
      transitions: [...transitions.entries()]
        .map(([k, count]) => ({ from: k.split(" ")[0], to: k.split(" ")[1], count }))
        .sort((a, b) => b.count - a.count),
      daysBetweenCalls:
        gaps.length >= 20
          ? { state: "measured", n: gaps.length, value: { median: q(0.5), p25: q(0.25), p75: q(0.75) } }
          : { state: "insufficient", n: gaps.length, needed: 20 },
    },

    framework: {
      fields: gateKeys.length,
      gates: gateKeys.map((gate) => {
        const rows = extractions.filter((e) => e.framework_field_key === gate);
        // CASE-INSENSITIVE, AND THAT IS NOT DEFENSIVE CODING.
        //
        // field_extractions.status is stored "Yes"/"No" CAPITALISED, while
        // prescribed_actions.followed is lowercase "yes"/"no"/"unknown". Two
        // tables, two conventions, and the Tristate type in database.types.ts
        // documents only the lowercase one.
        //
        // The first version of this compared === "yes" and reported answered: 0
        // for all 35 gates. A memory bank whose whole purpose is holding facts
        // held a wrong one for a day, and it looked plausible because "nothing
        // is answered yet" is a believable state for a young pilot. Comparing a
        // stored enum without checking its actual values is how that happens.
        const yes = rows.filter((r) => String(r.status).toLowerCase() === "yes").length;
        return {
          gate,
          stageKey: null,
          answered: yes,
          open: rows.length - yes,
          observedMoves: movesByGate[gate] ?? 0,
        };
      }),
    },

    artifacts: {
      attachmentsSeen: atts.length,
      byClassification: tally(atts, (a) => a.classification ?? "unclassified"),
      agreementsSeen: msgs.filter((m) => m.agreement_kind).length,
      byAgreementState: tally(msgs.filter((m) => m.agreement_kind), (m) => m.agreement_state ?? "unknown"),
      dealsWithADocument: new Set(atts.map((a) => a.deal_id).filter(Boolean)).size,
    },

    prescriptions: {
      total: rx.length,
      byKind: tally(rx, (r) => r.kind),
      byFollowed: tally(rx, (r) => r.followed),
      scored: rx.filter((r) => r.scored_at).length,
      targetingAGate: rx.filter((r) => Array.isArray(r.framework_field_keys) && r.framework_field_keys.length > 0).length,
    },

    people: {
      contacts: contacts.length,
      schemaLimits: [
        "contacts is scoped to a DEAL, so the same person on two deals is two unrelated rows.",
        "contacts has no email column, so it cannot be joined to a calendar roster or a mailbox.",
        "relationship is a hardcoded CHECK constraint, so the role vocabulary cannot vary per company.",
        "A role is a mutable column, so a person moving from influencer to economic buyer overwrites the fact that they moved.",
      ],
      rsvpEventsSeen: rsvp.length,
      byResponse: tally(rsvp, (r) => r.to_response),
    },
  };
}


/**
 * Persist one computation, append-only.
 *
 * Two runs in one day are two rows and that is deliberate: the second is a
 * later observation, not a correction of the first. Nothing here upserts, for
 * the reason deal_signal_snapshots demonstrates by destroying five of six
 * daily readings on a unique-plus-upsert key.
 */
export async function recordCompanyContext(tenantId: string, ctx: CompanyContext): Promise<string | null> {
  const res = await supabaseAdmin()
    .from("company_context_snapshots")
    .insert({
      tenant_id: tenantId,
      generated_at: ctx.generatedAt,
      payload: ctx as unknown as Json,
      deals: ctx.book.deals,
      captured_conversations: ctx.motion.capturedConversations,
      uncaptured_meetings: ctx.motion.callRowsWithoutConversation,
      deals_observed: ctx.observability.dealsEverObserved,
    })
    .select("id")
    .maybeSingle();
  if (res.error) {
    console.error(`[company-context] write failed: ${res.error.message}`);
    return null;
  }
  return res.data?.id ?? null;
}

export type ContextChange = { path: string; was: unknown; now: unknown };

/**
 * What moved since the previous snapshot.
 *
 * THE POINT OF KEEPING A SERIES. A context regenerated on demand answers "what
 * is true"; a series answers "what changed", which is the question worth asking
 * of a sales motion. Is capture improving, is discovery-to-demo getting faster,
 * has a gate that never moved started moving.
 *
 * generatedAt is EXCLUDED from the comparison. deal_signal_snapshots wrote a
 * capturedAt into its own payload, so a byte comparison of consecutive days
 * differed always and 47 "changes" across 48 days were really 8. A field we
 * write ourselves is not a fact about the company.
 */
/**
 * JSON with object keys sorted, at every depth.
 *
 * WHY THIS IS NOT PARANOIA. Postgres jsonb does not preserve key order: it
 * normalises on write. So an object stored as {from, to, count} comes back as
 * {count, from, to}, and a plain JSON.stringify comparison reports every array
 * of objects as changed on every single run.
 *
 * The first run of diffContext did exactly that: three "changes" whose values
 * were byte-identical and whose keys had simply been reordered by the database.
 * That is deal_signal_snapshots' 47-changes-in-48-days in a new costume, and it
 * is the same lesson: compare the FACT, never the encoding of the fact.
 */
function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function diffContext(prev: CompanyContext, next: CompanyContext): ContextChange[] {
  const out: ContextChange[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (path === "generatedAt") return;
    if (a === b) return;
    const bothObjects =
      a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b);
    if (bothObjects) {
      const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
      for (const k of keys) {
        walk((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    // Arrays and scalars are compared whole. An ordered list that reordered is
    // a change worth seeing, and pretending otherwise hides a motion shift.
    if (stable(a) !== stable(b)) out.push({ path, was: a, now: b });
  };
  walk(prev as unknown, next as unknown, "");
  return out;
}

/** The most recent stored snapshot, or null if this is the first. */
export async function lastCompanyContext(tenantId: string): Promise<CompanyContext | null> {
  const res = await supabaseAdmin()
    .from("company_context_snapshots")
    .select("payload")
    .eq("tenant_id", tenantId)
    .order("generated_at", { ascending: false })
    .limit(1);
  // A failed read is not "no previous snapshot". Returning null would make the
  // next diff report every field as new.
  if (res.error) throw new Error(`company_context_snapshots read failed: ${res.error.message}`);
  const row = res.data?.[0];
  return row ? (row.payload as unknown as CompanyContext) : null;
}
