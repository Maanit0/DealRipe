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

function rowHtml(r: Row, now: number, variant: "live" | "quiet" = "live"): string {
  const d = r.deal;
  const amount = money(d.dealSizeAnnual);
  // A BLANK STAGE IS A FACT, NOT A MISSING VALUE.
  //
  // 100 of 133 open deals carry no Rolldog opportunity, because Magaya does not
  // create one until after the discovery call. An empty cell reads as "we do not
  // know", which is wrong.
  //
  // NOT "Salesforce". 82 of those 100 do carry a Salesforce ACCOUNT link, and an
  // account is not an opportunity: most hold no open opportunity and none holds a
  // stage. Naming the other CRM here would send a leader looking for a staged
  // opportunity that does not exist, which is the same error as reading a linked
  // account as a live deal.
  const stage = d.stageName ?? d.stageKey ?? (d.inRolldog ? "" : "No opportunity yet");
  const band = d.forecastCategory ?? "";
  const owed = d.repOwedMeeting && d.agreedNextStep ? d.agreedNextStep : null;
  // THE THREE OPEN GAPS THAT MATTER MOST, NOT ALL OF THEM.
  //
  // A deal with eleven gaps prints eleven and the column becomes wallpaper. The
  // first three are the ones the stage ordering puts first, which is the order a
  // rep has to close them in anyway.
  const blocking = (d.missing ?? []).slice(0, 3);
  const changed = (r.changed ?? []).slice(0, 6);
  const crm = d.movement?.summary && d.movement.moved ? d.movement.summary : "";
  return `<tr class="main">
    <td class="acct"><b>${esc(d.account)}</b><i>${esc(d.repName || d.repEmail || "")}</i><i>${esc(stage)}</i></td>
    <td class="num">${esc(amount)}</td>
    <td class="meta">${band ? `<b>${esc(band)}</b>` : `<span class="dim">no band</span>`}${
      d.closeDate
        ? `<i>closes ${dayLabel(d.closeDate)}</i>`
        : `<i>no close date</i>`
    }</td>
    ${
      variant === "quiet"
        ? `<td class="moved">${
            r.lastContact
              ? `<b>${new Date(r.lastContact.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</b>` +
                `<span>${esc(r.lastContact.kind === "call" ? "on a call" : "they emailed")}</span>` +
                `<span>${esc(String(r.lastContact.what).slice(0, 90))}</span>`
              : `<span class="dim">no contact on record</span>`
          }</td>
          <td class="moved">${
            r.chases
              ? `<b>${r.chases}</b><span>follow-up${r.chases === 1 ? "" : "s"} from us since</span>${
                  r.lastChaseAbout ? `<span>last one about "${esc(r.lastChaseAbout)}"</span>` : ""
                }`
              : `<span>no follow-up sent since</span>`
          }</td>
          <td class="meta"><b>${r.activity.quietDays ?? "?"}</b><i>days dark</i></td>`
        : `<td class="moved">${crm ? `<span>${esc(crm)}</span>` : `<span class="dim">no change</span>`}</td>
           <td class="moved">${
             r.headline
               ? `<span><b>${esc(r.headline)}</b></span>`
               : changed.length
               ? `<span>${esc(changed.join(", "))}</span>`
               : r.lastLearned
                 ? `<span>nothing new. Last learned <b>${esc(r.lastLearned.key)}</b> on ${new Date(
                     r.lastLearned.at,
                   ).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>`
                 : `<span>nothing captured on this deal yet</span>`
           }</td>`
    }
    <td class="why">${
      r.next
        ? `<b>${esc(meetingLine(r.next))}</b>`
        : `<span class="dim">nothing booked</span>`
    }${
      owed
        ? `<span class="owed">Agreed${
            r.agreedAt
              ? ` ${new Date(r.agreedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`
              : ""
          }, not booked: ${esc(owed)}</span>`
        : ""
    }<span class="sig">${esc(r.activity.reason)}</span></td>
  </tr>${
    r.read
      ? `<tr class="readrow"><td colspan="7"><span class="rl">DealRipe&rsquo;s read</span>${esc(r.read)}</td></tr>`
      : ""
  }`;
}

/** "Thu Aug 27, 1:30pm with Liam", rather than "a meeting is on the calendar". */
function meetingLine(n: NextMeeting): string {
  const when = new Date(n.at).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${when}${n.who.length ? ` with ${n.who.join(", ")}` : ""}`;
}

function section(title: string, sub: string, rows: Row[], now: number, tone: "red" | "green" | "grey", variant: "live" | "quiet" = "live"): string {
  const total = rows.reduce((n, r) => n + (r.deal.dealSizeAnnual ?? 0), 0);
  const noAmount = rows.filter((r) => !(r.deal.dealSizeAnnual ?? 0)).length;
  return `<section class="sec ${tone}">
    <div class="sechd">
      <h2>${esc(title)}</h2>
      <div class="count">${rows.length} deal${rows.length === 1 ? "" : "s"}${
        total > 0 ? ` &middot; ${money(total)}` : ""
      }${noAmount > 0 ? ` <span class="floor">(${noAmount} carry no amount in Rolldog, so that is a floor)</span>` : ""}</div>
    </div>
    <p class="secsub">${esc(sub)}</p>
    ${
      rows.length === 0
        ? `<p class="empty">Nothing in this list this week.</p>`
        : `<table><thead><tr><th>Deal</th><th class="num">Annual</th><th>Rep forecast</th>${
            variant === "quiet"
              ? `<th>Last contact<i>when it went dark</i></th><th>Chased<i>since they last spoke</i></th><th>Age</th>`
              : `<th>CRM this week<i>what the rep entered</i></th><th>DealRipe learned<i>gates that moved</i></th>`
          }<th>Next interaction</th></tr></thead>
           <tbody>${rows.map((r) => rowHtml(r, now, variant)).join("")}</tbody></table>`
    }
  </section>`;
}

export type ActivityReport = {
  subject: string;
  html: string;
  counts: { total: number; silent: number; active: number; notStarted: number; unknown: number };
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
  const allDeals = pc.deals as DealChangeRecord[];
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

  const rows: Row[] = deals.map((deal) => ({
    deal,
    next: nextByDeal.get(deal.dealId),
    agreedAt: agreedAtByDeal.get(deal.dealId),
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

  const byValue = (a: Row, b: Row) => (b.deal.dealSizeAnnual ?? 0) - (a.deal.dealSizeAnnual ?? 0);
  // "They went dark on us" and "we have never had a conversation" are both
  // silent and they are not the same problem. Mark asked about the first one
  // ("I still haven't heard from them"), so deals with a measurable silence lead,
  // longest first, and the ones with no captured call at all follow by value.
  // Sorting a null as 9999 put four deals we have never spoken to above a
  // $56,100 deal at Expect that went quiet six weeks ago.
  const silent = rows
    .filter((r) => r.activity.verdict === "silent")
    .sort((a, b) => {
      const aq = a.activity.quietDays;
      const bq = b.activity.quietDays;
      if (aq === null && bq !== null) return 1;
      if (bq === null && aq !== null) return -1;
      if (aq !== null && bq !== null && aq !== bq) return bq - aq;
      return byValue(a, b);
    });
  // INSIDE THE ACTIVE LIST, THE WEAKEST SIGNAL COMES FIRST.
  //
  // 37 of these are active only because we had a call. The customer has not
  // written since and nothing is on the calendar, which is drift rather than
  // momentum. Sorting a booked meeting to the bottom puts the deals that still
  // need a next step at the top of the list Mark actually reads, without adding
  // a third bucket he did not ask for.
  const active = rows
    .filter((r) => r.activity.verdict === "active")
    .sort((a, b) => Number(a.deal.nextMeetingBooked) - Number(b.deal.nextMeetingBooked) || byValue(a, b));
  const notStarted = rows.filter((r) => r.activity.verdict === "not_started").sort(byValue);
  const unknown = rows.filter((r) => r.activity.verdict === "unknown").sort(byValue);

  const when = new Date(now).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const html = `<!doctype html><html><head><meta charset="utf-8"/>
<title>DealRipe pipeline review, week of ${when}</title>
<style>
  :root{--ink:#0F172A;--muted:#334155;--line:#E7EBF0;--red:#B91C1C;--green:#047857;--bg:#F4F6F9}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);padding:34px 26px}
  .wrap{max-width:1080px;margin:0 auto}
  .top{margin-bottom:22px}
  .brand{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#10B981}
  h1{font-size:26px;font-weight:750;margin-top:7px;letter-spacing:-.02em}
  .sub{font-size:14.5px;color:#334155;margin-top:6px;line-height:1.5;max-width:820px}
  .strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0;background:#fff;border:1px solid var(--line);border-radius:11px;overflow:hidden;margin:18px 0 6px}
  .cell{padding:15px 20px;border-right:1px solid var(--line)}.cell:last-child{border-right:0}
  .ck{font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#0F172A}
  .cv{font-size:27px;font-weight:800;letter-spacing:-.02em;margin-top:6px}
  .cv.red{color:var(--red)}.cv.green{color:var(--green)}
  .cs{font-size:12px;color:#334155;margin-top:4px}
  .sec{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-top:18px}
  .sec.red{border-top:3px solid var(--red)}.sec.green{border-top:3px solid var(--green)}.sec.grey{border-top:3px solid #94A3B8}
  .sechd{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
  h2{font-size:18px;font-weight:750}
  .count{font-size:13.5px;color:#334155;font-weight:600}
  .floor{font-weight:400}
  .secsub{font-size:13.5px;color:#334155;margin-top:7px;line-height:1.5;max-width:860px}
  .empty{font-size:14px;color:#334155;margin-top:14px;font-style:italic}
  table{width:100%;border-collapse:collapse;margin-top:14px}
  th{font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:#0F172A;text-align:left;padding:0 10px 8px 0;border-bottom:1px solid var(--line)}
  th i{display:block;font-style:normal;font-weight:600;letter-spacing:0;text-transform:none;font-size:10.5px;color:#334155;margin-top:3px}
  td{padding:10px 10px 10px 0;border-bottom:1px solid #F5F7F9;font-size:13px;vertical-align:top;line-height:1.4}
  tr:last-child td{border-bottom:0}
  .acct b{font-weight:700;font-size:13.5px}
  .acct i,.meta i{display:block;font-style:normal;font-size:11.5px;color:#334155;margin-top:2px}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:650}
  th.num{text-align:right}
  .meta{color:var(--muted);white-space:nowrap}
  .why{color:#334155}
  .owed{display:block;margin-top:5px;color:var(--red);font-size:12px}
  .watch{display:block;margin-top:5px;color:#B45309;font-size:12px}
  .moved{color:#334155;font-size:12.5px;max-width:200px}
  .moved span,.block span{display:block;line-height:1.5}
  .dim{color:#334155}
  .sig{display:block;margin-top:5px;color:#334155;font-size:12px}
  tr.main td{border-bottom:0;padding-bottom:6px}
  tr.readrow td{padding:0 10px 14px 0;border-bottom:1px solid #F5F7F9;font-size:13px;line-height:1.55;color:#1e293b}
  tr.readrow .rl{display:block;font-size:9.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--green);margin-bottom:3px}
  .when{display:block;margin-top:5px;color:var(--green);font-size:12px}
  .block span{display:block;font-size:11.5px;color:#334155;line-height:1.5}
  .block{max-width:180px}
  .foot{font-size:12.5px;color:#334155;margin-top:20px;line-height:1.55;max-width:860px}
  @media print{body{background:#fff;padding:0}.sec{break-inside:auto}tr{break-inside:avoid}}
</style></head><body><div class="wrap">
  <div class="top">
    <div class="brand">DealRipe</div>
    <h1>Pipeline review</h1>
    <p class="sub">Every open deal, week of ${esc(when)}. Companion to the Monday digest and built from the same engine, so the two agree. The digest ranks the few that need you most. This is all of them, split by whether the customer is moving.</p>
  </div>
  <div class="strip">
    <div class="cell"><div class="ck">Gone quiet</div><div class="cv red">${silent.length}</div><div class="cs">nothing from them in ${ACTIVITY_WINDOW_DAYS}+ days and nothing booked</div></div>
    <div class="cell"><div class="ck">In contact</div><div class="cv green">${active.length}</div><div class="cs">a meeting booked, a call, or they emailed</div></div>
    <div class="cell"><div class="ck">First meeting booked</div><div class="cv">${notStarted.length}</div><div class="cs">on the calendar, no conversation yet</div></div>
    ${
      // ZERO IS THE HEALTHY CASE, SO IT PRINTS NOTHING.
      //
      // The bucket still exists in the logic and must: one failed mailbox ingest
      // would otherwise drop a whole rep's book into "gone quiet", and Mark would
      // tell a rep their deals are dead while the customer emailed yesterday. The
      // classifier keeps the guard, the page just stops showing an empty box.
      unknown.length > 0
        ? `<div class="cell"><div class="ck">Cannot tell</div><div class="cv">${unknown.length}</div><div class="cs">reported apart, never counted as quiet</div></div>`
        : ""
    }
  </div>
  ${section(
    "Gone quiet",
    `${SILENCE_CAVEAT} Sorted by how long they have been quiet, longest first.`,
    silent,
    now,
    "red",
    "quiet",
  )}
  ${section(
    "In contact with the customer",
    "A meeting is on the calendar, or they have spoken to us or emailed us inside the last two weeks. Our own outbound does not count: a rep emailing into silence is the problem, not evidence against it. Deals with nothing booked after the last contact are listed first, because those are the ones still needing a next step.",
    active,
    now,
    "green",
  )}
  ${section(
    "First meeting booked",
    "A meeting is booked and DealRipe has never captured a conversation on these. New business waiting to start rather than momentum, which is why they are counted apart: a deal that has not begun is not a deal that is moving.",
    notStarted,
    now,
    "grey",
  )}
  ${
    unknown.length > 0
      ? section(
          "Cannot tell",
          "The calendar or the mailbox could not be read for these, so silence cannot be claimed. Listed rather than folded into either column, because a deal we did not check is not a deal that went quiet.",
          unknown,
          now,
          "grey",
        )
      : ""
  }
  ${capped ? `<p class="foot" style="color:#B91C1C"><b>PREVIEW ONLY: showing ${rows.length} of ${capped} deals.</b></p>` : ""}
  <p class="foot">${rows.length} deals in total. Amounts are annualized from Rolldog and are blank where Rolldog carries no size, so every dollar total here is a floor rather than a total. "Agreed and not booked" is checked against the rep's own calendar, so it is the absence of a meeting rather than the absence of a note about one.</p>
</div></body></html>`;

  return {
    subject: `DealRipe pipeline review, week of ${when}. ${silent.length} deals have gone quiet`,
    html,
    counts: { total: rows.length, silent: silent.length, active: active.length, notStarted: notStarted.length, unknown: unknown.length },
  };
}
