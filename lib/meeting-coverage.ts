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

  const callIds = calls.map((c) => c.id);
  const dealIds = Array.from(new Set(calls.map((c) => c.deal_id).filter(Boolean))) as string[];

  const [sentRes, crmRes, fxRes, dealsRes] = await Promise.all([
    db
      .from("sent_messages")
      .select("call_id, kind, sent_at")
      .eq("tenant_id", tenantId)
      .in("call_id", callIds),
    db
      .from("crm_access_log")
      .select("call_id, fields, created_at, allowed, operation")
      .eq("tenant_id", tenantId)
      .eq("operation", "write")
      .eq("allowed", true)
      .in("call_id", callIds),
    dealIds.length > 0
      ? db
          .from("field_extractions")
          .select("deal_id, framework_field_key, status, last_updated_from_call_id")
          .in("deal_id", dealIds)
          .eq("status", "Yes")
      : Promise.resolve({ data: [] as unknown[] }),
    dealIds.length > 0
      ? db.from("deals").select("id, account").in("id", dealIds)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  const accountById = new Map(
    ((dealsRes.data ?? []) as Array<{ id: string; account: string }>).map(
      (d) => [d.id, DISPLAY[d.account] ?? d.account] as const,
    ),
  );

  // sent_messages grouped by call + kind.
  const sentByCall = new Map<string, { briefing: string[]; recap: string[] }>();
  for (const m of (sentRes.data ?? []) as Array<{ call_id: string | null; kind: string; sent_at: string }>) {
    if (!m.call_id) continue;
    const g = sentByCall.get(m.call_id) ?? { briefing: [], recap: [] };
    if (m.kind === "briefing") g.briefing.push(m.sent_at);
    else if (m.kind === "recap") g.recap.push(m.sent_at);
    sentByCall.set(m.call_id, g);
  }

  // crm writes grouped by call: sub-resources written + first write time.
  const writesByCall = new Map<string, { subs: Set<string>; ats: string[] }>();
  for (const w of (crmRes.data ?? []) as Array<{ call_id: string | null; fields: unknown; created_at: string }>) {
    if (!w.call_id) continue;
    const g = writesByCall.get(w.call_id) ?? { subs: new Set<string>(), ats: [] };
    for (const f of Array.isArray(w.fields) ? (w.fields as string[]) : []) g.subs.add(f);
    g.ats.push(w.created_at);
    writesByCall.set(w.call_id, g);
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
    const captured = c.outcome === "captured";

    const sent = sentByCall.get(c.id) ?? { briefing: [], recap: [] };

    // Briefing / recap expectations: opportunity calls get both. Non-opportunity
    // captured calls (customer/internal) get a general recap, no briefing.
    const briefing = isOpp ? scoreBriefing(sent.briefing, start, now) : notExpected();
    const recap = isOpp || (captured && c.meeting_type)
      ? scoreAfter(sent.recap, end, now)
      : notExpected();

    // Write-back: only opportunity calls write to Rolldog.
    let writeback: WritebackCoverage;
    if (isOpp) {
      const w = writesByCall.get(c.id);
      const base = scoreAfter(w?.ats ?? [], end, now);
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
