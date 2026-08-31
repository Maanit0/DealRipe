/**
 * The Monday activity report, rendered.
 *
 * SEPARATED FROM THE SCRIPT ON PURPOSE. The cron sends this to Mark and the
 * preview script shows it to us, and if those two rendered separately they
 * would drift, which is how a customer ends up seeing something nobody
 * reviewed. One renderer, two callers, byte identical.
 */

import { buildDealEvidence, refreshDealRead } from "./deal-read";
import { subjectTopic } from "./email-log";
import {
  ACTIVITY_WINDOW_DAYS,
  SILENCE_CAVEAT,
  readActivity,
  type ActivityRead,
} from "./deal-activity";
import { getPipelineChanges, type DealChangeRecord } from "./pipeline-changes";
import { supabaseAdmin } from "./supabase";

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const money = (n: number | null | undefined) =>
  typeof n === "number" && n > 0 ? `$${Math.round(n).toLocaleString("en-US")}` : "";

/**
 * A bare "2026-09-21" parses as UTC midnight and then renders as Sep 20 in
 * Pacific, so a close date printed one way in one column and another way in the
 * next. Date-only strings are calendar days, not instants.
 */
const dayLabel = (iso: string): string => {
  const [y, m, dd] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, dd ?? 1).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const days = (iso: string | null, now: number): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null;
};

/**
 * Last inbound customer email per deal, in ONE query.
 *
 * readEmailEngagement is per deal and would be 124 round trips for a weekly
 * report. Same table, same filter (calendar acceptances excluded, since an
 * Outlook "Accepted:" is a click rather than a person writing to you), read
 * once.
 */
async function lastCustomerEmailByDeal(
  tenantId: string,
  dealIds: string[],
): Promise<{ byDeal: Map<string, string>; dealsWithAnyMail: Set<string> }> {
  const db = supabaseAdmin();
  const byDeal = new Map<string, string>();
  const dealsWithAnyMail = new Set<string>();
  const CHUNK = 60;
  for (let i = 0; i < dealIds.length; i += CHUNK) {
    const slice = dealIds.slice(i, i + CHUNK);
    const res = await db
      .from("deal_messages")
      .select("deal_id, customer_side, sent_at")
      .eq("tenant_id", tenantId)
      .eq("is_calendar_response", false)
      .in("deal_id", slice)
      .order("sent_at", { ascending: false });
    if (res.error) throw new Error(`deal_messages read failed: ${res.error.message}`);
    for (const r of (res.data ?? []) as Array<{ deal_id: string; customer_side: boolean; sent_at: string | null }>) {
      dealsWithAnyMail.add(r.deal_id);
      if (!r.customer_side || !r.sent_at) continue;
      const prev = byDeal.get(r.deal_id);
      if (!prev || Date.parse(r.sent_at) > Date.parse(prev)) byDeal.set(r.deal_id, r.sent_at);
    }
  }
  return { byDeal, dealsWithAnyMail };
}

type NextMeeting = { at: string; title: string | null; who: string[] };

/**
 * When the agreed next step was actually agreed.
 *
 * "Stephanie agreed to a demo scheduled for Friday at 2pm Eastern" is unusable
 * without it: Friday of which week? The commitment is the next_step field
 * extraction's answer, so that row's capture date is the date it was said, and
 * it is read rather than inferred from the last conversation, which would be
 * wrong on every deal that has had a call since.
 */
async function nextStepAgreedAt(tenantId: string, dealIds: string[]): Promise<Map<string, string>> {
  const db = supabaseAdmin();
  const out = new Map<string, string>();
  const CHUNK = 60;
  for (let i = 0; i < dealIds.length; i += CHUNK) {
    const res = await db
      .from("field_extractions")
      .select("deal_id, framework_field_key, updated_at")
      .eq("tenant_id", tenantId)
      .in("deal_id", dealIds.slice(i, i + CHUNK))
      .like("framework_field_key", "%next_step%");
    if (res.error) throw new Error(`field_extractions read failed: ${res.error.message}`);
    for (const r of (res.data ?? []) as Array<{ deal_id: string; updated_at: string | null }>) {
      if (!r.updated_at) continue;
      const prev = out.get(r.deal_id);
      if (!prev || Date.parse(r.updated_at) > Date.parse(prev)) out.set(r.deal_id, r.updated_at);
    }
  }
  return out;
}
type LastContact = { at: string; kind: "call" | "email"; what: string };
type Row = {
  deal: DealChangeRecord;
  activity: ActivityRead;
  next?: NextMeeting;
  agreedAt?: string;
  read?: string;
  changed?: string[];
  lastLearned?: { key: string; at: string } | null;
  headline?: string | null;
  lastContact?: LastContact;
  /** Outbound emails since they last said anything. The chase count. */
  chases?: number;
  lastChaseAbout?: string | null;
  /** A captured call or a real inbound email has happened at least once. */
  engaged?: boolean;
};

/**
 * The last time the customer actually did something, and how many times we have
 * written since.
 *
 * A quiet deal needs different columns from a live one. "CRM this week: no
 * change. DealRipe learned: nothing new. Next: nothing booked." is three empty
 * cells telling a leader nothing. What he needs is when it went dark, what the
 * last real interaction was, and how hard the rep has chased since.
 */
async function contactHistory(
  tenantId: string,
  dealIds: string[],
): Promise<Map<string, { lastInbound: { at: string; subject: string | null } | null; chases: number; lastChaseAbout: string | null }>> {
  const db = supabaseAdmin();
  const out = new Map<string, { lastInbound: { at: string; subject: string | null } | null; chases: number; lastChaseAbout: string | null }>();
  const CHUNK = 60;
  for (let i = 0; i < dealIds.length; i += CHUNK) {
    const res = await db
      .from("deal_messages")
      .select("deal_id, customer_side, subject, sent_at")
      .eq("tenant_id", tenantId)
      .eq("is_calendar_response", false)
      .in("deal_id", dealIds.slice(i, i + CHUNK))
      .order("sent_at", { ascending: false });
    if (res.error) throw new Error(`deal_messages read failed: ${res.error.message}`);
    const byDeal = new Map<string, Array<{ customer_side: boolean; subject: string | null; sent_at: string | null }>>();
    for (const m of (res.data ?? []) as Array<{ deal_id: string; customer_side: boolean; subject: string | null; sent_at: string | null }>) {
      const list = byDeal.get(m.deal_id) ?? [];
      list.push(m);
      byDeal.set(m.deal_id, list);
    }
    for (const [dealId, msgs] of byDeal) {
      const lastIn = msgs.find((m) => m.customer_side && m.sent_at) ?? null;
      // Newest first, so everything before the last inbound is a chase.
      const chases = lastIn
        ? msgs.filter((m) => !m.customer_side && m.sent_at && Date.parse(m.sent_at) > Date.parse(lastIn.sent_at!)).length
        : msgs.filter((m) => !m.customer_side).length;
      // The MOST RECENT chase only. A merged list of subjects is the noise that
      // got email pulled out of the learned column; one subject is a fact.
      const lastOut = msgs.find(
        (m) => !m.customer_side && m.sent_at && (!lastIn?.sent_at || Date.parse(m.sent_at) > Date.parse(lastIn.sent_at)),
      );
      out.set(dealId, {
        lastInbound: lastIn && lastIn.sent_at ? { at: lastIn.sent_at, subject: lastIn.subject } : null,
        chases,
        lastChaseAbout: lastOut ? subjectTopic(lastOut.subject) : null,
      });
    }
  }
  return out;
}

/**
 * The next scheduled meeting per deal, with who is on it.
 *
 * "A meeting is on the calendar" is a fact a leader cannot act on. When, and
 * with whom, is the difference between a row he reads and a row he asks about.
 */
/** Deals with at least one CAPTURED call. A calendar event is not engagement. */
async function capturedCallDeals(tenantId: string, dealIds: string[]): Promise<Set<string>> {
  const db = supabaseAdmin();
  const out = new Set<string>();
  const CHUNK = 60;
  for (let i = 0; i < dealIds.length; i += CHUNK) {
    const res = await db
      .from("calls")
      .select("deal_id")
      .eq("tenant_id", tenantId)
      .eq("outcome", "captured")
      .in("deal_id", dealIds.slice(i, i + CHUNK));
    if (res.error) throw new Error(`calls read failed: ${res.error.message}`);
    for (const c of (res.data ?? []) as Array<{ deal_id: string }>) out.add(c.deal_id);
  }
  return out;
}

async function nextMeetingByDeal(tenantId: string, dealIds: string[]): Promise<Map<string, NextMeeting>> {
  const db = supabaseAdmin();
  const out = new Map<string, NextMeeting>();
  const CHUNK = 60;
  for (let i = 0; i < dealIds.length; i += CHUNK) {
    const res = await db
      .from("calls")
      .select("deal_id, scheduled_start, title, participants")
      .eq("tenant_id", tenantId)
      .in("deal_id", dealIds.slice(i, i + CHUNK))
      .gte("scheduled_start", new Date().toISOString())
      .order("scheduled_start", { ascending: true });
    if (res.error) throw new Error(`calls read failed: ${res.error.message}`);
    for (const c of (res.data ?? []) as Array<{ deal_id: string; scheduled_start: string; title: string | null; participants: unknown }>) {
      if (out.has(c.deal_id)) continue; // ordered ascending, so the first is the next
      const ps = Array.isArray(c.participants) ? (c.participants as Array<{ name?: string | null; email?: string | null }>) : [];
      const who = ps
        .filter((p) => !(p?.email ?? "").toLowerCase().endsWith("@magaya.com"))
        .map((p) => (p?.name ?? p?.email ?? "").split("@")[0])
        .filter(Boolean)
        .slice(0, 3);
      out.set(c.deal_id, { at: c.scheduled_start, title: c.title, who });
    }
  }
  return out;
}

/** "Thu Aug 27, 1:30pm with Liam", rather than "a meeting is on the calendar". */
/**
 * A meeting title a person would say, not the calendar record.
 *
 * "Confirmed - FTZ Febest Parts | Magaya ABI Demo" becomes "ABI demo". The raw
 * string carries the vendor name, the customer name, a confirmation prefix and
 * a pipe, none of which a leader needs in a table cell, and printing it whole
 * is what pushed the booked pill into the next column.
 */
/**
 * A calendar subject reduced to a short PURPOSE, two to four words.
 *
 * The Next step cell is roughly a tenth of the page and was being handed raw
 * invite titles, which wrapped into four and five narrow lines: "COMPLIANCE
 * DEMO", "Call ECS Australia Melbour", "Grupo Logistico de Carga U". A rep name,
 * a company name and a date are all already on the row; repeating them inside a
 * narrow badge is what made the column look broken.
 *
 * Keyword first, because the KIND of meeting is the only part worth the space.
 * Everything else is stripped, and anything that survives without a recognised
 * kind is cut to three words rather than shown raw.
 */
const PURPOSE: Array<[RegExp, string]> = [
  [/\b(pricing|price|cost|budget|quote)\b/i, "Pricing review"],
  [/\b(proposal|sow|contract|terms)\b/i, "Proposal review"],
  [/\brate management\b/i, "Rate Management demo"],
  [/\b(abi)\b/i, "ABI demo"],
  [/\b(wms)\b.*\b(discovery|call)\b|\bdiscovery\b.*\bwms\b/i, "WMS discovery"],
  [/\bcompliance\b/i, "Compliance demo"],
  [/\b(kickoff|kick.?off)\b/i, "Kickoff"],
  [/\bonboarding\b/i, "Onboarding"],
  [/\b(discovery|intro|introduction)\b/i, "Discovery call"],
  [/\b(demo|demonstration|walkthrough)\b/i, "Demo"],
  [/\b(training)\b/i, "Training"],
  [/\b(technical|integration|api)\b/i, "Technical session"],
  [/\b(follow.?up|check.?in|touch.?base|catch.?up)\b/i, "Follow-up"],
  [/\b(review)\b/i, "Review"],
];

function shortMeeting(title: string | null): string {
  let t = (title ?? "").trim();
  if (!t) return "";
  t = t.split("|")[0];
  t = t.replace(/^\s*(confirmed|updated|invitation|reminder|tentative)\s*[-:,]?\s*/i, "");
  t = t.replace(/\bmagaya\b/gi, "");
  t = t.replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, "");
  t = t.replace(/\b\d{1,2}(:\d{2})?\s*(am|pm)\b/gi, "");
  t = t.replace(/\b(mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)(day)?\b/gi, "");
  t = t.replace(/[<>/]+/g, " ").replace(/[-\u2013\u2014]+/g, " ").replace(/\s{2,}/g, " ").trim();
  t = t.replace(/^[,.\s]+|[,.\s]+$/g, "");

  for (const [re, label] of PURPOSE) if (re.test(t)) return label;

  // No recognised kind. Three words at most, sentence case, so a company name
  // cannot occupy four lines of a narrow badge.
  const words = t.split(/\s+/).filter(Boolean).slice(0, 3);
  if (words.length === 0) return "";
  const short = words.join(" ");
  return short.charAt(0).toUpperCase() + short.slice(1).toLowerCase();
}

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

const STATUS = {
  never:   { label: "Never engaged",     tone: "neu"  },
  moving:  { label: "Moving",            tone: "ok"   },
  active:  { label: "Active, not moving", tone: "warn" },
  stalled: { label: "Stalled",           tone: "amber" },
  silent:  { label: "Gone silent",       tone: "bad"  },
} as const;
type StatusKey = keyof typeof STATUS;

/**
 * FOUR STATUSES, MUTUALLY EXCLUSIVE, EVIDENCE FIRST.
 *
 * Order matters. Silence beats everything because it is the strongest fact.
 * Then a broken commitment, because a no-show or an overdue agreed step is a
 * deal that WAS engaged and stopped, which is a different management problem
 * from one that is merely quiet. Only then does activity get to count, and only
 * progression earns Moving.
 *
 * A calendar event on its own never makes a deal Moving. Febestparts sat in
 * Moving with two missed demos behind it because a future invite existed.
 */
/**
 * Whether a line in changedThisWeek is the customer moving, or us failing to see.
 *
 * A PAST meeting nobody could verify proves nothing either way and must never
 * create movement. A no-show is evidence the customer did NOT engage. Both were
 * counting as progress, which is how a deal with two missed demos behind it and
 * zero replies came out labelled Moving on a page a CRO reads.
 */
const NOT_PROGRESS =
  /(could not be verified|couldn.t be verified|not be verified|unverified|no.?show|did not join|didn.t join|nobody joined|no one joined|was attempted|attempted|no confirmed|no verified|outcome (is )?unknown|no reply|no response|zero replies|could not get into)/i;

function isProgression(change: string): boolean {
  const t = String(change ?? "").trim();
  if (!t) return false;
  return !NOT_PROGRESS.test(t);
}

function statusOf(r: Row): StatusKey {
  // NEVER ENGAGED COMES FIRST. A deal cannot go silent if the customer was never
  // there: "gone silent" and "has never come back to us" both imply an earlier
  // interaction that never happened. Engagement means a CAPTURED call or a real
  // inbound email. A calendar event is not engagement, and a meeting DealRipe
  // could not get into proves nothing either way.
  if (!r.engaged) return "never";
  if (r.activity.verdict === "silent") return "silent";
  const noShow = r.deal.flags.some((f) => f.kind === "no_show");
  const overdue = commitmentState(r) === "overdue";
  if (noShow || overdue) return "stalled";
  // A CHANGE IS NOT AUTOMATICALLY PROGRESS. changedThisWeek carries anything that
  // moved on the row, and most of what moved on these rows is DealRipe failing to
  // get into a meeting. Aquagulf, DHL, Forwardair, Crowley and Theskyplanner all
  // sat in Moving on the strength of "the meeting could not be verified", which
  // is a statement about our bot and not about the customer.
  const progressed = (r.changed ?? []).some(isProgression) || r.deal.nextMeetingBooked;
  return progressed ? "moving" : "active";
}

export type NextStepState = "booked" | "agreed" | "overdue" | "waiting_customer" | "waiting_rep" | "none";

function commitmentState(r: Row): NextStepState {
  if (r.deal.nextMeetingBooked) return "booked";
  const owed = r.deal.repOwedMeeting && r.deal.agreedNextStep ? r.deal.agreedNextStep : null;
  if (owed) {
    const aged = r.agreedAt ? Math.floor((Date.now() - Date.parse(r.agreedAt)) / 86_400_000) : null;
    return aged !== null && aged > 7 ? "overdue" : "agreed";
  }
  if (r.deal.nextStepIsCustomerWait) return "waiting_customer";
  return "none";
}

/** "Demo booked, Aug 31" / "Agreed, not booked" / "Overdue 13d" / "None". */
function nextStep(r: Row): { label: string; tone: "ok" | "warn" | "amber" | "bad"; detail: string | null } {
  const st = commitmentState(r);
  switch (st) {
    case "booked": {
      const what = r.next ? shortMeeting(r.next.title) : "";
      return {
        label: r.next ? `Booked, ${shortDate(r.next.at)}` : "Booked",
        tone: "ok",
        detail: what || null,
      };
    }
    case "agreed":
      return { label: "Agreed", tone: "warn", detail: "Not booked" };
    case "overdue": {
      const aged = r.agreedAt ? Math.floor((Date.now() - Date.parse(r.agreedAt)) / 86_400_000) : null;
      return { label: `Overdue${aged ? `, ${aged}d` : ""}`, tone: "bad", detail: "Agreed, never booked" };
    }
    case "waiting_customer":
      return { label: "Waiting", tone: "amber", detail: "On the customer" };
    default:
      return { label: "None", tone: "bad", detail: null };
  }
}

const sev = (x: string): number => (x === "high" ? 3 : x === "med" ? 2 : 1);

/**
 * What a sales manager would actually say, not what a system would.
 * "Ask who signs", never "validate the presence of an economic buyer".
 */
const ACTION_BY_FLAG: Record<string, string> = {
  commit_divergence: "Challenge the forecast",
  stage_divergence: "Move the stage back",
  dark_buyer: "Ask who signs",
  no_show: "Ask why they no-showed",
  single_threaded: "Get a second person in",
  stalled: "Push out the close date",
  competitor_unknown: "Ask who else they are looking at",
  signature_pending: "Chase the signature",
  no_next_meeting: "Get the next meeting booked",
  budget_mismatch: "Re-confirm budget",
  not_in_rolldog: "Get it into Rolldog",
};

/**
 * An EXTERNAL blocker: something neither the rep nor the leader can unstick by
 * booking a meeting.
 *
 * Integrity Customs was told to "get the next meeting booked" on a row whose own
 * evidence said the customer had agreed to sign as soon as CBP paperwork
 * cleared. A meeting does not clear CBP. The action a leader can actually take
 * on those deals is to watch the blocker and stop spending forecast-call time on
 * them, and saying so is more useful than a task nobody should do.
 */
const BLOCKER: Array<[RegExp, string]> = [
  [/\bcbp\b|customs and border/i, "Monitor CBP clearance"],
  [/\bfmc\b/i, "Monitor FMC licence"],
  [/\biata\b/i, "Monitor IATA accreditation"],
  [/\bftz\b|foreign.?trade zone/i, "Monitor FTZ permit"],
  [/\bfiler code\b/i, "Monitor filer code approval"],
  [/\blegal review\b|in.?house legal|outside counsel/i, "Track legal review"],
  [/\bboard\b/i, "Track board approval"],
  [/\bpermit\b|licen[cs]e/i, "Monitor licence or permit"],
];

/** A customer who has committed needs papering, not another meeting. */
const COMMITTED =
  /\b(agreed to sign|verbally committed|signed the (quote|proposal|contract)|accepted (the )?pricing|quote signed|ready to sign|docusign|adobesign)\b/i;

function actionOf(r: Row, status: StatusKey): { text: string; hard: boolean } | null {
  const top = [...r.deal.flags].sort((a, b) => sev(b.severity) - sev(a.severity))[0];
  const ns = commitmentState(r);
  const evidence = `${r.headline ?? ""} ${r.read ?? ""}`;

  // THE ACTION MUST NOT ARGUE WITH THE ROW.
  //
  // "Ask why it was never booked" printed next to "Booked, Aug 31" is the kind
  // of contradiction that ends a leader's trust in the whole page. The next step
  // is checked first, so a booked meeting can never produce a chase-the-booking
  // action, and an external blocker gets a wait rather than a meeting request.
  if (ns === "booked") {
    return status === "stalled" ? { text: "Make sure this one holds", hard: false } : null;
  }
  if (ns === "waiting_customer") return { text: "Waiting on customer", hard: false };
  if (status === "never") return { text: "Confirm this is real", hard: false };
  if (status === "silent") return { text: "Confirm it is still live", hard: true };

  // A COMMITMENT OUTRANKS A MISSING MEETING. Teamfast accepted $520 a month and
  // agreed to sign by DocuSign, and was told to book a meeting. What that deal
  // needs is the paperwork out.
  if (COMMITTED.test(evidence)) return { text: "Get the agreement signed", hard: false };

  // An external blocker outranks everything below it: no meeting moves it.
  for (const [re, label] of BLOCKER) if (re.test(evidence)) return { text: label, hard: false };

  if (ns === "overdue") return { text: "Ask why it was never booked", hard: true };
  if (status === "moving") {
    return ns === "none" ? { text: "Get the next meeting booked", hard: false } : null;
  }
  if (top && ACTION_BY_FLAG[top.kind] && top.severity !== "low") {
    return { text: ACTION_BY_FLAG[top.kind], hard: top.severity === "high" };
  }
  if (ns === "none") return { text: "Get the next meeting booked", hard: false };
  return null;
}

/**
 * Sentences that do not survive a missing variable.
 *
 * "A named competitor is in play twelve days before no close date exists" is a
 * template that assumed a close date and rendered the absence into the middle of
 * the clause. A leader reading one sentence like that discounts every other
 * sentence on the page, so a line that trips this is dropped rather than shipped:
 * no read at all is recoverable, a nonsensical one is not.
 */
const MALFORMED = [
  /\bbefore no\b/i,
  /\bbefore (an? )?(unknown|undefined|null)\b/i,
  /\b(undefined|null|NaN)\b/,
  /\bdays before no\b/i,
  /\b(\w+) \1\b/i,
  /\bin \s*days\b/i,
  /\bon\s+\.\s*$/i,
  /\[object Object\]/,
];

/**
 * Remove facts from the stored read that the ROW already states, live.
 *
 * deal_reads is written when the evidence changes and read back for weeks. The
 * row's numbers are computed at render time. So the two drift, and they drift in
 * the most visible way possible: Bee Imagine printed "Commit . SQL5 . Sep 3" in
 * its metadata and "no reply in 13 days with close Aug 3" in its read, and IFF
 * US showed a 17d silent pill beside a read saying no reply in 13 days.
 *
 * A leader who catches one of those stops trusting the numbers on the whole
 * page, and they are right to: they cannot tell which of the two is current.
 *
 * The row wins, always, because it is computed now. The clause is DELETED rather
 * than rewritten, since the row already carries the fact a few centimetres to
 * the left and repeating it was never worth a line.
 */
function dropRestatedFacts(read: string | null | undefined, r: Row): string | null {
  let t = String(read ?? "").trim();
  if (!t) return null;

  // "with close Aug 3", "with close date Oct 22", "close date is 17 months out"
  // are all the row's own close-date column, restated and able to go stale.
  t = t.replace(/,?\s*(and\s+)?with\s+(a\s+)?close(\s+date)?\s+(of\s+)?[A-Z][a-z]{2}\.?\s*\d{1,2}(,?\s*\d{4})?/g, "");
  t = t.replace(/,?\s*(and\s+)?with\s+(a\s+)?close(\s+date)?\s+\d{1,2}\s+days?\s+out/gi, "");

  // A silence count in prose next to a silence pill that computes its own.
  if (r.activity.quietDays !== null) {
    t = t.replace(/,?\s*(and\s+)?no\s+repl(y|ies)\s+in\s+\d+\s+days?/gi, ", no reply since");
  }

  // A TRAILING ELLIPSIS FROM A READ WRITTEN BEFORE THE CLIP WAS FIXED.
  //
  // deal_reads holds rows generated weeks ago, and those keep whatever the
  // generator did at the time: "deal pace is slow for a...", "Brad and Maya
  // sign-off, and...". Regenerating the whole table to clear cosmetics would
  // cost 126 model calls and change paragraphs a leader has already read, so the
  // tail is repaired here instead: cut back to the last complete clause and end
  // it. Nothing is invented, a hanging fragment is removed.
  if (/\.\.\.\s*$/.test(t)) {
    const body = t.replace(/\s*\.\.\.\s*$/, "");
    const stop = Math.max(body.lastIndexOf(","), body.lastIndexOf(";"));
    t = (stop > body.length * 0.45 ? body.slice(0, stop) : body).replace(/[,;:\s]+$/, "");
  }

  return t
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/[,;\s]+$/, "")
    .replace(/,\s*\./g, ".")
    .trim()
    .replace(/([^.!?])$/, "$1.")
    || null;
}

/** Drop a generated line that reads as broken. Returns null when unusable. */
function sane(text: string | null | undefined): string | null {
  const t = String(text ?? "").trim();
  if (!t) return null;
  if (MALFORMED.some((re) => re.test(t))) return null;
  return t;
}

const pill = (label: string, tone: "ok" | "warn" | "amber" | "bad" | "neu") =>
  `<span class="pill ${tone}"><i></i>${esc(label)}</span>`;

function money1(n: number | null | undefined): string {
  if (typeof n !== "number" || n <= 0) return "";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K`;
  return `$${Math.round(n)}`;
}

/** Rep, amount, forecast, stage, close. Under the name, never as columns. */
function dealMeta(r: Row): string {
  const d = r.deal;
  const bits = [
    d.repName || null,
    money1(d.dealSizeAnnual) || null,
    d.forecastCategory || null,
    d.stageKey ?? (d.inRolldog ? null : "No opp"),
    d.closeDate ? dayLabel(d.closeDate) : null,
  ].filter(Boolean) as string[];
  return bits.map(esc).join(" &middot; ");
}

function rowHtml(r: Row, now: number, variant: "live" | "quiet" = "live"): string {
  const status = statusOf(r);
  const ns = nextStep(r);
  const action = actionOf(r, status);
  const silentDays = r.activity.quietDays;
  const changed = sane(r.headline);

  return `<tr class="main">
    <td class="acct"><b>${esc(r.deal.account)}</b><i>${dealMeta(r)}</i></td>
    <td class="st">${pill(STATUS[status].label, STATUS[status].tone)}${
      variant === "quiet"
        ? `<i class="sub">${silentDays !== null ? `${silentDays}d silent` : "no contact on record"} &middot; ${
            r.chases ?? 0
          } follow-up${(r.chases ?? 0) === 1 ? "" : "s"} &middot; 0 replies</i>`
        : ""
    }</td>
    <td class="chg">${changed ? esc(changed) : `<span class="none">No change</span>`}</td>
    <td class="ns">${pill(ns.label, ns.tone)}${ns.detail ? `<i class="sub">${esc(ns.detail)}</i>` : ""}</td>
    <td class="read">${
      sane(dropRestatedFacts(r.read, r)) ? esc(sane(dropRestatedFacts(r.read, r)) as string) : `<i class="sub">Nothing captured on this deal yet.</i>`
    }</td>
    <td class="act">${action ? `<b class="${action.hard ? "hard" : ""}">${esc(action.text)}</b>` : `<i class="sub">No action</i>`}</td>
  </tr>`;
}

function section(
  title: string,
  sub: string,
  rows: Row[],
  now: number,
  tone: "red" | "green" | "grey" | "amber",
  variant: "live" | "quiet" = "live",
): string {
  const total = rows.reduce((n, r) => n + (r.deal.dealSizeAnnual ?? 0), 0);
  return `<section class="sec ${tone}">
    <div class="sechd"><h2>${esc(title)}</h2><div class="count">${rows.length} deal${
      rows.length === 1 ? "" : "s"
    }${total > 0 ? ` &middot; ${money1(total)}` : ""}</div></div>
    <p class="secsub">${esc(sub)}</p>
    ${
      rows.length === 0
        ? `<p class="empty">None this week.</p>`
        : `<table><thead><tr>
            <th class="c1">Deal</th><th class="c2">Status</th><th class="c3">What changed</th>
            <th class="c4">Next step</th><th class="c5">DealRipe read</th><th class="c6">Action</th>
          </tr></thead><tbody>${rows.map((r) => rowHtml(r, now, variant)).join("")}</tbody></table>`
    }
  </section>`;
}

/**
 * Never engaged, as a paragraph plus the few that carry money.
 *
 * This section was 45 rows over roughly ten of the report's twenty-seven pages,
 * every one of them saying "Nothing captured on this deal yet" and "Confirm this
 * is real", for $87.3K of pipeline in total. Ten pages is a third of what a CRO
 * has to page through on a Monday, spent on an average of $1,900 a row.
 *
 * The information is not lost, it is proportioned: the count and the money up
 * front, then a table of only the ones worth a leader's attention, then the rest
 * as names. A manager chasing data hygiene has the list; Mark has one paragraph.
 *
 * The threshold is a real amount OR a booked meeting, because a $0 record with a
 * first meeting on the calendar is a deal about to start and belongs in front of
 * someone, while a $0 record with nothing booked is a row in a CRM.
 */
function neverEngagedSection(rows: Row[], now: number): string {
  const worth = (r: Row) => (r.deal.dealSizeAnnual ?? 0) >= 10_000 || r.deal.nextMeetingBooked;
  const shown = rows.filter(worth);
  const rest = rows.filter((r) => !worth(r));
  const total = rows.reduce((n, r) => n + (r.deal.dealSizeAnnual ?? 0), 0);

  return `<section class="sec grey">
    <div class="sechd"><h2>Never engaged</h2><div class="count">${rows.length} deal${rows.length === 1 ? "" : "s"}${
      total > 0 ? ` &middot; ${money1(total)}` : ""
    }</div></div>
    <p class="secsub">No customer conversation or reply has ever been captured on these. Shown below: the ${shown.length} carrying real money or a first meeting already on the calendar. The remaining ${rest.length} are listed by name at the end, and are a data hygiene job rather than a forecast one.</p>
    ${
      shown.length === 0
        ? `<p class="empty">None carrying money or a booked meeting.</p>`
        : `<table><thead><tr>
            <th class="c1">Deal</th><th class="c2">Status</th><th class="c3">What changed</th>
            <th class="c4">Next step</th><th class="c5">DealRipe read</th><th class="c6">Action</th>
          </tr></thead><tbody>${shown.map((r) => rowHtml(r, now, "live")).join("")}</tbody></table>`
    }
    ${
      rest.length === 0
        ? ""
        : `<p class="secsub" style="margin-top:16px"><b>Also never engaged, nothing booked, no size in Rolldog:</b> ${rest
            .map((r) => esc(r.deal.account))
            .join(", ")}.</p>`
    }
  </section>`;
}

export type ActivityReport = {
  subject: string;
  html: string;
  counts: { total: number; silent: number; moving: number; stalled: number; notMoving: number; never: number; unknown: number };
};

export async function buildActivityReport(args: {
  tenantId: string;
  /** Movement window for the underlying pipeline read. Not the silence window. */
  windowDays?: number;
  now?: number;
  /** Read stored reads without generating. For previewing without spend. */
  readOnly?: boolean;
  /**
   * Cap the deals rendered. PREVIEW ONLY, and it prints a line saying it was
   * capped: a report that silently shows 8 of 122 reads as though it were the
   * whole book is the kind of thing that gets quoted.
   */
  limit?: number;
}): Promise<ActivityReport> {
  const windowDays = args.windowDays ?? 14;
  const now = args.now ?? Date.now();
  const { tenantId } = args;

  const sinceIso = new Date(now - windowDays * 86_400_000).toISOString();
  const untilIso = new Date(now).toISOString();
  const pc = await getPipelineChanges(tenantId, { sinceIso, untilIso });
  const raw = pc.deals as DealChangeRecord[];
  // SALES PIPELINE, NOT EVERY RECORD DEALRIPE TOUCHES. Mark asked for all deals,
  // meaning all deals being sold. A closed opportunity and an onboarding session
  // are neither, and one closed-won row in a forecast pack costs more trust than
  // it adds coverage. Pre-opportunity evaluations stay: at Magaya the
  // opportunity is created after discovery, so excluding them would drop most of
  // the real early pipeline.
  const CLOSED = /(closed|won|lost)/i;
  const allDeals = raw.filter((d) => {
    if (d.archived) return false;
    if (d.stageName && CLOSED.test(d.stageName)) return false;
    // ALSO THE FORECAST CATEGORY, not just the stage name. TW Customs Brokers
    // printed "Closed . Jun 25" in a pipeline review, two months after it
    // closed, because the stage name was clean and the closed-ness lived in the
    // forecast column. A closed deal in a pipeline inspection is the report
    // failing at the one thing its title claims.
    if (d.forecastCategory && CLOSED.test(d.forecastCategory)) return false;
    if (d.isRenewal && !d.inRolldog) return false;
    return true;
  });
  const deals = args.limit ? allDeals.slice(0, args.limit) : allDeals;
  const capped = deals.length < allDeals.length ? allDeals.length : 0;

  const { byDeal, dealsWithAnyMail } = await lastCustomerEmailByDeal(
    tenantId,
    deals.map((d) => d.dealId),
  );

  // Has this REP's mailbox been read at all. A rep whose mail was never ingested
  // would otherwise have their entire book land in the silent column, which is
  // the single worst thing this report could do.
  const repHasMail = new Set<string>();
  for (const d of deals) {
    if (dealsWithAnyMail.has(d.dealId) && d.repEmail) repHasMail.add(d.repEmail.toLowerCase());
  }

  const dealIds = deals.map((d) => d.dealId);
  const nextByDeal = await nextMeetingByDeal(tenantId, dealIds);
  const agreedAtByDeal = await nextStepAgreedAt(tenantId, dealIds);
  const contactByDeal = await contactHistory(tenantId, dealIds);
  const capturedDeals = await capturedCallDeals(tenantId, dealIds);

  const rows: Row[] = deals.map((deal) => ({
    deal,
    next: nextByDeal.get(deal.dealId),
    agreedAt: agreedAtByDeal.get(deal.dealId),
    engaged: capturedDeals.has(deal.dealId) || Boolean(contactByDeal.get(deal.dealId)?.lastInbound),
    chases: contactByDeal.get(deal.dealId)?.chases,
    lastChaseAbout: contactByDeal.get(deal.dealId)?.lastChaseAbout ?? null,
    lastContact: (() => {
      const inb = contactByDeal.get(deal.dealId)?.lastInbound ?? null;
      const call = deal.lastConversationAt;
      // Whichever came last IS the last contact. A call three weeks after their
      // last email is the real final interaction, and the reverse is just as true.
      if (call && (!inb || Date.parse(call) > Date.parse(inb.at))) {
        return { at: call, kind: "call" as const, what: deal.agreedNextStep ?? "a call was held" };
      }
      if (inb) return { at: inb.at, kind: "email" as const, what: inb.subject ?? "they emailed" };
      return undefined;
    })(),
    activity: readActivity(
      {
        nextMeetingBooked: deal.nextMeetingBooked,
        hasEverSpoken: Boolean(deal.lastConversationAt),
        daysSinceConversation: days(deal.lastConversationAt, now),
        daysSinceCustomerEmail: days(byDeal.get(deal.dealId) ?? null, now),
        mailboxRead: repHasMail.has((deal.repEmail ?? "").toLowerCase()),
      },
      ACTIVITY_WINDOW_DAYS,
    ),
  }));

  // THE READ, FOR EVERY DEAL.
  //
  // refreshDealRead only spends a model call when the evidence hash has moved,
  // so a week where a deal did nothing costs nothing and keeps the paragraph it
  // had. Sequential rather than parallel: this is a weekly cron with a 300s
  // budget and a burst of 120 concurrent model calls is how you get rate
  // limited into a half-written report.
  for (const r of rows) {
    try {
      const ev = await buildDealEvidence({
        tenantId,
        dealId: r.deal.dealId,
        account: r.deal.account,
        repName: r.deal.repName,
        stage: r.deal.stageName ?? "no opportunity yet",
        band: r.deal.forecastCategory,
        amount: r.deal.dealSizeAnnual,
        closeDate: r.deal.closeDate,
        missing: r.deal.missing ?? [],
      });
      r.changed = ev.changedThisWeek;
      r.lastLearned = ev.lastLearned;
      const stored = await refreshDealRead({ tenantId, dealId: r.deal.dealId, evidence: ev, readOnly: args.readOnly });
      r.read = stored?.text;
      r.headline = stored?.headline ?? null;
    } catch (err) {
      console.warn(`[activity-report] read failed for ${r.deal.account}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // MONEY FIRST, IN EVERY SECTION.
  //
  // Sorting the silent list by days quiet put a $4K deal quiet for 36 days above
  // a $245K Expect quiet for 15. A leader triages by exposure, so the amount
  // leads and urgency breaks the tie. Deals with no amount in Rolldog sort after
  // every deal that has one, because an unknown number is not a small one.
  const byValue = (a: Row, b: Row) => {
    const av = a.deal.dealSizeAnnual ?? 0;
    const bv = b.deal.dealSizeAnnual ?? 0;
    if (av > 0 && bv <= 0) return -1;
    if (bv > 0 && av <= 0) return 1;
    return bv - av;
  };
  const then = (second: (a: Row, b: Row) => number) => (a: Row, b: Row) => byValue(a, b) || second(a, b);
  const bySilence = then((a, b) => (b.activity.quietDays ?? -1) - (a.activity.quietDays ?? -1));
  const byOverdue = then((a, b) => {
    const age = (r: Row) => (r.agreedAt ? Date.now() - Date.parse(r.agreedAt) : -1);
    return age(b) - age(a);
  });
  const byClose = then((a, b) => {
    const c = (r: Row) => (r.deal.closeDate ? Date.parse(r.deal.closeDate) : Number.POSITIVE_INFINITY);
    return c(a) - c(b);
  });

  const of = (k: StatusKey) => rows.filter((r) => statusOf(r) === k);
  const silent = of("silent").sort(bySilence);
  const stalled = of("stalled").sort(byOverdue);
  const notMoving = of("active").sort(byClose);
  const moving = of("moving").sort(byClose);
  const never = of("never").sort(byValue);
  const unknown = rows.filter((r) => r.activity.verdict === "unknown");
  const sum = (rs: Row[]) => rs.reduce((n, r) => n + (r.deal.dealSizeAnnual ?? 0), 0);

  const forecasted = rows.filter((r) => ["Commit", "Expect"].includes(r.deal.forecastCategory ?? ""));
  // AT RISK is a judgement about the FORECAST, so it needs a forecast-relevant
  // reason: the deal has gone quiet, the agreed step is overdue, or a
  // high-severity flag fired. A missing qualification field on a deal the
  // customer is actively buying is not a forecast risk, which is why buying
  // behaviour decides and field completeness does not.
  const atRisk = forecasted.filter((r) => {
    const st = statusOf(r);
    if (st === "silent" || st === "stalled" || st === "never") return true;
    // A deal that is MOVING is not at risk because a field is blank. Integrity
    // Customs had the proposal accepted, the signature agreed and a named
    // external blocker with a date, and was being called unsupported over a
    // budget checkbox. Buying behaviour outranks field completeness.
    if (st === "moving") return false;
    return r.deal.flags.some((f) => f.severity === "high");
  });
  const clean = forecasted.filter((r) => !atRisk.includes(r));

  /**
   * Three to five things, each one a different finding.
   *
   * Ranked by money inside an at-risk forecast. The headline states what
   * happened; the line under it carries the specifics. Five copies of "forecast
   * unsupported" is one finding printed five times.
   */
  const before = [...atRisk]
    .sort(byValue)
    .slice(0, 5)
    .map((r) => {
      const st = statusOf(r);
      const ns = nextStep(r);
      const money = money1(r.deal.dealSizeAnnual);
      const band = r.deal.forecastCategory ?? "";
      const claim =
        st === "never"
          ? `has never engaged`
          : st === "silent"
          ? r.activity.quietDays !== null
            ? `gone silent for ${r.activity.quietDays} days`
            : `has never come back to us`
          : commitmentState(r) === "overdue"
            ? `next step is overdue`
            : r.deal.flags.some((f) => f.kind === "no_show")
              ? `no-showed and has not rebooked`
              : r.deal.closeDate && Date.parse(r.deal.closeDate) - now < 14 * 86_400_000
                ? `closes soon and is not ready`
                : `needs a look`;
      // Sales shorthand, not fragments. "overdue, 13d" reads as a stray field;
      // "13d overdue" is how a person says it.
      const facts: string[] = [];
      if (st === "silent" || st === "never") {
        const n = r.chases ?? 0;
        facts.push(n > 0 ? `${n} follow-up${n === 1 ? "" : "s"}, no reply` : "no reply ever");
      }
      const nsState = commitmentState(r);
      if (nsState === "none") facts.push("no next step");
      else if (nsState === "overdue") {
        const aged = r.agreedAt ? Math.floor((now - Date.parse(r.agreedAt)) / 86_400_000) : null;
        facts.push(aged ? `${aged}d overdue` : "next step overdue");
      } else if (nsState === "agreed") facts.push("agreed, never booked");
      else if (nsState === "waiting_customer") facts.push("waiting on customer");
      if (!r.deal.economicBuyer?.engaged) facts.push("signer unknown");
      return {
        tone: st === "silent" ? "bad" : st === "stalled" ? "amber" : "warn",
        head: `${esc(r.deal.account)}${money ? ` &middot; ${money}` : ""}${band ? ` ${esc(band)}` : ""} ${esc(claim)}`,
        why: r.headline ?? "",
        facts: facts.slice(0, 3).join(", "),
      };
    });

  const when = new Date(now).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const dot = (t: string) => `<span class="dot ${t}"></span>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
<title>DealRipe pipeline review, week of ${when}</title>
<style>
  :root{--ink:#0F172A;--body:#1E293B;--sub:#3F4A5A;--line:#E2E8F0;--soft:#F1F5F9;
        --bad:#B42318;--amber:#B54708;--warn:#A16207;--ok:#027A48}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;background:#fff;color:var(--ink);
       padding:34px 30px;font-size:11pt;line-height:1.55;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1240px;margin:0 auto}

  .brand{font-size:10.5pt;font-weight:800;letter-spacing:.18em;text-transform:uppercase;color:var(--ok)}
  h1{font-size:27pt;font-weight:700;letter-spacing:-.02em;margin-top:8px;line-height:1.1}
  .when{font-size:12.5pt;color:var(--sub);margin-top:6px}
  .method{font-size:10pt;color:var(--sub);margin-top:10px;max-width:640px}

  /* TABLES, NOT GRID. Gmail and Outlook do not support CSS grid: the five
     metric cells stacked into a ragged column in the inbox while looking correct
     in Chrome, which is the whole hazard of designing an email in a browser.
     Every multi-column block here is a real table now. */
  .strip{width:100%;border-collapse:collapse;border-top:2px solid var(--ink);
         border-bottom:1px solid var(--line);margin:26px 0 32px}
  .strip td{padding:18px 20px 16px;border-right:1px solid var(--line);width:20%;vertical-align:top}
  .cell{padding:18px 20px 16px;border-right:1px solid var(--line)}
  .cell:last-child,.strip td:last-child{border-right:0}
  .ck{font-size:9pt;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--sub)}
  .cv{font-size:24pt;font-weight:750;letter-spacing:-.025em;margin-top:7px;line-height:1}
  .cv.bad{color:var(--bad)} .cv.ok{color:var(--ok)} .cv.warn{color:var(--warn)} .cv.amber{color:var(--amber)}
  .cs{font-size:9.5pt;color:var(--sub);margin-top:6px}

  h2{font-size:15pt;font-weight:700;letter-spacing:-.01em}
  .kn{margin-bottom:34px}
  .kn h2{margin-bottom:14px}
  .kn table{width:100%;border-collapse:collapse}
  .krow td{padding:14px 0;border-top:1px solid var(--soft);vertical-align:top}
  .krow td.kd{width:24px}
  .krow:last-child{border-bottom:1px solid var(--soft)}
  .khead{font-size:12.5pt;font-weight:650;line-height:1.4}
  .kwhy{font-size:10.5pt;color:var(--sub);margin-top:4px;line-height:1.5}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-top:7px}
  .dot.bad{background:var(--bad)} .dot.amber{background:var(--amber)} .dot.warn{background:var(--warn)} .dot.ok{background:var(--ok)}

  .integ{width:100%;border-collapse:separate;border-spacing:20px 0;margin:0 -20px 38px}
  .integ td{width:50%;vertical-align:top}
  .ibox{border:1px solid var(--line);border-radius:8px;padding:18px 22px}
  .ibox.q{border-color:#FDA29B}
  .il{font-size:9pt;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--sub)}
  .iv{font-size:21pt;font-weight:750;letter-spacing:-.02em;margin-top:7px}
  .iv.bad{color:var(--bad)}
  .is{font-size:10pt;color:var(--sub);margin-top:7px;line-height:1.5}

  .sec{margin-bottom:34px}
  .sechd{border-bottom:2px solid var(--ink);padding-bottom:9px;break-after:avoid}
  .sechd h2{display:inline} .sechd .count{display:inline;margin-left:12px}
  .sec.red .sechd{border-color:var(--bad)} .sec.amber .sechd{border-color:var(--amber)}
  .sec.green .sechd{border-color:var(--ok)} .sec.grey .sechd{border-color:#98A2B3}
  .count{font-size:10.5pt;color:var(--sub);font-weight:600}
  .secsub{font-size:10pt;color:var(--sub);margin:9px 0 2px;max-width:820px}
  .empty{font-size:10.5pt;color:var(--sub);font-style:italic;padding:12px 0}

  /* COLUMN ISOLATION. The status pill carried white-space:nowrap inside a 10%
     column, so in the PDF "Never engaged" and "Active, not moving" ran straight
     across the cell border and interleaved with What changed: "Active, noNo
     change t moving". Every cell now has its own padding on BOTH sides, the
     status column is wide enough to hold its longest label, and the pill is
     allowed to wrap rather than overflow. */
  table{width:100%;border-collapse:collapse;margin-top:6px;table-layout:fixed}
  th{font-size:10pt;font-weight:700;letter-spacing:.01em;color:var(--ink);text-align:left;
     padding:14px 14px 11px 0;border-bottom:1.5px solid var(--ink)}
  th.c1{width:16%} th.c2{width:12%} th.c3{width:24%} th.c4{width:12%} th.c5{width:24%} th.c6{width:12%}
  td{padding:15px 14px 15px 0;font-size:10.5pt;vertical-align:top;color:var(--body);
     border-bottom:1px solid var(--soft);border-right:1px solid var(--soft);
     overflow-wrap:break-word;word-break:normal;hyphens:auto;min-width:0;overflow:hidden}
  td.st,td.ns{padding-right:16px}
  td:last-child{border-right:0}
  tr{break-inside:avoid}
  .acct b{font-size:12pt;font-weight:700;color:var(--ink);display:block;line-height:1.35}
  .acct i,i.sub{display:block;font-style:normal;font-size:9.5pt;color:var(--sub);margin-top:6px;font-weight:400;line-height:1.55}
  .chg{color:var(--ink)}
  .read{color:var(--body)}
  .act b{font-weight:700;color:var(--ink);font-size:10.5pt;display:block;line-height:1.4} .act b.hard{color:var(--bad)}
  /* A pill wraps INSIDE itself before it ever leaves the cell. nowrap was the
     direct cause of the status text crossing into What changed in the PDF. */
  .pill{display:inline-flex;align-items:flex-start;gap:6px;font-size:9.5pt;font-weight:700;
        max-width:100%;padding:4px 10px 4px 8px;border-radius:12px;border:1px solid var(--line);
        background:#fff;line-height:1.35;overflow-wrap:break-word;text-align:left}
  .pill i{flex:0 0 auto;margin-top:5px}
  .none{color:#98A2B3;font-size:10.5pt}
  .pill i{width:7px;height:7px;border-radius:50%;background:#98A2B3;display:inline-block}
  .pill.ok{color:var(--ok);border-color:#A6F4C5} .pill.ok i{background:var(--ok)}
  .pill.warn{color:var(--warn);border-color:#FEDF89} .pill.warn i{background:var(--warn)}
  .pill.amber{color:var(--amber);border-color:#FEC84B} .pill.amber i{background:var(--amber)}
  .pill.bad{color:var(--bad);border-color:#FDA29B} .pill.bad i{background:var(--bad)}
  .foot{font-size:9pt;color:var(--sub);margin-top:30px;line-height:1.7;border-top:1px solid var(--line);padding-top:14px}
  /* PRINT IS THE DELIVERABLE. Mark gets this as a PDF every Monday, so the page
     box is declared rather than inherited from whatever Chrome's default happens
     to be, and nothing here shrinks type to win a page break: more pages is the
     correct answer and 20 of them is fine. */
  @page{size:Letter landscape;margin:12mm 10mm 14mm}
  @media print{
    /* WIDTH IS THE WHOLE PROBLEM. Chrome lays the page out at its own default
       width and then fits it to the page box, so anything that assumes a wider
       viewport gets clipped at the right edge: the Gone silent figure and the
       entire Action column were being cut off the page. Everything is pinned to
       100% of the printable area and nothing is allowed to exceed it. */
    html,body{width:100%;max-width:100%;overflow-x:hidden}
    body{padding:0;font-size:10pt}
    .wrap{max-width:100%;width:100%}
    table{width:100%;max-width:100%}
    .strip{width:100%}
    thead{display:table-header-group}
    tfoot{display:table-footer-group}
    /* Rows may not split, but the TABLE must be allowed to flow across pages.
       break-inside:avoid on the cells was forcing a new page after almost every
       row and leaving most of each page blank. */
    tr{break-inside:avoid;page-break-inside:avoid}
    td,th{break-inside:auto}
    table,tbody,.sec{break-inside:auto;page-break-inside:auto}
    .sechd{break-after:avoid;page-break-after:avoid}
    .secsub{break-after:avoid;page-break-after:avoid}
    .sec table{break-before:avoid}
    h1,h2{break-after:avoid}
    .krow{break-inside:avoid}
    .strip,.integ,.ibox{break-inside:avoid}
    .foot{break-inside:avoid}
    /* A section header alone at the foot of a page is the one break that makes a
       report look unfinished, so it is pinned to at least its first rows. */
    .sec thead{break-after:avoid}
  }
</style></head><body><div class="wrap">
  <div class="brand">DealRipe</div>
  <h1>Pipeline review</h1>
  <div class="when">Week of ${esc(when)}${capped ? ` &middot; preview, ${rows.length} of ${capped} deals` : ""}</div>
  <p class="method">Every open deal, from the CRM plus what the customer has actually done across calls, calendar and email.</p>

  <table class="strip" role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td><div class="ck">Open pipeline</div><div class="cv">${money1(sum(rows))}</div><div class="cs">${rows.length} deals</div></td>
    <td><div class="ck">Commit + Expect</div><div class="cv">${money1(sum(forecasted))}</div><div class="cs">${forecasted.length} deals</div></td>
    <td><div class="ck">Moving</div><div class="cv ok">${moving.length}</div><div class="cs">${money1(sum(moving)) || "no size in Rolldog"}</div></td>
    <td><div class="ck">Stalled</div><div class="cv amber">${stalled.length}</div><div class="cs">${money1(sum(stalled)) || "no size in Rolldog"}</div></td>
    <td><div class="ck">Gone silent</div><div class="cv bad">${silent.length}</div><div class="cs">${money1(sum(silent)) || "no size in Rolldog"}</div></td>
  </tr></table>
  <p class="method" style="margin:-18px 0 30px">${notMoving.length} active but not moving &middot; ${never.length} never engaged.</p>

  ${
    before.length > 0
      ? `<div class="kn"><h2>Before the review</h2><table role="presentation" cellpadding="0" cellspacing="0">${before
          .map(
            (h) => `<tr class="krow"><td class="kd">${dot(h.tone)}</td><td><div class="khead">${h.head}</div><div class="kwhy">${esc(h.why)}${
              h.facts && h.why !== h.facts ? ` &middot; ${esc(h.facts)}` : ""
            }</div></td></tr>`,
          )
          .join("")}</table></div>`
      : ""
  }

  <table class="integ" role="presentation" cellpadding="0" cellspacing="0"><tr>
    <td><div class="ibox q">
      <div class="il">Forecast at risk</div>
      <div class="iv bad">${money1(sum(atRisk)) || "no size in Rolldog"}</div>
      <div class="is">${atRisk.length} of ${forecasted.length} Commit and Expect deals have gone quiet, stalled, or carry a serious issue.</div>
    </div></td>
    <td><div class="ibox">
      <div class="il">Forecast looks clean</div>
      <div class="iv">${money1(sum(clean)) || "no size in Rolldog"}</div>
      <div class="is">${clean.length} deals where nothing in the evidence argues with the rep. Not a prediction that they close.</div>
    </div></td>
  </tr></table>

  ${section("Gone silent",
    "Previously engaged, then nothing from the customer in 14 days or more and nothing booked. Highest value first.",
    silent, now, "red", "quiet")}
  ${section("Stalled",
    "The customer was engaged and an expected next step broke down: a no-show, or something agreed that never happened. Highest value first.",
    stalled, now, "amber")}
  ${section("Active, not moving",
    "They are talking to us, but the deal has not advanced and nothing is booked. Highest value first.",
    notMoving, now, "amber")}
  ${section("Moving",
    "Customer activity created real forward motion, or a valid next meeting is on the calendar. These do not need forecast-call time. Highest value first.",
    moving, now, "green")}
  ${neverEngagedSection(never, now)}
  ${unknown.length > 0 ? section("Unable to verify", "The calendar or mailbox could not be read, so nothing is claimed about these.", unknown, now, "grey") : ""}

  <p class="foot"><b>Method.</b> Customer activity is based on what DealRipe can see across connected calls, email and calendar. Other interactions, a call to a rep's mobile for example, may not be captured, so treat "gone silent" as the list to ask about. Where a meeting could not be verified it is labelled as such rather than counted as missed. Amounts are annualized from Rolldog and blank where Rolldog has no size, so dollar totals are a floor. "Agreed, not booked" is checked against the rep's own calendar.</p>
</div></body></html>`;

  return {
    subject: `DealRipe pipeline review, week of ${when}. ${silent.length} gone silent, ${stalled.length} stalled`,
    html,
    counts: { total: rows.length, silent: silent.length, moving: moving.length, stalled: stalled.length, notMoving: notMoving.length, never: never.length, unknown: unknown.length },
  };
}
