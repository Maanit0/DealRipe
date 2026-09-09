/**
 * One deal, every dated thing that happened to it, in order, from every source.
 *
 * WHY THIS IS COMPUTED AND NOT STORED. The ledger tables are the truth; this is
 * a fold over them. Storing the result would create a second copy that drifts
 * from the rows it came from, which is precisely what field_extractions and
 * deal_signal_snapshots already demonstrate: an upserted projection is a
 * tombstone over its own history. Recomputing costs one round trip per table
 * and means a better fold applies retroactively to every deal.
 *
 * WHAT IT PULLS TOGETHER
 *
 *   calls + transcripts      the spoken conversation, its type, who was on it
 *   deal_messages            the written one, with bodies since 2026-09-08
 *   field_extractions        WHAT WAS LEARNED: the framework answers, in the
 *                            customer's own words, with the call that captured
 *                            each one
 *   field_extraction_events  when a gate moved
 *   crm_field_events         what the CRM recorded and who moved it
 *   rolldog_gate_events      what the rep ticked by hand
 *   calendar_response_events who accepted, declined, or was removed
 *   prescribed_actions       WHAT DEALRIPE TOLD THE REP TO DO
 *   micro + macro outcomes   what actually happened next
 *
 * The prescription rows are the reason this is not just a CRM timeline. Gong
 * holds the conversation and has no action column; Salesforce holds the outcome
 * and has no action column. The join of "what we said to do" against "what the
 * buyer did next" is the only part of this that is proprietary.
 *
 * COVERAGE IS PART OF THE RETURN VALUE, not a footnote. Three channels have no
 * history before the day they were built, one has permanent holes where the
 * mailbox was emptied, and 77 of 204 deals have never had a captured call. A
 * journey that renders those as quiet stretches is lying, and the whole reason
 * this codebase has scar tissue is that absence reads as evidence.
 *
 * NDA. Everything here is customer content: transcript text, email bodies, the
 * customer's own words in the extraction evidence. Render it to .previews/,
 * which is gitignored. Never write it into the repo, and never commit an
 * export. Anything derived from a transcript is still transcript.
 */

import { readDealMemory, type PriorCommitment } from "./deal-memory";
import { detectMicroOutcomes, type MicroOutcome } from "./micro-outcomes";
import { supabaseAdmin } from "./supabase";

export type JourneyChannel =
  | "call"
  | "email"
  | "crm"
  | "checklist"
  | "calendar"
  | "dealripe"
  | "gate"
  | "activity"
  | "commitment"
  | "outcome";

/**
 * WHO AUTHORED THIS, which is a different question from where it came from and
 * a more important one.
 *
 * A CRM stage is a rep's opinion typed into a box. An executed NDA is Adobe
 * Sign asserting a fact neither side can edit. A customer's reply is the
 * customer. Averaging those into "deal activity" is how a learning loop ends up
 * training on bookkeeping, and this codebase already has the evidence: measured
 * 2026-09-08, every email and call signal correlated NEGATIVELY with
 * stage_advanced on comparable windows, while the same signals behaved sensibly
 * against nda_executed. Stage movement is the rep remembering to update
 * Salesforce.
 *
 * So the rule is: a learning TARGET should be buyer or system authored. Seller
 * authorship is not noise, it is a different measurement, and it is the one
 * per-rep calibration is made of: the gap between what a rep asserted and what
 * the buyer actually did IS the coaching signal.
 */
export type Authorship =
  /** The customer said it, wrote it, or did it. Cannot be edited by the rep. */
  | "buyer"
  /** The rep said it, wrote it, or typed it into a CRM field. An assertion. */
  | "seller"
  /** A third party or machine asserted it: Adobe Sign, Graph, the calendar. */
  | "system"
  /** DealRipe generated it: an extraction, a prescription, a draft. */
  | "dealripe"
  /** Genuinely both sides, e.g. a conversation. Never silently folded either way. */
  | "mixed";

export type JourneyEvent = {
  /** ISO. When it happened in the world, not when we saw it. */
  at: string;
  channel: JourneyChannel;
  /**
   * Who produced this. Read it before using an event as evidence of anything:
   * "the stage moved" and "the customer signed" are not the same kind of fact.
   */
  authorship: Authorship;
  kind: string;
  /** One line. May contain customer content: treat as NDA material. */
  summary: string;
  /** Optional longer text, e.g. an email excerpt or a captured answer. */
  detail?: string | null;
  source: { table: string; id: string };
};

export type GatheredField = {
  fieldKey: string;
  status: string;
  answer: string | null;
  /** The customer's own words. NDA material. */
  evidence: string | null;
  capturedFromCallId: string | null;
  updatedAt: string;
};

export type JourneyCoverage = {
  /** Deals with no captured conversation cannot have a spoken journey. */
  capturedConversations: number;
  callRowsWithoutConversation: number;
  emailsHeld: number;
  emailBodiesMissing: { gone: number; skipped: number; notFetched: number };
  /** True where the channel simply has no history before it was built. */
  noHistoryBefore: Record<string, string>;
  notes: string[];
};

/**
 * One captured conversation, in full.
 *
 * The transcript is the least compressed thing DealRipe holds: 5.2M characters
 * across 222 conversations, stored raw. Everything else about a call is derived
 * from it, so a journey that shows a character count is showing the shadow of
 * the evidence rather than the evidence.
 *
 * NDA MATERIAL, unambiguously. This is the customer speaking.
 */
export type JourneyTranscript = {
  callId: string;
  at: string;
  subtype: string | null;
  meetingType: string | null;
  chars: number;
  text: string;
};

export type DealJourney = {
  dealId: string;
  account: string;
  outcomeLabel: string | null;
  events: JourneyEvent[];
  gathered: GatheredField[];
  /** Full text of every captured conversation, oldest first. */
  transcripts: JourneyTranscript[];
  /**
   * What DealRipe's drafts promised the customer, and whether the draft
   * carrying each promise actually left the mailbox. "unsent" matters: a
   * promise the customer never received is not a commitment, and offering it as
   * one invents an obligation.
   */
  commitments: PriorCommitment[];
  outcomes: MicroOutcome[];
  coverage: JourneyCoverage;
};

async function rows<T>(table: string, cols: string, filter: [string, string][]): Promise<T[]> {
  const db = supabaseAdmin() as unknown as { from: (t: string) => { select: (c: string) => unknown } };
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: unknown = db.from(table).select(cols);
    for (const [k, v] of filter) q = (q as { eq: (a: string, b: string) => unknown }).eq(k, v);
    q = (q as { order: (c: string, o: unknown) => unknown }).order("id", { ascending: true });
    q = (q as { range: (a: number, b: number) => unknown }).range(from, from + 999);
    const res = (await (q as Promise<{ data: T[] | null; error: { message: string } | null }>));
    // A failed page is not an empty page. Returning what we have would render a
    // busy deal as a quiet one, which is the failure this module documents.
    if (res.error) throw new Error(`${table} read failed: ${res.error.message}`);
    const page = res.data ?? [];
    out.push(...page);
    if (page.length < 1000) break;
  }
  return out;
}

const MIN_CONVERSATION_CHARS = 2000;
const clip = (s: string | null | undefined, n: number) =>
  !s ? null : s.length <= n ? s : `${s.slice(0, n).trimEnd()}...`;

export async function buildDealJourney(tenantId: string, dealId: string): Promise<DealJourney> {
  const [deal] = await rows<{ id: string; account: string; outcome_label: string | null; outcome_close_date: string | null }>(
    "deals",
    "id, account, outcome_label, outcome_close_date",
    [["id", dealId]],
  );
  if (!deal) throw new Error(`deal ${dealId} not found`);

  const [calls, transcripts, msgs, crm, gates, ticks, rsvp, rx, extractions] = await Promise.all([
    rows<{ id: string; call_date: string | null; scheduled_start: string | null; call_subtype: string | null; meeting_type: string | null; outcome: string | null; capture_class: string | null; title: string | null; participants: unknown; organizer_email: string | null }>(
      "calls",
      "id, call_date, scheduled_start, call_subtype, meeting_type, outcome, capture_class, title, participants, organizer_email",
      [["deal_id", dealId]],
    ),
    rows<{ id: string; call_id: string; body: string | null }>("transcripts", "id, call_id, body", []),
    rows<{ id: string; direction: string; customer_side: boolean | null; is_machine_sender: boolean | null; is_calendar_response: boolean; sent_at: string | null; subject: string | null; from_email: string | null; body_trimmed: string | null; body_status: string | null; agreement_kind: string | null; agreement_state: string | null; has_attachments: boolean | null }>(
      "deal_messages",
      "id, direction, customer_side, is_machine_sender, is_calendar_response, sent_at, subject, from_email, body_trimmed, body_status, agreement_kind, agreement_state, has_attachments",
      [["deal_id", dealId]],
    ),
    rows<{ id: string; field: string; old_value: string | null; new_value: string | null; changed_by: string | null; changed_at: string }>(
      "crm_field_events",
      "id, field, old_value, new_value, changed_by, changed_at",
      [["deal_id", dealId]],
    ),
    rows<{ id: string; framework_field_key: string; from_status: string | null; to_status: string; evidence: string | null; occurred_at: string | null; observed_at: string }>(
      "field_extraction_events",
      "id, framework_field_key, from_status, to_status, evidence, occurred_at, observed_at",
      [["deal_id", dealId]],
    ),
    rows<{ id: string; rolldog_id: number; item_name: string | null; stage_key: string | null; from_ticked: boolean | null; to_ticked: boolean; observed_at: string }>(
      "rolldog_gate_events",
      "id, rolldog_id, item_name, stage_key, from_ticked, to_ticked, observed_at",
      [["deal_id", dealId]],
    ),
    rows<{ id: string; email: string; display_name: string | null; from_response: string | null; to_response: string; observed_at: string; meeting_start: string | null }>(
      "calendar_response_events",
      "id, email, display_name, from_response, to_response, observed_at, meeting_start",
      [["deal_id", dealId]],
    ),
    rows<{ id: string; kind: string; text: string | null; created_at: string; source: string | null }>(
      "prescribed_actions",
      "id, kind, text, created_at, source",
      [["deal_id", dealId]],
    ),
    rows<{ id: string; framework_field_key: string; status: string; answer: string | null; evidence: string | null; last_updated_from_call_id: string | null; updated_at: string }>(
      "field_extractions",
      "id, framework_field_key, status, answer, evidence, last_updated_from_call_id, updated_at",
      [["deal_id", dealId]],
    ),
  ]);

  // Documents that actually rode along. Read tolerantly: this table lands after
  // the others, so a deal built before the migration renders the rest.
  let attachments: Array<{ id: string; message_id: string; filename: string; classification: string | null; classification_basis: string | null; direction: string | null; size_bytes: number | null }> = [];
  try {
    attachments = await rows(
      "deal_attachments",
      "id, message_id, filename, classification, classification_basis, direction, size_bytes",
      [["deal_id", dealId]],
    );
  } catch {
    attachments = [];
  }

  // Rep-logged activity from the CRMs. Read separately and tolerantly: this
  // table lands after the others, so a deal built before the migration should
  // render the rest of its journey rather than failing whole.
  let activities: Array<{ id: string; source_system: string; source_object: string; subject: string | null; body: string | null; activity_type: string | null; status: string | null; actor: string | null; occurred_at: string | null; created_at_source: string | null; is_ours: boolean }> = [];
  try {
    activities = await rows(
      "crm_activities",
      "id, source_system, source_object, subject, body, activity_type, status, actor, occurred_at, created_at_source, is_ours",
      [["deal_id", dealId]],
    );
  } catch {
    activities = [];
  }

  const charsByCall = new Map(transcripts.map((t) => [t.call_id, String(t.body ?? "").length]));
  const events: JourneyEvent[] = [];

  for (const c of calls) {
    const at = String(c.call_date ?? c.scheduled_start ?? "");
    if (!at) continue;
    const chars = charsByCall.get(c.id) ?? 0;
    const real = chars >= MIN_CONVERSATION_CHARS;
    const who = Array.isArray(c.participants)
      ? (c.participants as Array<{ email?: string | null }>)
          .map((p) => String(p?.email ?? ""))
          .filter((e) => e && !e.endsWith("@magaya.com")).length
      : 0;
    events.push({
      at,
      channel: "call",
      // The meeting HAPPENING is a calendar fact; the conversation inside it is
      // both sides talking. Neither is a rep assertion, and neither is purely
      // the buyer, so it is mixed rather than quietly filed as one.
      authorship: real ? "mixed" : "system",
      kind: real ? `call:${c.call_subtype ?? "unclassified"}` : "call:not_captured",
      // "not captured" is deliberate wording. A lobby timeout is undecidable:
      // the bot cannot see whether the meeting ran without it.
      summary: real
        ? `${c.call_subtype ?? "call"}${c.meeting_type ? ` / ${c.meeting_type}` : ""}, ${who} customer attendee(s), ${chars} chars`
        : `meeting not captured (${c.capture_class ?? c.outcome ?? "no outcome recorded"})`,
      detail: c.title,
      source: { table: "calls", id: c.id },
    });
  }

  for (const m of msgs) {
    if (!m.sent_at) continue;
    const who = m.is_machine_sender ? "machine" : m.customer_side ? "customer" : "rep";
    // LABEL FROM customer_side, NOT from direction.
    //
    // direction is PER MAILBOX: it means "the owner of the mailbox we read this
    // from sent it". On a co-sold deal a colleague's outbound therefore reads
    // as inbound in the other rep's mailbox, and the journey rendered a message
    // the rep plainly wrote as "rep inbound". customer_side is domain-based and
    // says which side of the table the sender sat on, which is the question.
    const arrow = m.is_machine_sender ? "notification" : m.customer_side ? "-> us" : "-> them";
    const agreement = m.agreement_kind ? ` [${m.agreement_kind} ${m.agreement_state}]` : "";
    events.push({
      at: m.sent_at,
      channel: m.is_calendar_response ? "calendar" : "email",
      // The single cleanest authorship signal we have. A customer-side inbound
      // message is the buyer in their own words; our outbound is the rep's.
      authorship: m.is_machine_sender ? "system" : m.customer_side ? "buyer" : "seller",
      kind: m.is_calendar_response ? "calendar:response" : `email:${who}`,
      summary: `${who} ${arrow}${m.has_attachments ? " (+attachment)" : ""}${agreement}: ${m.subject ?? "(no subject)"}`,
      // Body is NDA material and is clipped, not omitted: the whole point of
      // the journey is being able to read what was actually said.
      detail: m.body_trimmed ? clip(m.body_trimmed, 600) : m.body_status === "gone" ? "(body permanently unavailable: message deleted)" : null,
      source: { table: "deal_messages", id: m.id },
    });
  }

  // Attached to the message that carried them, so a file appears at the moment
  // it was actually sent rather than as a separate undated fact.
  const sentAtByMessage = new Map(msgs.map((m) => [m.id, m.sent_at]));
  for (const a of attachments) {
    const at = sentAtByMessage.get(a.message_id);
    if (!at) continue;
    events.push({
      at,
      channel: "email",
      // Whoever sent the message authored the file going out. A customer
      // sending us a signed document is the buyer acting.
      authorship: a.direction === "outbound" ? "seller" : "buyer",
      kind: `attachment:${a.classification ?? "unclassified"}`,
      summary:
        `${a.direction === "outbound" ? "we sent" : "they sent"} ${a.filename}` +
        `${a.classification === "customized" ? "   [built for this customer]" : a.classification === "static" ? "   [stock collateral]" : ""}`,
      source: { table: "deal_attachments", id: a.id },
    });
  }

  for (const e of crm) {
    events.push({
      at: e.changed_at,
      channel: "crm",
      // A REP ASSERTION, always. Stage, amount, close date and forecast
      // category are a person's opinion typed into a box, which is why every
      // buyer signal correlated negatively with stage_advanced.
      authorship: "seller",
      kind: `crm:${e.field}`,
      summary: `${e.field} ${e.old_value ?? "(none)"} -> ${e.new_value ?? "(none)"}${e.changed_by ? ` by ${e.changed_by}` : ""}`,
      source: { table: "crm_field_events", id: e.id },
    });
  }

  for (const g of gates) {
    events.push({
      at: g.occurred_at ?? g.observed_at,
      channel: "gate",
      // Ours. The EVIDENCE is the customer's words, but the judgement that a
      // gate is answered is a model's, so it can be wrong in ways the words
      // cannot.
      authorship: "dealripe",
      // A null from_status is the backfilled floor: what was already true, not
      // something that moved. Labelled so it can never be read as a flip.
      kind: g.from_status === null ? "gate:first_observed" : "gate:flipped",
      summary:
        g.from_status === null
          ? `${g.framework_field_key} first recorded as ${g.to_status}`
          : `${g.framework_field_key}: ${g.from_status} -> ${g.to_status}`,
      detail: clip(g.evidence, 300),
      source: { table: "field_extraction_events", id: g.id },
    });
  }

  for (const t of ticks) {
    events.push({
      at: t.observed_at,
      channel: "checklist",
      // The rep ticks this by hand. DealRipe has never ticked one.
      authorship: "seller",
      kind: t.from_ticked === null ? "checklist:first_observed" : t.to_ticked ? "checklist:ticked" : "checklist:unticked",
      summary: `[${t.stage_key ?? "?"}] ${t.item_name ?? `#${t.rolldog_id}`}${t.from_ticked === null ? " already ticked when first seen" : t.to_ticked ? " ticked" : " untick"}`,
      source: { table: "rolldog_gate_events", id: t.id },
    });
  }

  for (const r of rsvp) {
    events.push({
      at: r.observed_at,
      channel: "calendar",
      // Accepting, declining or being dropped from an invite is the buyer
      // acting, unless the address is ours.
      authorship: r.email.toLowerCase().endsWith("@magaya.com") ? "seller" : "buyer",
      kind: `rsvp:${r.to_response}`,
      summary: `${r.display_name ?? r.email} ${r.from_response ? `${r.from_response} -> ` : ""}${r.to_response}${r.meeting_start ? ` for ${r.meeting_start.slice(0, 10)}` : ""}`,
      source: { table: "calendar_response_events", id: r.id },
    });
  }

  for (const p of rx) {
    events.push({
      at: p.created_at,
      channel: "dealripe",
      authorship: "dealripe",
      kind: `prescribed:${p.kind}`,
      summary: `DealRipe told the rep (${p.source ?? "briefing"}): ${clip(p.text, 160) ?? "(no text)"}`,
      source: { table: "prescribed_actions", id: p.id },
    });
  }

  for (const a of activities) {
    const at = a.occurred_at ?? a.created_at_source;
    if (!at) continue;
    events.push({
      at,
      channel: "activity",
      // A rep logging what they did is a rep assertion, the same class as a
      // stage move: it is what they say happened, not what was observed. Ours
      // is marked separately so DealRipe's own Tasks are never read back as the
      // rep's work.
      authorship: a.is_ours ? "dealripe" : "seller",
      kind: `${a.source_system}:${a.source_object}${a.is_ours ? ":ours" : ""}`,
      summary: `${a.actor ?? "someone"} logged ${a.activity_type ?? a.source_object}${a.status ? ` [${a.status}]` : ""}: ${a.subject ?? "(no subject)"}`,
      detail: clip(a.body, 400),
      source: { table: "crm_activities", id: a.id },
    });
  }

  // COMMITMENTS. Read through readDealMemory rather than re-deriving, so the
  // journey cannot disagree with what the follow-up draft is told. Best effort:
  // it reaches Graph for draft adoption and a failure there must not cost the
  // whole journey.
  let commitments: PriorCommitment[] = [];
  try {
    commitments = (await readDealMemory({ tenantId, dealId })).toldThemWeWould;
  } catch (err) {
    console.error(`[journey] commitments unavailable for ${dealId}: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const c of commitments) {
    events.push({
      at: c.when,
      channel: "commitment",
      // Ours: we wrote it. Whether the CUSTOMER received it is delivery, and
      // an unsent promise is not an obligation.
      authorship: "dealripe",
      kind: `commitment:${c.delivery}`,
      summary: `we said we would: ${clip(c.text, 140)}${c.delivery === "sent" ? "" : c.delivery === "unsent" ? "   [DRAFT NEVER SENT: not a real promise]" : "   [delivery unknown]"}`,
      source: { table: "sent_messages", id: dealId },
    });
  }

  const allOutcomes = await detectMicroOutcomes(tenantId);
  const outcomes = allOutcomes.filter((o) => o.dealId === dealId);
  // AUTHORSHIP PER OUTCOME KIND, and this is where it matters most.
  //
  // An executed NDA is Adobe Sign asserting something neither side can edit. A
  // customer coming back after silence is the buyer. A stage move is the rep.
  // AND SO IS closed_won / closed_lost: a rep marks a deal closed, which is
  // usually true but is still their entry, and the 2026-08-07 hygiene sweep
  // that closed four deals in 90 seconds is what a seller-authored outcome
  // looks like when it is wrong.
  const outcomeAuthor = (kind: string): Authorship => {
    if (kind === "nda_executed" || kind === "quote_executed") return "system";
    if (kind === "reengaged_after_silence") return "buyer";
    if (kind === "stage_advanced" || kind === "closed_won" || kind === "closed_lost") return "seller";
    if (kind === "gate_flipped") return "dealripe";
    // A booked meeting needs both sides: we sent it, they accepted it.
    return "mixed";
  };
  for (const o of outcomes) {
    events.push({
      at: o.occurredAt,
      channel: "outcome",
      authorship: outcomeAuthor(o.kind),
      kind: `outcome:${o.kind}`,
      summary: o.evidence,
      source: o.source,
    });
  }

  const captured = calls.filter((c) => (charsByCall.get(c.id) ?? 0) >= MIN_CONVERSATION_CHARS).length;
  const bodyStatus = (s: string) => msgs.filter((m) => m.body_status === s).length;

  const notes: string[] = [];
  if (captured === 0 && calls.length > 0) {
    notes.push(`${calls.length} meeting row(s) and no captured conversation: the spoken journey is absent, not empty.`);
  }
  if (captured === 0 && calls.length === 0) {
    notes.push("No meeting has ever been scheduled on this deal through a rep's calendar.");
  }
  if (bodyStatus("gone") > 0) {
    notes.push(`${bodyStatus("gone")} email body/bodies are permanently unavailable: the message was deleted from the mailbox.`);
  }
  if (gates.length > 0 && gates.every((g) => g.from_status === null)) {
    notes.push("Every gate row is a first observation, so no qualification movement has been recorded since the log was built.");
  }
  if (rsvp.length === 0) {
    notes.push("No RSVP history: calls.participants was overwritten on every sync until 2026-09-08.");
  }

  return {
    dealId,
    account: deal.account,
    outcomeLabel: deal.outcome_label,
    events: events.filter((e) => e.at).sort((a, b) => a.at.localeCompare(b.at)),
    transcripts: calls
      .map((c) => ({
        callId: c.id,
        at: String(c.call_date ?? c.scheduled_start ?? ""),
        subtype: c.call_subtype,
        meetingType: c.meeting_type,
        chars: charsByCall.get(c.id) ?? 0,
        text: transcripts.find((t) => t.call_id === c.id)?.body ?? "",
      }))
      // Joining noise is not a conversation: a no-show still produces a
      // transcript of "okay" and "I'll be on the line".
      .filter((t) => t.chars >= MIN_CONVERSATION_CHARS && t.at)
      .sort((a, b) => a.at.localeCompare(b.at)),
    commitments,
    gathered: extractions
      .filter((e) => e.status !== "unknown")
      .map((e) => ({
        fieldKey: e.framework_field_key,
        status: e.status,
        answer: e.answer,
        evidence: e.evidence,
        capturedFromCallId: e.last_updated_from_call_id,
        updatedAt: e.updated_at,
      }))
      .sort((a, b) => a.fieldKey.localeCompare(b.fieldKey)),
    outcomes,
    coverage: {
      capturedConversations: captured,
      callRowsWithoutConversation: calls.length - captured,
      emailsHeld: msgs.length,
      emailBodiesMissing: {
        gone: bodyStatus("gone"),
        skipped: bodyStatus("skipped"),
        notFetched: bodyStatus("not_fetched"),
      },
      // Stated per channel so a quiet stretch is never mistaken for calm.
      noHistoryBefore: {
        "qualification gate movement": "2026-09-08 (field_extractions was upserted before that)",
        "Rolldog checklist ticks": "2026-09-08 (Rolldog exposes no history endpoint)",
        "calendar RSVP": "2026-09-08 (participants was overwritten on every sync)",
        "email bodies": "2026-06-22 (metadata only before that; extendable via ingest-email-log --days)",
      },
      notes,
    },
  };
}
