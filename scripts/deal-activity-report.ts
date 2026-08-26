/**
 * The Monday companion to the digest: EVERY deal, split by whether the customer
 * has done anything.
 *
 * Mark Buman, 2026-08-26: "I'd love a way if we could sort by no interaction
 * versus interaction. Then I can concentrate, especially as we're getting
 * closer to the end of the quarter, on how do we make action happen." And on
 * the format: "if I can just get that on Mondays with the digest, that's
 * perfect, because then I can look at the two side by side."
 *
 * SIDE BY SIDE IS THE CONSTRAINT THAT DECIDES THE ARCHITECTURE.
 *
 * This runs on getPipelineChanges, the same engine behind the digest, rather
 * than on loadPortfolioRead. The two documents land in the same inbox on the
 * same morning, so a deal showing $122k in one and $46k in the other, or
 * appearing in one and not the other, would discredit both at once. One engine,
 * two views.
 *
 * The digest shows the top few by attention score. This shows all of them,
 * which is the other half of what he asked for.
 *
 *   npx tsx scripts/deal-activity-report.ts            writes and opens the HTML
 *   npx tsx scripts/deal-activity-report.ts --days 21  widen the movement window
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

import {
  ACTIVITY_WINDOW_DAYS,
  SILENCE_CAVEAT,
  readActivity,
  type ActivityRead,
} from "../lib/deal-activity";
import { getPipelineChanges, type DealChangeRecord } from "../lib/pipeline-changes";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const money = (n: number | null | undefined) =>
  typeof n === "number" && n > 0 ? `$${Math.round(n).toLocaleString("en-US")}` : "";

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

type Row = { deal: DealChangeRecord; activity: ActivityRead };

function rowHtml(r: Row, now: number): string {
  const d = r.deal;
  const amount = money(d.dealSizeAnnual);
  const stage = d.stageName ?? d.stageKey ?? "";
  const band = d.forecastCategory ?? "";
  const lastTalk = days(d.lastConversationAt, now);
  const owed = d.repOwedMeeting && d.agreedNextStep ? d.agreedNextStep : null;
  return `<tr>
    <td class="acct"><b>${esc(d.account)}</b><i>${esc(d.repName || d.repEmail || "")}</i></td>
    <td class="num">${esc(amount)}</td>
    <td class="meta">${esc(stage)}${band ? `<i>${esc(band)}</i>` : ""}</td>
    <td class="meta">${lastTalk === null ? "no call captured" : `${lastTalk}d ago`}</td>
    <td class="why">${esc(r.activity.reason)}${
      owed ? `<span class="owed">Agreed and not booked: ${esc(owed)}</span>` : ""
    }${
      r.activity.verdict === "active" && !d.nextMeetingBooked && !owed
        ? `<span class="watch">Nothing on the calendar after it</span>`
        : ""
    }</td>
  </tr>`;
}

function section(title: string, sub: string, rows: Row[], now: number, tone: "red" | "green" | "grey"): string {
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
        : `<table><thead><tr><th>Deal</th><th class="num">Annual</th><th>Stage</th><th>Last spoke</th><th>What we can see</th></tr></thead>
           <tbody>${rows.map((r) => rowHtml(r, now)).join("")}</tbody></table>`
    }
  </section>`;
}

async function main(): Promise<void> {
  const windowDays = Number(arg("--days") ?? 14);
  const now = Date.now();
  const tenantId = await resolveTenantId(TENANT);

  const sinceIso = new Date(now - windowDays * 86_400_000).toISOString();
  const untilIso = new Date(now).toISOString();
  const pc = await getPipelineChanges(tenantId, { sinceIso, untilIso });
  const deals = pc.deals as DealChangeRecord[];

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

  const rows: Row[] = deals.map((deal) => ({
    deal,
    activity: readActivity(
      {
        nextMeetingBooked: deal.nextMeetingBooked,
        daysSinceConversation: days(deal.lastConversationAt, now),
        daysSinceCustomerEmail: days(byDeal.get(deal.dealId) ?? null, now),
        mailboxRead: repHasMail.has((deal.repEmail ?? "").toLowerCase()),
      },
      ACTIVITY_WINDOW_DAYS,
    ),
  }));

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
  const unknown = rows.filter((r) => r.activity.verdict === "unknown").sort(byValue);

  const when = new Date(now).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const html = `<!doctype html><html><head><meta charset="utf-8"/>
<title>DealRipe deal activity, week of ${when}</title>
<style>
  :root{--ink:#0F172A;--muted:#5B6470;--line:#E7EBF0;--red:#B91C1C;--green:#047857;--bg:#F4F6F9}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;background:var(--bg);color:var(--ink);padding:34px 26px}
  .wrap{max-width:1080px;margin:0 auto}
  .top{margin-bottom:22px}
  .brand{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#10B981}
  h1{font-size:26px;font-weight:750;margin-top:7px;letter-spacing:-.02em}
  .sub{font-size:14.5px;color:var(--muted);margin-top:6px;line-height:1.5;max-width:820px}
  .strip{display:grid;grid-template-columns:repeat(3,1fr);gap:0;background:#fff;border:1px solid var(--line);border-radius:11px;overflow:hidden;margin:18px 0 6px}
  .cell{padding:15px 20px;border-right:1px solid var(--line)}.cell:last-child{border-right:0}
  .ck{font-size:10.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
  .cv{font-size:27px;font-weight:800;letter-spacing:-.02em;margin-top:6px}
  .cv.red{color:var(--red)}.cv.green{color:var(--green)}
  .cs{font-size:12px;color:var(--muted);margin-top:4px}
  .sec{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-top:18px}
  .sec.red{border-top:3px solid var(--red)}.sec.green{border-top:3px solid var(--green)}.sec.grey{border-top:3px solid #94A3B8}
  .sechd{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap}
  h2{font-size:18px;font-weight:750}
  .count{font-size:13.5px;color:var(--muted);font-weight:600}
  .floor{font-weight:400}
  .secsub{font-size:13.5px;color:var(--muted);margin-top:7px;line-height:1.5;max-width:860px}
  .empty{font-size:14px;color:var(--muted);margin-top:14px;font-style:italic}
  table{width:100%;border-collapse:collapse;margin-top:14px}
  th{font-size:10px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);text-align:left;padding:0 10px 8px 0;border-bottom:1px solid var(--line)}
  td{padding:10px 10px 10px 0;border-bottom:1px solid #F5F7F9;font-size:13px;vertical-align:top;line-height:1.4}
  tr:last-child td{border-bottom:0}
  .acct b{font-weight:700;font-size:13.5px}
  .acct i,.meta i{display:block;font-style:normal;font-size:11.5px;color:var(--muted);margin-top:2px}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;font-weight:650}
  th.num{text-align:right}
  .meta{color:var(--muted);white-space:nowrap}
  .why{color:#334155}
  .owed{display:block;margin-top:5px;color:var(--red);font-size:12px}
  .watch{display:block;margin-top:5px;color:#B45309;font-size:12px}
  .foot{font-size:12.5px;color:var(--muted);margin-top:20px;line-height:1.55;max-width:860px}
  @media print{body{background:#fff;padding:0}.sec{break-inside:auto}tr{break-inside:avoid}}
</style></head><body><div class="wrap">
  <div class="top">
    <div class="brand">DealRipe</div>
    <h1>Every deal, and whether the customer is moving</h1>
    <p class="sub">Week of ${esc(when)}, for Mark Buman. Companion to the Monday digest and built from the same engine, so the two agree. The digest ranks the few that need you most; this is all of them.</p>
  </div>
  <div class="strip">
    <div class="cell"><div class="ck">Gone quiet</div><div class="cv red">${silent.length}</div><div class="cs">nothing from them in ${ACTIVITY_WINDOW_DAYS}+ days and nothing booked</div></div>
    <div class="cell"><div class="ck">Customer moving</div><div class="cv green">${active.length}</div><div class="cs">a meeting booked, a call, or they emailed</div></div>
    <div class="cell"><div class="ck">Cannot tell</div><div class="cv">${unknown.length}</div><div class="cs">reported apart, never counted as quiet</div></div>
  </div>
  ${section(
    "Gone quiet",
    `${SILENCE_CAVEAT} Sorted by how long they have been quiet, longest first.`,
    silent,
    now,
    "red",
  )}
  ${section(
    "The customer is moving",
    "A meeting is on the calendar, or they have spoken to us or emailed us inside the last two weeks. Our own outbound does not count: a rep emailing into silence is the problem, not evidence against it. Deals with nothing booked after the last contact are listed first, because those are the ones still needing a next step.",
    active,
    now,
    "green",
  )}
  ${section(
    "Cannot tell",
    "The calendar or the mailbox could not be read for these, so silence cannot be claimed. Listed rather than folded into either column, because a deal we did not check is not a deal that went quiet.",
    unknown,
    now,
    "grey",
  )}
  <p class="foot">${rows.length} deals in total. Amounts are annualized from Rolldog and are blank where Rolldog carries no size, so every dollar total here is a floor rather than a total. "Agreed and not booked" is checked against the rep's own calendar, so it is the absence of a meeting rather than the absence of a note about one.</p>
</div></body></html>`;

  mkdirSync(".previews", { recursive: true });
  const out = ".previews/monday-activity.html";
  writeFileSync(out, html, "utf8");
  console.log(
    `\n  ${rows.length} deals: ${silent.length} quiet, ${active.length} moving, ${unknown.length} cannot tell`,
  );
  console.log(`  wrote ${out}\n`);
  execFile("open", [out], () => {});
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
