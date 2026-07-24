/**
 * Pipeline changes: the single engine behind Mark's weekly digest and the
 * /review dashboard. Per Rolldog-linked deal it assembles one change record:
 *   - the rep-entered Rolldog state (stage, forecast category, deal size, close
 *     date, score, status, created/current-stage dates)
 *   - what changed in the window (Rolldog stage entry + DealRipe snapshot deltas)
 *   - the call-caught flags Mark triages on (dark budget owner, single-threaded,
 *     no-show, commit-but-open-gates divergence, stall, competitor, signature,
 *     budget mismatch [dormant until a price list exists])
 *   - an attention score weighted the way Mark works: deal size (annualized),
 *     close proximity, forecast category, net-new over renewals, yellow-first.
 * Plus an aggregate headline (pipeline, forecast mix, won/lost, counts).
 *
 * Structured only: no prose is baked in here, so the email and the dashboard can
 * render it differently. Read-only. Best-effort per deal (a Rolldog read failure
 * degrades that deal, never the whole build).
 */

import { isMeaningfulContact } from "./contacts-extract";
import { prettyAccount, repName } from "./display-names";
import { loadFramework, type Framework } from "./framework";
import { rolldogOppIdForDeal } from "./pilot-config";
import { getRolldogSummary, daysSince, type RolldogSummary } from "./rolldog-summary";
import type { DealSignals } from "./snapshot";
import { supabaseAdmin } from "./supabase";
import { getUpcomingCallForDeal } from "./supabase-queries";

const NO_SHOW_OUTCOMES = new Set(["no_conversation", "no_show", "rescheduled", "placeholder", "capture_failed"]);
const BUYER_RE = /budget|cfo|chief financ|owner|final (say|decision)|economic|controller/i;
const COMPETITION_KEY_RE = /compet/i;
const SIGNATURE_KEY_RE = /signature|agreement|sign.?off|contract/i;

export type ChangeEvent = {
  kind: "stage" | "forecast" | "amount" | "close_date" | "won" | "lost" | "new" | "removed" | "gates";
  label: string;
  from: string | null;
  to: string | null;
  at: string | null;
  source: "rolldog" | "dealripe";
};

/**
 * The week-over-week verdict Mark reads first: did this deal progress, and if
 * not, is it just sitting. Derived from Rolldog's own week-start vs week-end
 * state (stage entry, forecast, close, size). "forward" = advanced a stage or
 * forecast raised; "backward" = slipped, forecast cut, or close pushed out;
 * "none" = no change (with the stall context so a stuck deal reads as stuck).
 */
export type Movement = {
  summary: string;
  direction: "forward" | "backward" | "none";
  events: string[];
  moved: boolean;
};

/**
 * One specific thing the calls surfaced this week, with the real detail (the
 * budget figure, the competitor name, the stakeholder who came in), not a
 * generic label. This is DealRipe's edge in the "what changed" story: progress
 * the reps may not have logged, read straight off the conversations.
 * tone: up = the deal learned something good, down = a setback, neutral = a fact.
 */
export type WeekChange = { label?: string; text: string; tone: "up" | "down" | "neutral" };

/** The rep's primary CRM change this window, as a from -> to (the fields the rep
 * owns and DealRipe does not write: forecast, stage, close date, amount, new opp). */
export type RepChange = { label: string; from: string | null; to: string | null };

/**
 * DealRipe's judgment on the rep's change (or lack of one), checked against the
 * calls. The heart of the dashboard:
 *   confirmed  = the rep advanced it and the calls back the move
 *   overstated = the rep advanced it but the evidence has critical gaps
 *   risk       = the rep changed nothing, but the calls caught a blocker
 *   lags       = the rep changed nothing, but the calls show progress not yet logged
 *   none       = nothing notable (kept off the hero view)
 */
export type Verdict = { kind: "confirmed" | "overstated" | "risk" | "lags" | "none"; text: string };

export type FlagSeverity = "high" | "med" | "low";
export type DealFlag = {
  kind:
    | "dark_buyer"
    | "single_threaded"
    | "no_show"
    | "stage_divergence"
    | "commit_divergence"
    | "stalled"
    | "competitor_unknown"
    | "signature_pending"
    | "no_next_meeting"
    | "not_in_rolldog"
    | "budget_mismatch";
  severity: FlagSeverity;
  text: string;
};

/** A key qualification field the calls captured, with the actual answer. */
export type CapturedField = { label: string; value: string };

export type DealChangeRecord = {
  dealId: string;
  account: string;
  repEmail: string | null;
  repName: string;
  rolldogOppId: string | null;
  // Rolldog (rep-entered) current state.
  stageName: string | null;
  stageKey: string | null;
  forecastCategory: string | null;
  dealSizeMonthly: number | null;
  dealSizeAnnual: number | null;
  closeDate: string | null;
  score: string | null;
  status: string | null;
  archived: boolean;
  isRenewal: boolean;
  createdAt: string | null;
  currentStageDate: string | null;
  daysInStage: number | null;
  daysToClose: number | null;
  gatesConfirmed: number;
  inRolldog: boolean;
  // The substance Mark wants: the actual captured answers, the specific gaps,
  // the named economic buyer, and whether a next meeting is even booked.
  captured: CapturedField[];
  missing: string[];
  economicBuyer: { name: string | null; role: string | null; engaged: boolean } | null;
  // The main customer contact on the calls (champion, or the most-engaged
  // person), for naming "the customer" in the agreed next step.
  primaryContact: { name: string; role: string | null; relationship: string | null } | null;
  nextMeetingBooked: boolean;
  // The last actual conversation, and the next step agreed on it, so the digest
  // is anchored in what happened and reasons about follow-up correctly.
  lastConversationAt: string | null;
  agreedNextStep: string | null;
  // True when the agreed next step is the customer's move (they respond / board
  // meeting), so the rep is not overdue on a meeting. followUpBy is the date to
  // check in if we can parse a timeframe. repOwedMeeting: a specific call was
  // agreed and the rep has not put it on the calendar.
  nextStepIsCustomerWait: boolean;
  // The agreed next step is a specific follow-up call/meeting (so "is it booked?"
  // is a meaningful question). repOwedMeeting: that meeting is not on the calendar.
  nextStepIsMeeting: boolean;
  repOwedMeeting: boolean;
  followUpBy: string | null;
  // For a no-show: what the meeting was and who was invited.
  noShowTitle: string | null;
  noShowInvitees: string[];
  // The concrete next action, written from this deal's facts. Null until the
  // synthesis step fills it (kept out of the engine so the engine stays fast and
  // deterministic).
  doThis: string | null;
  // Did the deal move this week (the lead line on every card).
  movement: Movement;
  // The specific things the calls surfaced this week (budget figures, competitor
  // names, stakeholders engaged, gates answered), the substance behind movement.
  whatChanged: WeekChange[];
  // The specific open gaps blocking THIS deal, from its own call context: the
  // named dark buyer, the SCOTSMAN gates still unanswered, single-threading,
  // stall. Grounded per deal, not a single generic line.
  blockers: string[];
  // The rep's primary change this window and DealRipe's verdict on it. These
  // drive the dashboard hero ("rep changes, checked against the calls").
  repChange: RepChange | null;
  verdict: Verdict;
  // DealRipe's own forecast category (one conservative notch off the rep's,
  // based on the call evidence) and a plain health status for the master table.
  // "no_data" = DealRipe has not captured a call on this deal yet.
  dealRipeCategory: string | null;
  dealHealth: "at_risk" | "stalled" | "healthy" | "no_data";
  // Rolldog's last-updated timestamp (the staleness signal Mark reads).
  lastUpdatedAt: string | null;
  changes: ChangeEvent[];
  flags: DealFlag[];
  attention: number;
  needsAttention: boolean;
  isNoShow: boolean;
};

export type ForecastBucket = { category: string; deals: number; annual: number };
export type Headline = {
  totalPipelineAnnual: number;
  forecastMix: ForecastBucket[];
  closedWon: number;
  closedLost: number;
  dealsChanged: number;
  dealsNeedingAttention: number;
  newOpportunities: number;
};

export type PipelineChanges = {
  headline: Headline;
  deals: DealChangeRecord[];
  window: { sinceIso: string; untilIso: string };
};

// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const group = <T extends { deal_id: string }>(arr: T[]) =>
  arr.reduce<Record<string, T[]>>((m, r) => ((m[r.deal_id] ??= []).push(r), m), {});

function inWindow(iso: string | null | undefined, sinceMs: number, untilMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t >= sinceMs && t <= untilMs;
}

// High-value confirmed gates to name in the divergence flag, in Mark's terms.
const GATE_LABELS: Array<[RegExp, string]> = [
  [/budget/i, "budget"],
  [/compet/i, "competition"],
  [/decision_process|key_decision_maker|authority|exec/i, "the decision process"],
  [/timeline|close_date/i, "timeline"],
];
function notableGates(keys: Set<string>): string[] {
  const out: string[] = [];
  for (const [re, label] of GATE_LABELS) {
    if ([...keys].some((k) => re.test(k)) && !out.includes(label)) out.push(label);
  }
  return out.slice(0, 3);
}

// The qualification fields Mark actually cares about, in his order. Each maps a
// framework field-key pattern to the label shown in the digest. Used for both
// "Captured" (with the real answer) and "Missing" (the gaps).
const KEY_FIELDS: Array<{ re: RegExp; label: string }> = [
  { re: /why_looking|driver|situation/i, label: "Why now" },
  { re: /budget/i, label: "Budget" },
  { re: /compet/i, label: "Competition" },
  { re: /economic|budget_approver|key_decision_maker/i, label: "Economic buyer" },
  { re: /decision_process|authority/i, label: "Decision process" },
  { re: /exec/i, label: "Exec involvement" },
  { re: /timeline|close_date/i, label: "Timeline / close date" },
  { re: /signature|agreement|contract/i, label: "Agreement / signature" },
];

/**
 * A digest-ready version of a captured answer: complete but tight. Strips the
 * "the customer indicated that" filler so it reads straight to the point,
 * returns the whole thing when it's a sensible length, and only when it is
 * genuinely long trims at a sentence or word boundary (never mid-word).
 */
function concise(a: string | null | undefined, max = 170): string {
  let s = (a ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  s = s
    .replace(
      /^(the (customer|client|prospect|buyer)|they|he|she)\s+(indicated|mentioned|noted|said|explained|stated|confirmed|shared|revealed|told us|let us know|clarified)\s+(that\s+)?/i,
      "",
    )
    .replace(/^(it was (noted|mentioned|confirmed) that|according to [^,]+,|per the (call|customer),?)\s*/i, "")
    .trim();
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  if (lastStop >= max * 0.5) return s.slice(0, lastStop + 1).trim();
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

function dateShort(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" });
  } catch {
    return "";
  }
}

/** Swap the generic "the rep" in extracted text for the rep's actual name. */
function personalizeRep(text: string | null, name: string): string | null {
  if (!text || !name || name === "the rep") return text;
  return text
    .replace(/\bthe rep's\b/gi, `${name}'s`)
    .replace(/\bthe rep\b/gi, name)
    .replace(/\brep's\b/gi, `${name}'s`);
}

/** Drop placeholder buyer names ("CEO (unnamed)", "unknown", "TBD") so they read
 * as unidentified rather than a fake name. */
function cleanBuyerName(n: string | null): string | null {
  const s = (n ?? "").trim();
  if (!s) return null;
  if (/unnamed|unknown|unidentified|not identified|^tbd$|^n\/?a$|^\(/i.test(s)) return null;
  return s;
}

/** Swap the generic "the customer" for the actual contact's name. */
function personalizeCustomer(text: string | null, name: string | null): string | null {
  if (!text || !name) return text;
  return text.replace(/\bthe customer's\b/gi, `${name}'s`).replace(/\bthe customer\b/gi, name);
}

/** Customer-side invitee names (or emails) from a call's participants JSON. */
function customerInviteeNames(participants: unknown): string[] {
  if (!Array.isArray(participants)) return [];
  const out: string[] = [];
  for (const p of participants as Array<Record<string, unknown>>) {
    const email = typeof p.email === "string" ? p.email : "";
    const domain = email.split("@")[1]?.toLowerCase();
    if (domain && domain !== "magaya.com") {
      const nm = typeof p.name === "string" && p.name.trim() ? p.name.trim() : email.split("@")[0].replace(/[._]/g, " ");
      out.push(nm);
    }
  }
  return out.slice(0, 4);
}

function stageKeyFromName(name: string | null): string | null {
  if (!name) return null;
  const m = name.match(/SQL\s*(\d)/i);
  return m ? `SQL${m[1]}` : null;
}
function stageRank(key: string | null): number | null {
  const m = key?.match(/(\d)/);
  return m ? parseInt(m[1], 10) : null;
}

const WON_RE = /won|closed.?won/i;
const LOST_RE = /lost|closed.?lost/i;
const RENEWAL_RE = /renew/i;
const COMMIT_RE = /commit/i;
const EXPECT_RE = /expect/i;

/**
 * Real week-over-week deltas from the Rolldog state captured in each day's
 * snapshot. This is the honest change story: Rolldog's own stage / forecast /
 * size / close, diffed across the window. Falls back to the DealRipe-side amount
 * and close only when no snapshot in the window carries a Rolldog block yet
 * (before enrichment history exists).
 */
function snapshotChanges(snaps: DealSignals[]): ChangeEvent[] {
  const rd = snaps.filter((s) => s.rolldog);
  if (rd.length >= 2) {
    const out: ChangeEvent[] = [];
    const track = (
      kind: ChangeEvent["kind"],
      label: string,
      get: (s: DealSignals) => string | number | null,
    ) => {
      let last: string | number | null = null;
      for (const s of rd) {
        const v = get(s);
        if (v === null || v === "") continue;
        if (last !== null && String(v) !== String(last)) {
          out.push({ kind, label, from: String(last), to: String(v), at: s.capturedAt, source: "rolldog" });
        }
        last = v;
      }
    };
    track("stage", "Stage", (s) => s.rolldog!.stageName);
    track("forecast", "Forecast", (s) => s.rolldog!.forecastCategory);
    // Store amount annualized (monthly * 12) to match ARR semantics elsewhere.
    track("amount", "Amount", (s) => (s.rolldog!.dealSizeMonthly != null ? s.rolldog!.dealSizeMonthly * 12 : null));
    track("close_date", "Close date", (s) => s.rolldog!.closeDate);
    return out;
  }
  // Fallback (no Rolldog history yet): DealRipe deal-record amount and close.
  const out: ChangeEvent[] = [];
  const track = (kind: ChangeEvent["kind"], label: string, get: (s: DealSignals) => string | number) => {
    let last: string | number | null = null;
    for (const s of snaps) {
      const v = get(s);
      if (last !== null && String(v) !== String(last)) {
        out.push({ kind, label, from: String(last), to: String(v), at: s.capturedAt, source: "dealripe" });
      }
      last = v;
    }
  };
  track("amount", "Amount", (s) => s.amount);
  track("close_date", "Close date", (s) => s.closeDate);
  return out;
}

const FCAST_ORDER = (c: string | null): number | null => {
  if (!c) return null;
  const l = c.toLowerCase();
  if (/commit/.test(l)) return 3;
  if (/expect/.test(l)) return 2;
  if (/pipeline/.test(l)) return 1;
  if (/omit/.test(l)) return 0;
  return null;
};
const CATEGORY_NAMES = ["Omitted", "Pipeline", "Expect", "Commit"] as const;
function categoryFromOrder(n: number): string {
  return CATEGORY_NAMES[Math.max(0, Math.min(3, n))];
}

function money0(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
}

/**
 * Turn the in-window change events into the one-line "did it move this week"
 * verdict, ordered stage > forecast > close > size. When nothing changed, say so
 * with the stall context (days in the current stage) so a stuck deal reads as
 * stuck rather than silent.
 */
function computeMovement(
  changes: ChangeEvent[],
  ctx: { daysInStage: number | null; stageName: string | null; progress: WeekChange[]; isNoShow: boolean; gainedCount: number },
): Movement {
  if (changes.some((c) => c.kind === "new")) {
    return { summary: `New opportunity, entered ${stageKeyFromName(ctx.stageName) ?? ctx.stageName ?? "pipeline"}`, direction: "forward", events: ["new"], moved: true };
  }
  const won = changes.find((c) => c.kind === "won");
  if (won) return { summary: "Closed won this week", direction: "forward", events: ["won"], moved: true };
  const lost = changes.find((c) => c.kind === "lost");
  if (lost) return { summary: `Closed lost this week${lost.to ? ` (${lost.to})` : ""}`, direction: "backward", events: ["lost"], moved: true };

  const parts: string[] = [];
  let direction: Movement["direction"] = "none";

  // Stage: prefer an event with a real from (snapshot diff) over the bare
  // current-stage-date entry (from = null).
  const stageEvents = changes.filter((c) => c.kind === "stage");
  const stageEv = stageEvents.find((c) => c.from) ?? stageEvents[0];
  if (stageEv) {
    const toKey = stageKeyFromName(stageEv.to);
    const frKey = stageEv.from ? stageKeyFromName(stageEv.from) : null;
    const toR = stageRank(toKey);
    const frR = stageRank(frKey);
    if (frR != null && toR != null && toR > frR) {
      parts.push(`advanced ${frKey} → ${toKey}`);
      direction = "forward";
    } else if (frR != null && toR != null && toR < frR) {
      parts.push(`slipped ${frKey} → ${toKey}`);
      direction = "backward";
    } else {
      parts.push(`moved to ${toKey ?? stageEv.to} this week`);
      direction = "forward";
    }
  }

  const fc = changes.find((c) => c.kind === "forecast");
  if (fc) {
    const fr = FCAST_ORDER(fc.from);
    const tr = FCAST_ORDER(fc.to);
    if (fr != null && tr != null && tr > fr) {
      parts.push(`forecast ${fc.from} → ${fc.to}`);
      if (direction !== "backward") direction = "forward";
    } else if (fr != null && tr != null && tr < fr) {
      parts.push(`forecast cut ${fc.from} → ${fc.to}`);
      direction = "backward";
    } else {
      parts.push(`forecast now ${fc.to}`);
    }
  }

  const cd = changes.find((c) => c.kind === "close_date");
  if (cd && cd.from && cd.to) {
    const a = Date.parse(cd.from);
    const b = Date.parse(cd.to);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      if (b > a + 7 * 86_400_000) {
        parts.push(`close pushed to ${dateShort(cd.to)}`);
        if (direction === "none") direction = "backward";
      } else if (b < a - 7 * 86_400_000) {
        parts.push(`close pulled in to ${dateShort(cd.to)}`);
        if (direction !== "backward") direction = "forward";
      }
    }
  }

  const am = changes.find((c) => c.kind === "amount");
  if (am && am.from && am.to) {
    const a = Number(am.from);
    const b = Number(am.to);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) parts.push(`${b > a ? "size up" : "size down"} to ${money0(b)}/yr`);
  }

  // Rolldog fields didn't move. The calls still may have: DealRipe's edge is
  // showing that ground was gained (or lost) on the conversations this week.
  if (parts.length === 0) {
    const gains = ctx.gainedCount;
    const losses = ctx.progress.filter((p) => p.tone === "down").length;
    if (ctx.isNoShow) return { summary: "A meeting was missed this week", direction: "backward", events: [], moved: true };
    if (gains > 0) return { summary: `Advanced on the calls this week`, direction: "forward", events: [], moved: true };
    if (losses > 0) return { summary: "A setback surfaced on calls this week", direction: "backward", events: [], moved: true };
    const key = stageKeyFromName(ctx.stageName);
    const stall = ctx.daysInStage != null && key ? `, ${ctx.daysInStage} days in ${key}` : "";
    return { summary: `No movement this week${stall}`, direction: "none", events: [], moved: false };
  }
  const summary = parts.map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p)).join(", ");
  return { summary, direction, events: parts, moved: true };
}

/** Render a Rolldog change event as the rep-facing from -> to for the hero. */
function describeRepChange(ev: ChangeEvent): RepChange {
  if (ev.kind === "new") return { label: "New opportunity", from: null, to: "New opp" };
  if (ev.kind === "stage") return { label: "Stage", from: stageKeyFromName(ev.from), to: stageKeyFromName(ev.to) };
  if (ev.kind === "forecast") return { label: "Forecast", from: ev.from, to: ev.to };
  if (ev.kind === "close_date") return { label: "Close date", from: dateShort(ev.from), to: dateShort(ev.to) };
  if (ev.kind === "amount") return { label: "Amount", from: ev.from ? money0(Number(ev.from)) : null, to: ev.to ? money0(Number(ev.to)) : null };
  return { label: ev.label, from: ev.from, to: ev.to };
}

/** Whether the rep's change is an advance (forecast up, stage up, close pulled in,
 * amount up, new) vs a de-risking move (forecast cut, stage slip, close pushed). */
function isAdvancingChange(ev: ChangeEvent): boolean {
  if (ev.kind === "new") return true;
  if (ev.kind === "forecast") {
    const a = FCAST_ORDER(ev.from);
    const b = FCAST_ORDER(ev.to);
    return a != null && b != null && b > a;
  }
  if (ev.kind === "stage") {
    const a = stageRank(stageKeyFromName(ev.from));
    const b = stageRank(stageKeyFromName(ev.to));
    return a != null && b != null && b > a;
  }
  if (ev.kind === "close_date") {
    const a = Date.parse(ev.from ?? "");
    const b = Date.parse(ev.to ?? "");
    return Number.isFinite(a) && Number.isFinite(b) && b < a;
  }
  if (ev.kind === "amount") return Number(ev.to) > Number(ev.from);
  return false;
}

/** Attention score, weighted the way Mark triages. */
function scoreAttention(args: {
  flags: DealFlag[];
  annual: number | null;
  daysToClose: number | null;
  category: string | null;
  isRenewal: boolean;
  hasBackwardChange: boolean;
}): number {
  const sev = (s: FlagSeverity) => (s === "high" ? 40 : s === "med" ? 20 : 8);
  let score = args.flags.reduce((n, f) => n + sev(f.severity), 0);
  if (args.hasBackwardChange) score += 25;
  // Deal size (annualized): $300k -> +30, log-ish cap.
  if (args.annual) score += Math.min(30, Math.round(args.annual / 10000));
  // Close proximity.
  if (args.daysToClose != null) {
    if (args.daysToClose <= 14) score += 20;
    else if (args.daysToClose <= 30) score += 12;
    else if (args.daysToClose <= 60) score += 6;
  }
  // Forecast category: a Commit/Expect with problems is what Mark grills.
  if (args.category && COMMIT_RE.test(args.category)) score += 15;
  else if (args.category && EXPECT_RE.test(args.category)) score += 8;
  // Renewals: Mark barely looks at these.
  if (args.isRenewal) score = Math.round(score * 0.35);
  return score;
}

export async function getPipelineChanges(
  tenantId: string,
  opts: { sinceIso: string; untilIso: string },
): Promise<PipelineChanges> {
  const db = supabaseAdmin();
  const sinceMs = Date.parse(opts.sinceIso);
  const untilMs = Date.parse(opts.untilIso);

  const [dealsRes, feRes, contactsRes, callsRes, snapsRes, framework] = await Promise.all([
    db.from("deals").select("id, account, external_id, rep_email, rolldog_opportunity_id").eq("tenant_id", tenantId),
    db.from("field_extractions").select("deal_id, framework_field_key, status, answer, last_updated_from_call_id").eq("tenant_id", tenantId),
    db.from("contacts").select("deal_id, name, role, relationship, last_contacted_at").eq("tenant_id", tenantId),
    db.from("calls").select("id, deal_id, outcome, scheduled_start, call_date, meeting_type, title, participants").eq("tenant_id", tenantId),
    db.from("deal_signal_snapshots").select("deal_id, snapshot_date, signals").eq("tenant_id", tenantId).gte("snapshot_date", opts.sinceIso.slice(0, 10)).order("snapshot_date", { ascending: true }),
    loadFramework(tenantId).catch(() => null as Framework | null),
  ]);
  // Human labels per field key from the framework (used to name what changed).
  // Captured/missing are derived from the gate keys directly (see below), not
  // from this map, so they still work when the framework fails to load.
  const fieldLabel = new Map<string, string>(); // field key -> human label from the framework
  if (framework) {
    for (const f of framework.fields) fieldLabel.set(f.fieldKey, f.label);
  }

  const feBy = group((feRes.data ?? []) as Array<Row & { deal_id: string }>);
  const contactsBy = group((contactsRes.data ?? []) as Array<Row & { deal_id: string }>);
  const callsBy = group((callsRes.data ?? []) as Array<Row & { deal_id: string }>);
  const snapsBy = group((snapsRes.data ?? []) as Array<Row & { deal_id: string }>);

  const deals = (dealsRes.data ?? []) as Array<{
    id: string;
    account: string;
    external_id: string | null;
    rep_email: string | null;
    rolldog_opportunity_id: string | null;
  }>;

  // Resolve each deal's Rolldog opportunity from the static pilot map OR the
  // stored column (statically-mapped pilot deals like Duty Free do not carry the
  // column but are very much in Rolldog).
  const oppByDeal = new Map<string, string>();
  for (const d of deals) {
    const opp = (d.external_id ? rolldogOppIdForDeal(d.external_id) : null) ?? d.rolldog_opportunity_id;
    if (opp) oppByDeal.set(d.id, String(opp));
  }

  // One Rolldog read per linked deal + one upcoming-call check per deal (both
  // best-effort, parallel).
  const summaries = new Map<string, RolldogSummary | null>();
  const hasUpcoming = new Map<string, boolean>();
  await Promise.all(
    deals.map(async (d) => {
      const opp = oppByDeal.get(d.id);
      if (opp) summaries.set(d.id, await getRolldogSummary(opp));
      try {
        hasUpcoming.set(d.id, !!(await getUpcomingCallForDeal(tenantId, d.id)));
      } catch {
        hasUpcoming.set(d.id, false);
      }
    }),
  );

  const records: DealChangeRecord[] = [];
  for (const d of deals) {
    const s = summaries.get(d.id) ?? null;
    const inRolldog = oppByDeal.has(d.id);

    // Non-opportunity meetings (existing customer / internal) are not pipeline.
    const types = (callsBy[d.id] ?? []).map((c) => c.meeting_type).filter((t): t is string => !!t);
    if (types.length > 0 && types.every((t) => t !== "new_opportunity")) continue;

    const account = prettyAccount({ externalId: d.external_id, account: d.account, rolldogAccountName: s?.accountName });
    const stageName = s?.stageName ?? null;
    const stageKey = stageKeyFromName(stageName);
    const rank = stageRank(stageKey);
    const monthly = s?.dealSize ?? null;
    const annual = monthly != null ? monthly * 12 : null;
    const daysInStage = daysSince(s?.currentStageDate ?? null);
    const daysToClose =
      s?.closeDate && Number.isFinite(Date.parse(s.closeDate))
        ? Math.round((Date.parse(s.closeDate) - Date.now()) / 86_400_000)
        : null;
    const isRenewal = RENEWAL_RE.test(`${s?.dealKind ?? ""} ${s?.opportunityType ?? ""}`);

    const gates = (feBy[d.id] ?? []).filter((x) => x.status === "Yes");
    const gatesConfirmed = gates.length;
    const gateKeys = new Set(gates.map((g) => String(g.framework_field_key)));
    // Actual captured answers, keyed by field, for the "Captured (specifics)".
    const answerByKey = new Map<string, string>();
    for (const g of gates) {
      const a = concise(g.answer as string | null, 150);
      if (a) answerByKey.set(String(g.framework_field_key), a);
    }

    const cts = (contactsBy[d.id] ?? []).filter((c) =>
      isMeaningfulContact(c as { relationship?: string | null; role?: string | null }),
    );
    const engaged = cts.filter((c) => c.last_contacted_at);

    // Economic buyer by name + role (or unknown), and whether they've engaged.
    const buyerContact = cts.find(
      (c) => String(c.relationship) === "economic_buyer" || BUYER_RE.test(String(c.role ?? "")) || BUYER_RE.test(String(c.relationship ?? "")),
    );
    const economicBuyer = buyerContact
      ? {
          name: cleanBuyerName(String(buyerContact.name ?? "").trim() || null),
          role: String(buyerContact.role ?? "").trim() || null,
          engaged: !!buyerContact.last_contacted_at,
        }
      : { name: null, role: null, engaged: false };
    // How we refer to the buyer: "Brian (Budget Owner)" or, when unnamed, "the CEO"
    // / "the economic buyer". Role is trimmed of location noise ("CEO, based in Miami").
    const buyerRoleShort = (economicBuyer.role ?? "").split(",")[0].split("(")[0].trim();
    const buyerLabel = economicBuyer.name
      ? `${economicBuyer.name}${buyerRoleShort ? ` (${buyerRoleShort})` : ""}`
      : buyerRoleShort
        ? `the ${buyerRoleShort}`
        : "the economic buyer";
    // The blocker line, WITH the reason it matters (they sign off), so Mark isn't
    // left asking why that person needs to be on a call.
    const buyerBlocker = `${buyerLabel.charAt(0).toUpperCase()}${buyerLabel.slice(1)}, who signs off on a purchase this size, has never been on a call.`;

    // Captured (the real answers) and Missing (the gaps), matched from the gate
    // keys directly so this holds up even when the framework fails to load. This
    // is the deal's full current qualification picture, not window-scoped.
    const captured: CapturedField[] = [];
    const missing: string[] = [];
    const answeredKeys = [...answerByKey.keys()];
    for (const kf of KEY_FIELDS) {
      const hitKey = answeredKeys.find((k) => kf.re.test(k));
      if (hitKey) {
        // For the economic buyer, prefer the person's name over the gate text.
        const value = kf.label === "Economic buyer" && economicBuyer.name ? economicBuyer.name : answerByKey.get(hitKey)!;
        captured.push({ label: kf.label, value });
      } else {
        missing.push(kf.label);
      }
    }
    const missingKey = missing.slice(0, 4);

    // A deal is worth surfacing only once it has real content (a captured gate,
    // an engaged contact, or a no-show). Empty deals are pending, not risks.
    const hasContent =
      gatesConfirmed > 0 ||
      engaged.length > 0 ||
      (callsBy[d.id] ?? []).some((c) => NO_SHOW_OUTCOMES.has(String(c.outcome ?? "")));

    // The last actual conversation date.
    const callMs = (callsBy[d.id] ?? [])
      .map((c) => Date.parse(String(c.scheduled_start ?? c.call_date ?? "")))
      .filter((t) => Number.isFinite(t) && t <= Date.now());
    const lastConversationAt = callMs.length ? new Date(Math.max(...callMs)).toISOString() : null;

    // Main customer contact on the calls: the champion, else the most-engaged
    // person. Used to name "the customer" in the agreed next step.
    const champion = cts.find((c) => String(c.relationship) === "champion");
    const primaryRaw =
      champion ??
      [...engaged].sort((a, b) => Date.parse(String(b.last_contacted_at ?? "")) - Date.parse(String(a.last_contacted_at ?? "")))[0] ??
      engaged[0] ??
      null;
    const primaryContact = primaryRaw
      ? {
          name: String(primaryRaw.name ?? "").trim(),
          role: String(primaryRaw.role ?? "").trim() || null,
          relationship: String(primaryRaw.relationship ?? "").trim() || null,
        }
      : null;

    // The next step agreed on the call (the next_step gate's captured answer),
    // with "the rep" and "the customer" swapped for real names so it reads naturally.
    const rep = repName(d.rep_email);
    const nextStepGate = gates.find((g) => /next_step/i.test(String(g.framework_field_key)));
    const agreedNextStep = personalizeCustomer(
      personalizeRep(nextStepGate ? concise(nextStepGate.answer as string | null, 190) || null : null, rep),
      primaryContact?.name ?? null,
    );
    // A specific meeting the rep should book (a named follow-up call, a demo, a
    // reconvene) vs the ball being in the customer's court (they respond/decide).
    const meetingAgreed = !!agreedNextStep && /(follow.?up|next)\s*(call|meeting)|\breconvene\b|call on |meeting on |demo\b/i.test(agreedNextStep);
    const nextStepIsCustomerWait =
      !meetingAgreed &&
      !!agreedNextStep &&
      /customer|they|board|partner|evaluat|respond|decid|get back|come back|weeks?|month/i.test(agreedNextStep);
    // If the step names a timeframe, when to check in (handles "2 weeks" and "two weeks").
    const WORD_NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    let followUpBy: string | null = null;
    if (agreedNextStep && lastConversationAt) {
      const base = Date.parse(lastConversationAt);
      const wk = /(\d+)\s*week/i.exec(agreedNextStep);
      const wkWord = /(one|two|three|four|five|six)\s*weeks?/i.exec(agreedNextStep);
      if (wk) followUpBy = new Date(base + Number(wk[1]) * 7 * 86_400_000).toISOString();
      else if (wkWord) followUpBy = new Date(base + WORD_NUM[wkWord[1].toLowerCase()] * 7 * 86_400_000).toISOString();
      else if (/next week/i.test(agreedNextStep)) followUpBy = new Date(base + 7 * 86_400_000).toISOString();
      else if (/month/i.test(agreedNextStep)) followUpBy = new Date(base + 30 * 86_400_000).toISOString();
    }
    const repOwedMeeting = meetingAgreed && !hasUpcoming.get(d.id);

    // No-show in the window, detected up front so it factors into the movement
    // verdict and the "what changed" story, not only the flags.
    const noShowCall = (callsBy[d.id] ?? []).find((c) => {
      if (!c.outcome || !NO_SHOW_OUTCOMES.has(String(c.outcome))) return false;
      const t = Date.parse(String(c.scheduled_start ?? c.call_date ?? ""));
      return Number.isFinite(t) && t >= sinceMs && t <= Date.now();
    });
    const isNoShow = !!noShowCall; // window-scoped, for the "what changed this week" story
    // Current-state no-show: the deal's LATEST meeting was a no-show, regardless of
    // window. The master read is a current picture, so a live no-show should surface
    // even if it happened before the selected window.
    const latestCall = (callsBy[d.id] ?? [])
      .map((c) => ({ t: Date.parse(String(c.scheduled_start ?? c.call_date ?? "")), row: c }))
      .filter((x) => Number.isFinite(x.t) && x.t <= Date.now())
      .sort((a, b) => b.t - a.t)[0]?.row;
    const currentNoShow = !!latestCall && NO_SHOW_OUTCOMES.has(String(latestCall.outcome ?? ""));
    const anyNoShow = isNoShow || currentNoShow;
    const noShowRow = noShowCall ?? (currentNoShow ? latestCall : null);
    const noShowTitle = noShowRow ? String(noShowRow.title ?? "").trim() || null : null;
    const noShowInvitees = noShowRow ? customerInviteeNames(noShowRow.participants) : [];

    // What the calls surfaced THIS WEEK, with specifics: qualification gates newly
    // answered (carrying the real captured answer, e.g. the budget figure or the
    // competitor name) and notable stakeholders first engaged in the window. This
    // is DealRipe's unique "what changed", read straight off the conversations.
    const callTimeById = new Map<string, number>();
    for (const c of callsBy[d.id] ?? []) {
      const t = Date.parse(String(c.scheduled_start ?? c.call_date ?? ""));
      if (c.id != null && Number.isFinite(t)) callTimeById.set(String(c.id), t);
    }
    const KEY_ORDER = new Map(KEY_FIELDS.map((k, i) => [k.label, i] as const));
    const answeredThisWeek: Array<{ label: string; value: string; order: number; competition: boolean }> = [];
    for (const g of gates) {
      const cid = g.last_updated_from_call_id ? String(g.last_updated_from_call_id) : "";
      const t = cid ? callTimeById.get(cid) : undefined;
      if (t == null || t < sinceMs || t > untilMs) continue;
      const key = String(g.framework_field_key);
      if (/next_step/i.test(key)) continue; // shown separately as the agreed next step
      const ans = concise(g.answer as string | null, 150);
      if (!ans) continue;
      // Prefer Mark's clean field name ("Competition", "Budget", "Decision
      // process") over the raw framework label ("competition notes").
      let label = fieldLabel.get(key) ?? key.replace(/_/g, " ");
      let order = 99;
      for (const kf of KEY_FIELDS) {
        if (kf.re.test(key)) {
          order = KEY_ORDER.get(kf.label) ?? 99;
          label = kf.label;
          break;
        }
      }
      label = (label.charAt(0).toUpperCase() + label.slice(1)).replace(/\bsql\s*(\d)/gi, "SQL$1");
      answeredThisWeek.push({ label, value: ans, order, competition: /compet/i.test(key) });
    }
    answeredThisWeek.sort((a, b) => a.order - b.order);
    const whatChanged: WeekChange[] = [];
    if (isNoShow) {
      const who = noShowInvitees.length ? ` (${noShowInvitees.join(", ")} did not join)` : "";
      whatChanged.push({ text: `The ${noShowTitle ? `"${noShowTitle}" ` : ""}meeting was a no-show${who}`, tone: "down" });
    }
    for (const a of answeredThisWeek.slice(0, 3)) whatChanged.push({ label: a.label, text: a.value, tone: a.competition ? "neutral" : "up" });
    for (const c of cts) {
      const t = Date.parse(String(c.last_contacted_at ?? ""));
      if (!Number.isFinite(t) || t < sinceMs || t > untilMs) continue;
      const notable = /champion|economic|decision|influenc|exec|buyer/i.test(String(c.relationship ?? "")) || BUYER_RE.test(String(c.role ?? ""));
      if (!notable) continue;
      const nm = String(c.name ?? "").trim();
      if (!nm || whatChanged.some((w) => w.text.includes(nm))) continue;
      whatChanged.push({ text: `Engaged ${nm}${c.role ? `, ${String(c.role)}` : ""}`, tone: "up" });
    }
    const whatChangedTop = whatChanged.slice(0, 4);

    // --- changes in window ---
    const changes: ChangeEvent[] = [];
    // New opportunity (Rolldog created-at in window). A brand-new opp's stage
    // entry IS its creation, so we don't also emit a redundant stage change.
    const isNew = inWindow(s?.createdAt, sinceMs, untilMs);
    if (isNew) {
      changes.push({ kind: "new", label: "New opportunity", from: null, to: stageName, at: s?.createdAt ?? null, source: "rolldog" });
    } else if (s?.currentStageDate && inWindow(s.currentStageDate, sinceMs, untilMs) && stageName) {
      // Rolldog stage entry: we know the current stage + when it entered it.
      changes.push({ kind: "stage", label: "Stage", from: null, to: stageName, at: s.currentStageDate, source: "rolldog" });
    }
    // Won / lost / removed.
    const isWon = WON_RE.test(s?.status ?? "");
    const isLost = LOST_RE.test(s?.status ?? "");
    if (isWon && inWindow(s?.closeDate, sinceMs, untilMs)) changes.push({ kind: "won", label: "Closed won", from: null, to: s?.statusReason ?? null, at: s?.closeDate ?? null, source: "rolldog" });
    if (isLost && inWindow(s?.closeDate, sinceMs, untilMs)) changes.push({ kind: "lost", label: "Closed lost", from: null, to: s?.statusReason ?? null, at: s?.closeDate ?? null, source: "rolldog" });
    // Real Rolldog week-over-week deltas from the daily snapshots.
    const snaps = (snapsBy[d.id] ?? []).map((r) => r.signals as unknown as DealSignals);
    changes.push(...snapshotChanges(snaps));
    // The one-line movement verdict, and whether the deal moved backward (a slip,
    // forecast cut, or pushed close), which is what earns a look on its own.
    const movement = computeMovement(changes, { daysInStage, stageName, progress: whatChangedTop, isNoShow, gainedCount: answeredThisWeek.length });
    const hasBackwardChange = movement.direction === "backward";

    // --- flags ---
    const flags: DealFlag[] = [];
    const now = Date.now();
    const category = s?.forecastCategory ?? null;

    // Rep-optimism divergence (the star): the rep has committed or advanced the
    // deal, but the calls show it is NOT actually there. This is Mark's "you're
    // committing this but it's still red, how?" We do NOT flag the reverse (calls
    // ahead of Rolldog): that is just data-entry lag, which DealRipe already
    // fixes by writing the subfields back. Fires on a confident forecast / late
    // stage with critical gaps, named specifically.
    const committed = category != null && (COMMIT_RE.test(category) || EXPECT_RE.test(category));
    const advanced = committed || (rank != null && rank >= 4);
    const buyerGap = !economicBuyer.engaged;
    const gaps: string[] = [];
    if (buyerGap) gaps.push(`${buyerLabel} has never been on a call`);
    if (missingKey.includes("Budget")) gaps.push("budget is unconfirmed");
    if (missingKey.includes("Timeline / close date")) gaps.push("the close date is not validated by the customer");
    if (missingKey.includes("Agreement / signature") && rank != null && rank >= 4) gaps.push("no agreement or signature yet");
    const optimismFired = advanced && gaps.length > 0;
    if (optimismFired) {
      const lead = committed ? `Rep forecasts this ${category}` : `Rep has this at ${stageName ?? "a late stage"}`;
      flags.push({
        kind: "commit_divergence",
        severity: "high",
        text: `${lead}${s?.closeDate ? ` closing ${dateShort(s.closeDate)}` : ""}, but ${gaps.join(", ")}. Not as close as the forecast says.`,
      });
    }

    // No-show, window or current-state (detected above; here it becomes a flag).
    if (anyNoShow) {
      const who = noShowInvitees.length ? ` (${noShowInvitees.join(", ")} did not join)` : "";
      flags.push({ kind: "no_show", severity: "high", text: `The ${noShowTitle ? `"${noShowTitle}" ` : "last "}meeting was a no-show${who}. Worth confirming this is still live.` });
    }

    // Economic buyer never engaged, when the optimism flag did not already say it.
    // Names the buyer + role, or says explicitly that they are still unidentified.
    if (buyerGap && !optimismFired && (economicBuyer.name || gatesConfirmed >= 4)) {
      flags.push({ kind: "dark_buyer", severity: "high", text: buyerBlocker });
    }

    // Single-threaded qualified deal.
    if (engaged.length === 1 && gatesConfirmed >= 5) {
      flags.push({ kind: "single_threaded", severity: "med", text: `Riding on one relationship (${String(engaged[0].name)}).` });
    }

    // Follow-through on the agreed next step.
    //   - Rep owed a meeting and none is booked  -> a real miss (med).
    //   - Ball is in the customer's court, but no follow-up is locked -> coaching
    //     (low): best reps put the next call on the calendar so it does not drift.
    if (hasContent && !hasUpcoming.get(d.id) && !isNoShow) {
      if (repOwedMeeting) {
        flags.push({
          kind: "no_next_meeting",
          severity: "med",
          text: "A follow-up call was agreed on the call, but it is not on the calendar. Book it.",
        });
      } else if (nextStepIsCustomerWait) {
        flags.push({
          kind: "no_next_meeting",
          severity: "low",
          text: `The customer will get back${followUpBy ? ` around ${dateShort(followUpBy)}` : " on their own timeline"}, but no follow-up call is on the calendar.`,
        });
      } else {
        flags.push({
          kind: "no_next_meeting",
          severity: "med",
          text: agreedNextStep ? "A next step was agreed on the call, but no follow-up is booked." : "No next step was set on the last call, and nothing is booked.",
        });
      }
    }

    // Tracked from calls but not yet in Rolldog (the reps-behind signal).
    if (hasContent && !inRolldog) {
      flags.push({ kind: "not_in_rolldog", severity: "med", text: "DealRipe is tracking this from calls, but the rep has not created it in Rolldog." });
    }

    // Stalled in stage.
    if (daysInStage != null && daysInStage > 45) {
      flags.push({ kind: "stalled", severity: daysInStage > 90 ? "med" : "low", text: `In ${stageName ?? "stage"} for ${daysInStage} days.` });
    }

    // budget_mismatch: dormant until a product price list exists (Mark to supply).

    // What's blocking THIS deal, specifically: the named dark buyer, the SCOTSMAN
    // gates still open, single-threading, stall. Built from the deal's own call
    // context so Mark sees the real gaps, not a single generic line.
    const blockers: string[] = [];
    if (anyNoShow) {
      const who = noShowInvitees.length ? ` (${noShowInvitees.join(", ")} did not join)` : "";
      blockers.push(`The ${noShowTitle ? `"${noShowTitle}" ` : "last "}meeting was a no-show${who}, so this may not be live.`);
    }
    if (buyerGap) blockers.push(buyerBlocker);
    const GAP_BLOCK: Record<string, string> = {
      "Why now": "The business driver (why now) is not established.",
      Budget: "Budget is not confirmed on any call.",
      Competition: "No competitor has been identified.",
      "Decision process": "The decision process is not mapped.",
      "Exec involvement": "No executive is engaged.",
      "Timeline / close date": "The close date is not validated by the customer.",
      "Agreement / signature": "No agreement or signature yet.",
    };
    for (const m of missingKey) {
      if (m === "Economic buyer") continue; // covered by the buyer line above
      // Agreement / exec gaps are premature on early-stage deals; only flag them late.
      if ((m === "Agreement / signature" || m === "Exec involvement") && !(rank != null && rank >= 3)) continue;
      const p = GAP_BLOCK[m];
      if (p) blockers.push(p);
    }
    if (engaged.length === 1 && gatesConfirmed >= 4) blockers.push(`Single-threaded on ${String(engaged[0].name)}, no other stakeholder engaged.`);
    if (daysInStage != null && daysInStage > 45) blockers.push(`Stalled ${daysInStage} days in ${stageKeyFromName(stageName) ?? "stage"}.`);
    // The follow-up call agreed on the call was never put on the calendar.
    if (repOwedMeeting) blockers.push("The follow-up call agreed on the last call is not on the calendar.");
    if (blockers.length === 0 && flags[0]) blockers.push(flags[0].text);
    // No captured call means no evidence to blame; don't invent a blocker.
    const blockersTop = hasContent ? blockers.slice(0, 4) : [];

    // --- rep change + verdict (the dashboard hero) ---
    // The rep's primary CRM change this window (forecast/stage/close/amount/new).
    const repChangeEvent =
      changes.find((c) => c.kind === "forecast" && c.from && c.to) ??
      changes.find((c) => c.kind === "stage" && c.from && c.to) ??
      changes.find((c) => c.kind === "close_date" && c.from && c.to) ??
      changes.find((c) => c.kind === "amount" && c.from && c.to) ??
      changes.find((c) => c.kind === "new") ??
      null;
    const repChange = repChangeEvent ? describeRepChange(repChangeEvent) : null;

    // The critical gaps that would undermine an advance, in Mark's terms.
    const critical: string[] = [];
    if (!economicBuyer.engaged) critical.push(`${buyerLabel}, who signs off, has never been on a call`);
    if (missingKey.includes("Budget")) critical.push("budget is unconfirmed");
    if (missingKey.includes("Timeline / close date")) critical.push("the close date is not validated by the customer");
    if (missingKey.includes("Agreement / signature")) critical.push("no agreement or signature yet");
    const upProgress = whatChangedTop.filter((w) => w.tone === "up");

    let verdict: Verdict;
    if (repChangeEvent) {
      const advancing = isAdvancingChange(repChangeEvent);
      const toLabel = repChange?.to ?? "the change";
      if (advancing && critical.length > 0) {
        verdict = { kind: "overstated", text: `${rep} moved this to ${toLabel}, but ${critical.slice(0, 2).join(", ")}. Not as close as that implies.` };
      } else if (advancing) {
        verdict = { kind: "confirmed", text: upProgress.length ? `${rep}'s move is backed by the calls: ${upProgress[0].text}.` : "The call evidence supports the move." };
      } else {
        // Rep de-risked it themselves (cut forecast / pushed close); the calls agree.
        verdict = { kind: "confirmed", text: `${rep} lowered this, and the calls agree.` };
      }
    } else if (flags.some((f) => f.severity === "high")) {
      verdict = { kind: "risk", text: blockersTop[0] ?? "A blocker the rep has not flagged." };
    } else if (upProgress.length) {
      verdict = { kind: "lags", text: `The calls show progress not yet in the forecast: ${upProgress[0].text}.` };
    } else {
      verdict = { kind: "none", text: blockersTop[0] ?? "" };
    }

    // DealRipe's own forecast category: one conservative notch off the rep's, based
    // on the evidence. Down when a critical gap undermines a confident forecast, up
    // when the rep is behind strong evidence, otherwise it agrees with the rep.
    const repOrder = FCAST_ORDER(category);
    let drOrder = repOrder;
    if (repOrder != null) {
      if (critical.length > 0 && repOrder >= 2) drOrder = repOrder - 1;
      else if (repOrder <= 1 && gatesConfirmed >= 4 && (economicBuyer.engaged || upProgress.length >= 2)) drOrder = repOrder + 1;
    }
    // With no captured call, DealRipe has no basis to disagree with the rep, so
    // it mirrors the rep's category rather than notching it on absent evidence.
    const dealRipeCategory = !hasContent ? category : drOrder != null ? categoryFromOrder(drOrder) : category;

    // Plain health status Mark reads at a glance: at risk (DealRipe below the rep,
    // or a high-severity blocker), stalled (sitting too long or no next step), or
    // healthy (aligned and progressing).
    const drBelowRep = repOrder != null && drOrder != null && drOrder < repOrder;
    const highBlocker = flags.some((f) => f.severity === "high");
    let dealHealth: DealChangeRecord["dealHealth"];
    if (!hasContent) dealHealth = "no_data";
    else if (drBelowRep || highBlocker || verdict.kind === "overstated" || verdict.kind === "risk") dealHealth = "at_risk";
    else if ((daysInStage != null && daysInStage > 45) || (!hasUpcoming.get(d.id) && !nextStepIsCustomerWait && !agreedNextStep)) dealHealth = "stalled";
    else dealHealth = "healthy";

    // With no captured call, DealRipe has nothing to say; be honest, not generic.
    if (!hasContent) verdict = { kind: "none", text: "No tracked calls yet." };

    const attention = scoreAttention({ flags, annual, daysToClose, category, isRenewal, hasBackwardChange });
    // "To look at" is a real problem Mark should inspect: a high-severity risk or
    // a deal moving backward. Medium/low flags (no meeting booked, not in Rolldog)
    // are shown as context on the card but don't inflate the list on their own.
    const needsAttention = hasContent && (flags.some((f) => f.severity === "high") || hasBackwardChange);

    records.push({
      dealId: d.id,
      account,
      repEmail: d.rep_email,
      repName: repName(d.rep_email),
      rolldogOppId: oppByDeal.get(d.id) ?? null,
      stageName,
      stageKey,
      forecastCategory: category,
      dealSizeMonthly: monthly,
      dealSizeAnnual: annual,
      closeDate: s?.closeDate ?? null,
      score: s?.score ?? null,
      status: s?.status ?? null,
      archived: s?.archived ?? false,
      isRenewal,
      createdAt: s?.createdAt ?? null,
      currentStageDate: s?.currentStageDate ?? null,
      daysInStage,
      daysToClose,
      gatesConfirmed,
      inRolldog,
      captured,
      missing: missingKey,
      economicBuyer,
      primaryContact,
      nextMeetingBooked: !!hasUpcoming.get(d.id),
      lastConversationAt,
      agreedNextStep,
      nextStepIsCustomerWait,
      nextStepIsMeeting: meetingAgreed,
      repOwedMeeting,
      followUpBy,
      noShowTitle,
      noShowInvitees,
      doThis: null,
      movement,
      whatChanged: whatChangedTop,
      blockers: blockersTop,
      repChange,
      verdict,
      dealRipeCategory,
      dealHealth,
      lastUpdatedAt: s?.updatedAt ?? null,
      changes,
      flags,
      attention,
      needsAttention,
      isNoShow: anyNoShow,
    });
  }

  records.sort((a, b) => b.attention - a.attention);

  // --- headline aggregate ---
  // Open pipeline excludes won/lost/archived AND Omitted (Mark's definition:
  // Omitted deals are deliberately not in the forecast yet).
  const OMIT_RE = /omit/i;
  const open = records.filter(
    (r) =>
      !r.archived &&
      !WON_RE.test(r.status ?? "") &&
      !LOST_RE.test(r.status ?? "") &&
      !(r.forecastCategory && OMIT_RE.test(r.forecastCategory)),
  );
  const totalPipelineAnnual = open.reduce((n, r) => n + (r.dealSizeAnnual ?? 0), 0);
  const mixMap = new Map<string, ForecastBucket>();
  for (const r of open) {
    const cat = r.forecastCategory ?? "Uncategorized";
    const b = mixMap.get(cat) ?? { category: cat, deals: 0, annual: 0 };
    b.deals += 1;
    b.annual += r.dealSizeAnnual ?? 0;
    mixMap.set(cat, b);
  }
  const headline: Headline = {
    totalPipelineAnnual,
    forecastMix: Array.from(mixMap.values()).sort((a, b) => b.annual - a.annual),
    closedWon: records.filter((r) => r.changes.some((c) => c.kind === "won")).length,
    closedLost: records.filter((r) => r.changes.some((c) => c.kind === "lost")).length,
    dealsChanged: records.filter((r) => r.changes.length > 0).length,
    dealsNeedingAttention: records.filter((r) => r.needsAttention).length,
    newOpportunities: records.filter((r) => r.changes.some((c) => c.kind === "new")).length,
  };

  return { headline, deals: records, window: { sinceIso: opts.sinceIso, untilIso: opts.untilIso } };
}
