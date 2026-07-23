/**
 * Meeting coverage: for each meeting DealRipe handled, verify that every step it
 * owns actually happened, at the right time, exactly once, and completely.
 *
 *   - Briefing  : expected ~30 min before start.
 *   - Recap     : expected shortly after the call ends.
 *   - Rolldog   : write-back expected shortly after the call ends, and it should
 *                 carry every gate the call confirmed (completeness check).
 *
 * This is the answer to "did everything fire, on time, once, and did it miss
 * anything." Pure aggregation of data that already exists (calls, sent_messages,
 * crm_access_log, field_extractions). Read-only.
 */

import { getFrameworkForDeal } from "./framework";
import { rolldogOppIdForDeal } from "./pilot-config";
import { supabaseAdmin } from "./supabase";

export type StepStatus =
  | "on_time"
  | "late"
  | "early"
  | "missing"
  | "duplicate"
  | "pending"
  | "not_expected";

export type CoverageStep = {
  status: StepStatus;
  /** When the step fired (first occurrence), if it did. */
  at: string | null;
  /** Signed minutes vs the expected anchor. Negative = before, positive = after. */
  deltaMinutes: number | null;
  /** How many times it fired (>1 means duplicate). */
  count: number;
  /** Human one-liner: "28 min before start", "sent twice", "never sent". */
  detail: string;
};

export type WritebackCoverage = CoverageStep & {
  /** Rolldog sub-resources actually written for this call (budget, situation, ...). */
  written: string[];
  /** Sub-resources this call confirmed a gate for, but that were not written. */
  missed: string[];
  /** The next-step activity: written, gated (preview only), or not applicable. */
  nextStep: "written" | "gated" | "none";
};

export type MeetingCoverage = {
  callId: string;
  dealId: string | null;
  account: string | null;
  title: string | null;
  callDate: string | null;
  endDate: string | null;
  meetingType: string | null;
  callSubtype: string | null;
  outcome: string | null;
  /** True when DealRipe's briefing/recap/write-back steps apply to this call. */
  isOpportunity: boolean;
  briefing: CoverageStep;
  recap: CoverageStep;
  writeback: WritebackCoverage;
  /** Human summary of everything wrong, for the header chip. Empty = all good. */
  issues: string[];
};

const METHOD_SUBRESOURCE: Record<string, string> = {
  writeBudget: "budget",
  writeTimeline: "timeline",
  writeSituation: "situation",
  writeCompetitionNotes: "competitors",
  writeParticipantNotes: "people",
};

const SUBRESOURCE_LABEL: Record<string, string> = {
  budget: "Budget",
  timeline: "Timeline",
  situation: "Situation",
  competitors: "Competition",
  people: "People",
  activities: "Next step",
};

const DISPLAY: Record<string, string> = {
  Corelogistics: "Core Logistics",
  Airamericas: "Air Americas",
  Cargocleared: "Cargo Cleared",
  Successchb: "Success CHB",
  Cbxglobal: "CBX Global",
  Fmgloballogistics: "FM Global Logistics",
  Mastercargoinc: "Master Cargo",
  Acecustomsinc: "Ace Customs",
  Cargoservicesgroup: "Cargo Services Group",
};

export function subResourceLabel(s: string): string {
  return SUBRESOURCE_LABEL[s] ?? s;
}

// Calls DealRipe never handles end-to-end (no transcript / lost capture). These
// never carry briefing/recap/write-back expectations.
const NO_CONTENT = new Set(["no_show", "no_conversation", "capture_failed", "placeholder"]);

const MINUTE = 60000;

/** Briefing timing: on time if sent 5-90 min before start. */
function scoreBriefing(sentAts: string[], startIso: string | null, now: number): CoverageStep {
  return scoreStep({
    sentAts,
    anchorIso: startIso,
    now,
    // Expected before the anchor: window is [-90, -5] minutes.
    windowMin: -90,
    windowMax: -5,
    // A briefing is only "due" once we're within ~90 min of start.
    dueAtIso: startIso ? new Date(Date.parse(startIso) - 90 * MINUTE).toISOString() : null,
    anchorName: "start",
  });
}

/** Recap / write-back timing: on time if it fires 0-120 min after end. */
function scoreAfter(sentAts: string[], endIso: string | null, now: number): CoverageStep {
  return scoreStep({
    sentAts,
    anchorIso: endIso,
    now,
    windowMin: 0,
    windowMax: 120,
    dueAtIso: endIso,
    anchorName: "end",
  });
}

function scoreStep(args: {
  sentAts: string[];
  anchorIso: string | null;
  now: number;
  windowMin: number;
  windowMax: number;
  dueAtIso: string | null;
  anchorName: string;
}): CoverageStep {
  const { sentAts, anchorIso, now, windowMin, windowMax, dueAtIso, anchorName } = args;
  const sorted = [...sentAts].filter(Boolean).sort();
  const count = sorted.length;

  if (count === 0) {
    // Nothing sent. If the step isn't due yet, it's pending, not missing.
    if (dueAtIso && Date.parse(dueAtIso) > now) {
      return { status: "pending", at: null, deltaMinutes: null, count: 0, detail: "not due yet" };
    }
    return { status: "missing", at: null, deltaMinutes: null, count: 0, detail: "never sent" };
  }

  const first = sorted[0];
  const delta = anchorIso ? Math.round((Date.parse(first) - Date.parse(anchorIso)) / MINUTE) : null;
  const detail = describeDelta(delta, anchorName);

  if (count > 1) {
    return { status: "duplicate", at: first, deltaMinutes: delta, count, detail: `sent ${count} times` };
  }
  if (delta == null) {
    return { status: "on_time", at: first, deltaMinutes: null, count, detail: "sent" };
  }
  if (delta < windowMin) return { status: "early", at: first, deltaMinutes: delta, count, detail };
  if (delta > windowMax) return { status: "late", at: first, deltaMinutes: delta, count, detail };
  return { status: "on_time", at: first, deltaMinutes: delta, count, detail };
}

function describeDelta(delta: number | null, anchor: string): string {
  if (delta == null) return "sent";
  const abs = Math.abs(delta);
  const mag = abs >= 60 ? `${Math.floor(abs / 60)}h ${abs % 60}m` : `${abs} min`;
  return delta <= 0 ? `${mag} before ${anchor}` : `${mag} after ${anchor}`;
}

// Collapse a set of timestamps into distinct "runs": timestamps closer than the
// gap are the same event (one write-back emits many audit rows within seconds).
// Returns one representative (earliest) timestamp per run.
function clusterRuns(ats: string[], gapMs = 15 * MINUTE): string[] {
  const sorted = ats.filter(Boolean).map((a) => Date.parse(a)).filter(Number.isFinite).sort((a, b) => a - b);
  const runs: string[] = [];
  let last = -Infinity;
  for (const t of sorted) {
    if (t - last > gapMs) runs.push(new Date(t).toISOString()); // new run starts here
    last = t;
  }
  return runs;
}

const notExpected = (): CoverageStep => ({
  status: "not_expected",
  at: null,
  deltaMinutes: null,
  count: 0,
  detail: "not applicable",
});

export async function getMeetingCoverage(
  tenantId: string,
  opts: { sinceIso?: string; untilIso?: string } = {},
): Promise<MeetingCoverage[]> {
  const db = supabaseAdmin();
  const now = Date.now();

  let callQuery = db
    .from("calls")
    .select("id, deal_id, scheduled_start, call_date, duration_minutes, outcome, meeting_type, call_subtype, title")
    .eq("tenant_id", tenantId)
    .order("scheduled_start", { ascending: false });
  if (opts.sinceIso) callQuery = callQuery.gte("scheduled_start", opts.sinceIso);
  if (opts.untilIso) callQuery = callQuery.lte("scheduled_start", opts.untilIso);
  const callsRes = await callQuery;

  const calls = ((callsRes.data ?? []) as Array<{
    id: string;
    deal_id: string | null;
    scheduled_start: string | null;
    call_date: string | null;
    duration_minutes: number | null;
    outcome: string | null;
    meeting_type: string | null;
    call_subtype: string | null;
    title: string | null;
  }>).filter((c) => !NO_CONTENT.has(c.outcome ?? ""));

  if (calls.length === 0) return [];

  const dealIds = Array.from(new Set(calls.map((c) => c.deal_id).filter(Boolean))) as string[];

  const [allCallsRes, sentRes, crmRes, fxRes, dealsRes] = await Promise.all([
    // ALL calls for the involved deals (not just in-range), so a message or write
    // can be attributed to its true nearest call even if that call is off-screen.
    dealIds.length > 0
      ? db.from("calls").select("id, deal_id, scheduled_start, call_date").eq("tenant_id", tenantId).in("deal_id", dealIds)
      : Promise.resolve({ data: [] as unknown[] }),
    // All sends for the involved deals, by deal (not by call_id), so historical
    // rows written before call_id was stored still attribute by nearest time.
    dealIds.length > 0
      ? db.from("sent_messages").select("deal_id, call_id, kind, sent_at, provider_id").eq("tenant_id", tenantId).in("deal_id", dealIds)
      : Promise.resolve({ data: [] as unknown[] }),
    // All Rolldog writes for the tenant. crm_access_log has no deal_id, so we map
    // via call_id (new rows) or opportunity id -> deal (legacy rows).
    db
      .from("crm_access_log")
      .select("call_id, opportunity_external_id, fields, created_at, allowed, operation")
      .eq("tenant_id", tenantId)
      .eq("operation", "write")
      .eq("allowed", true),
    dealIds.length > 0
      ? db
          .from("field_extractions")
          .select("deal_id, framework_field_key, status, last_updated_from_call_id")
          .in("deal_id", dealIds)
          .eq("status", "Yes")
      : Promise.resolve({ data: [] as unknown[] }),
    dealIds.length > 0
      ? db.from("deals").select("id, account, external_id, rolldog_opportunity_id").in("id", dealIds)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  const deals = (dealsRes.data ?? []) as Array<{
    id: string;
    account: string;
    external_id: string | null;
    rolldog_opportunity_id: string | null;
  }>;
  const accountById = new Map(deals.map((d) => [d.id, DISPLAY[d.account] ?? d.account] as const));
  // A deal is Rolldog-linked if it has a static pilot id or a stored opportunity id.
  const rolldogLinkedByDeal = new Map(
    deals.map((d) => [d.id, !!(d.external_id && rolldogOppIdForDeal(d.external_id)) || !!d.rolldog_opportunity_id] as const),
  );
  // opportunity id -> deal id, for attributing legacy write rows with no call_id.
  const oppToDeal = new Map<string, string>();
  for (const d of deals) {
    const opp = (d.external_id ? rolldogOppIdForDeal(d.external_id) : null) ?? d.rolldog_opportunity_id;
    if (opp) oppToDeal.set(String(opp), d.id);
  }

  // Every call per deal (sorted by date) + a call -> deal lookup, for the
  // nearest-in-time attribution fallback.
  const allCalls = (allCallsRes.data ?? []) as Array<{
    id: string;
    deal_id: string | null;
    scheduled_start: string | null;
    call_date: string | null;
  }>;
  const callsByDeal = new Map<string, Array<{ id: string; t: number }>>();
  const dealByCallId = new Map<string, string>();
  for (const c of allCalls) {
    if (!c.deal_id) continue;
    dealByCallId.set(c.id, c.deal_id);
    const date = c.scheduled_start ?? c.call_date;
    if (!date) continue;
    const list = callsByDeal.get(c.deal_id) ?? [];
    list.push({ id: c.id, t: Date.parse(date) });
    callsByDeal.set(c.deal_id, list);
  }

  // Attribute an item (a send or a write) to a call: prefer its stored call_id
  // (hard link, set going forward); else the deal's nearest call by time. This
  // matches the activity log's association so historical data reads correctly.
  const renderedCallIds = new Set(calls.map((c) => c.id));
  function attribute(dealId: string | null, hardCallId: string | null, atIso: string): string | null {
    if (hardCallId && renderedCallIds.has(hardCallId)) return hardCallId;
    if (!dealId) return null;
    const list = callsByDeal.get(dealId);
    if (!list || list.length === 0) return null;
    const t = Date.parse(atIso);
    let best: string | null = null;
    let bestDiff = Infinity;
    for (const c of list) {
      const d = Math.abs(c.t - t);
      if (d < bestDiff) {
        bestDiff = d;
        best = c.id;
      }
    }
    return best && renderedCallIds.has(best) ? best : null;
  }

  // sent_messages grouped by attributed call + kind. Only real emails count: a
  // dry-run archive (format refresh or re-ingest) has a null provider_id and was
  // never sent to the rep, so it must not inflate the send count into a "sent
  // twice" duplicate.
  const sentByCall = new Map<string, { briefing: string[]; recap: string[] }>();
  for (const m of (sentRes.data ?? []) as Array<{
    deal_id: string | null;
    call_id: string | null;
    kind: string;
    sent_at: string;
    provider_id: string | null;
  }>) {
    if (m.kind !== "briefing" && m.kind !== "recap") continue;
    if (!m.provider_id) continue; // archived but not emailed
    const cid = attribute(m.deal_id, m.call_id, m.sent_at);
    if (!cid) continue;
    const g = sentByCall.get(cid) ?? { briefing: [], recap: [] };
    if (m.kind === "briefing") g.briefing.push(m.sent_at);
    else g.recap.push(m.sent_at);
    sentByCall.set(cid, g);
  }

  // crm writes grouped by attributed call: sub-resources written + write times.
  const writesByCall = new Map<string, { subs: Set<string>; ats: string[] }>();
  for (const w of (crmRes.data ?? []) as Array<{
    call_id: string | null;
    opportunity_external_id: string;
    fields: unknown;
    created_at: string;
  }>) {
    const dealId = (w.call_id ? dealByCallId.get(w.call_id) : null) ?? oppToDeal.get(String(w.opportunity_external_id)) ?? null;
    const cid = attribute(dealId, w.call_id, w.created_at);
    if (!cid) continue;
    const g = writesByCall.get(cid) ?? { subs: new Set<string>(), ats: [] };
    for (const f of Array.isArray(w.fields) ? (w.fields as string[]) : []) g.subs.add(f);
    g.ats.push(w.created_at);
    writesByCall.set(cid, g);
  }

  // Gates confirmed per call (field_key), for the completeness check.
  const gatesByCall = new Map<string, string[]>();
  for (const r of (fxRes.data ?? []) as Array<{
    framework_field_key: string;
    last_updated_from_call_id: string | null;
  }>) {
    const cid = r.last_updated_from_call_id;
    if (!cid) continue;
    const list = gatesByCall.get(cid) ?? [];
    list.push(r.framework_field_key);
    gatesByCall.set(cid, list);
  }

  // field_key -> rolldog sub-resource, per deal's framework. Cached by deal.
  const subResourceMapByDeal = new Map<string, Map<string, string>>();
  async function fieldSubResourceMap(dealId: string): Promise<Map<string, string>> {
    const cached = subResourceMapByDeal.get(dealId);
    if (cached) return cached;
    const map = new Map<string, string>();
    try {
      const fw = await getFrameworkForDeal(dealId);
      if (fw) {
        for (const f of fw.fields) {
          const method = f.writeTarget && f.writeTarget.system === "rolldog" ? String(f.writeTarget.method ?? "") : "";
          const sub = METHOD_SUBRESOURCE[method];
          if (sub) map.set(f.fieldKey, sub);
        }
      }
    } catch {
      /* best-effort: no map means no completeness check for this deal */
    }
    subResourceMapByDeal.set(dealId, map);
    return map;
  }

  const liveNextStep = process.env.ROLLDOG_WRITE_NEXT_STEP !== "0";

  const out: MeetingCoverage[] = [];
  for (const c of calls) {
    const start = c.scheduled_start ?? c.call_date;
    const durMin = c.duration_minutes ?? 0;
    const end = start ? new Date(Date.parse(start) + durMin * MINUTE).toISOString() : null;
    const isOpp = c.meeting_type === "new_opportunity";
    const hasDeal = !!c.deal_id;
    const rolldogLinked = c.deal_id ? rolldogLinkedByDeal.get(c.deal_id) ?? false : false;

    const sent = sentByCall.get(c.id) ?? { briefing: [], recap: [] };

    // Briefing + recap apply to every customer-facing deal meeting DealRipe
    // handles (discovery, demo, follow-up, existing-customer). They do NOT apply
    // to internal meetings, calls not tied to a deal, or calls we never classified
    // (unknown type = we can't assert DealRipe should have briefed/recapped it).
    const dealMeeting =
      hasDeal && (c.meeting_type === "new_opportunity" || c.meeting_type === "existing_customer");
    const briefing = dealMeeting ? scoreBriefing(sent.briefing, start, now) : notExpected();
    const recap = dealMeeting ? scoreAfter(sent.recap, end, now) : notExpected();

    // Write-back applies only when there's something to push (an opportunity call)
    // AND the deal is linked to a Rolldog opportunity. Not linked, or not an
    // opportunity meeting (existing customer / internal), means N/A, not a miss.
    let writeback: WritebackCoverage;
    if (isOpp && rolldogLinked) {
      const w = writesByCall.get(c.id);
      // One write-back run emits ~6 audit rows (one per sub-resource). Collapse
      // rows into runs (gap > 15 min = a separate run) so a single successful
      // write-back is not mistaken for six duplicates.
      const runs = clusterRuns(w?.ats ?? []);
      const base = scoreAfter(runs, end, now);
      const written = w ? Array.from(w.subs) : [];
      const nonNext = written.filter((s) => s !== "activities");

      // Completeness: gates confirmed on this call -> expected sub-resources,
      // minus what was actually written.
      let missed: string[] = [];
      if (c.deal_id) {
        const map = await fieldSubResourceMap(c.deal_id);
        const expected = new Set<string>();
        for (const key of gatesByCall.get(c.id) ?? []) {
          const sub = map.get(key);
          if (sub) expected.add(sub);
        }
        missed = Array.from(expected).filter((s) => !written.includes(s));
      }

      const nextStep: WritebackCoverage["nextStep"] = written.includes("activities")
        ? "written"
        : liveNextStep
          ? "none"
          : "gated";

      // If no substantive sub-resource was written but gates existed, that's the
      // real miss; reflect it in the primary status too.
      let status = base.status;
      let detail = base.detail;
      if (base.status !== "pending" && nonNext.length === 0 && (gatesByCall.get(c.id)?.length ?? 0) > 0) {
        status = "missing";
        detail = "no fields written";
      }
      writeback = { ...base, status, detail, written, missed, nextStep };
    } else {
      writeback = { ...notExpected(), written: [], missed: [], nextStep: "none" };
    }

    const issues: string[] = [];
    const flag = (s: CoverageStep, name: string) => {
      if (s.status === "missing") issues.push(`${name} never sent`);
      else if (s.status === "late") issues.push(`${name} late (${s.detail})`);
      else if (s.status === "duplicate") issues.push(`${name} ${s.detail}`);
      else if (s.status === "early") issues.push(`${name} early (${s.detail})`);
    };
    flag(briefing, "Briefing");
    flag(recap, "Recap");
    flag(writeback, "Write-back");
    if (writeback.missed.length > 0) {
      issues.push(`Write-back missed ${writeback.missed.map(subResourceLabel).join(", ")}`);
    }

    out.push({
      callId: c.id,
      dealId: c.deal_id,
      account: c.deal_id ? accountById.get(c.deal_id) ?? null : null,
      title: c.title,
      callDate: start,
      endDate: end,
      meetingType: c.meeting_type,
      callSubtype: c.call_subtype,
      outcome: c.outcome,
      isOpportunity: isOpp,
      briefing,
      recap,
      writeback,
      issues,
    });
  }

  return out;
}
