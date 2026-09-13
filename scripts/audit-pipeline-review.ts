/**
 * SOURCE-OF-TRUTH AUDIT of a rendered pipeline review.
 *
 *   npx tsx scripts/audit-pipeline-review.ts
 *   npx tsx scripts/audit-pipeline-review.ts --asof 2026-09-14
 *
 * READ ONLY. Changes nothing and renders nothing.
 *
 * THE REPORT IS THE THING UNDER AUDIT, NOT THE REFERENCE. Every figure here is
 * recomputed from the source tables (calls, transcripts, deal_messages,
 * deals, crm_field_events) and then compared against what the HTML claims.
 * Importing the renderer's own helpers would only prove it agrees with itself.
 *
 * That is a deliberate exception to "a diagnostic imports production logic".
 * That rule exists so a checker cannot drift from the code it checks. Here the
 * code IS the subject, so agreement would be the failure mode.
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { readFileSync } from "node:fs";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const ASOF = arg("--asof") ?? "2026-09-13"; // the report was generated Sep 13 14:08 PT
const SILENT_DAYS = 14;
const MIN_CHARS = 2000;

async function page<T>(t: string, c: string, tid: string | null): Promise<T[]> {
  const db = supabaseAdmin() as any; const o: T[] = [];
  for (let f = 0; ; f += 1000) {
    let q = db.from(t).select(c); if (tid) q = q.eq("tenant_id", tid);
    const r = await q.order("id", { ascending: true }).range(f, f + 999);
    if (r.error) throw new Error(`${t}: ${r.error.message}`);
    o.push(...(r.data ?? [])); if ((r.data ?? []).length < 1000) break;
  } return o;
}
const norm = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const days = (a: string, b: string) => Math.floor((Date.parse(b) - Date.parse(a)) / 86_400_000);

async function main(): Promise<void> {
  const tid = await resolveTenantId("magaya");
  const report = JSON.parse(readFileSync(".previews/audit/sep14.json", "utf8")) as {
    rows: Array<Record<string, string>>;
  };

  const deals = await page<any>("deals", "id, account, rep_email, outcome_label, created_at", tid);
  const calls = await page<any>("calls", "id, deal_id, outcome, call_date, scheduled_start, participants", tid);
  const trs = await page<any>("transcripts", "id, call_id, body", null);
  const msgs = await page<any>("deal_messages", "id, deal_id, direction, customer_side, is_machine_sender, is_calendar_response, sent_at", tid);

  const chars = new Map(trs.map((t: any) => [t.call_id, String(t.body ?? "").length]));
  const at = (c: any) => String(c.call_date ?? c.scheduled_start ?? "").slice(0, 10);
  // The report renders the CRM display name; deals.account holds DealRipe's slug.
  // Exact, then prefix-either-way, so "SEINO LOGIX CO., LTD." finds "Seinologix"
  // without matching two different companies to each other.
  const byAcct = new Map(deals.map((d: any) => [norm(d.account), d]));
  const resolve = (name: string): any | undefined => {
    const n = norm(name);
    if (byAcct.has(n)) return byAcct.get(n);
    const cands = deals.filter((d: any) => {
      const a = norm(d.account);
      return a.length >= 5 && n.length >= 5 && (n.startsWith(a) || a.startsWith(n));
    });
    return cands.length === 1 ? cands[0] : undefined;
  };

  // ---- independent per-deal truth ----
  type Truth = {
    dealId: string; account: string; outcomeLabel: string | null;
    lastCapturedCall: string | null; capturedCalls: number;
    lastCustomerEmail: string | null; customerEmails: number;
    lastRepEmail: string | null; repEmailsSinceCustomer: number;
    lastCustomerActivity: string | null; daysSilent: number | null;
    engaged: boolean; futureMeeting: string | null; futureCaptured: boolean;
  };
  const truth = new Map<string, Truth>();
  for (const d of deals) {
    const cs = calls.filter((c: any) => c.deal_id === d.id);
    const capd = cs.filter((c: any) => (chars.get(c.id) ?? 0) >= MIN_CHARS && at(c) <= ASOF);
    const lastCap = capd.map(at).sort().pop() ?? null;
    const mine = msgs.filter((m: any) => m.deal_id === d.id && !m.is_machine_sender && !m.is_calendar_response);
    const cust = mine.filter((m: any) => m.customer_side === true && String(m.sent_at ?? "").slice(0, 10) <= ASOF);
    const lastCust = cust.map((m: any) => String(m.sent_at).slice(0, 10)).sort().pop() ?? null;
    const out = mine.filter((m: any) => m.direction === "outbound" && String(m.sent_at ?? "").slice(0, 10) <= ASOF);
    const lastRep = out.map((m: any) => String(m.sent_at).slice(0, 10)).sort().pop() ?? null;
    const lastAct = [lastCap, lastCust].filter(Boolean).sort().pop() ?? null;
    const fut = cs.filter((c: any) => at(c) >= ASOF).map(at).sort()[0] ?? null;
    truth.set(d.id, {
      dealId: d.id, account: d.account, outcomeLabel: d.outcome_label,
      lastCapturedCall: lastCap, capturedCalls: capd.length,
      lastCustomerEmail: lastCust, customerEmails: cust.length,
      lastRepEmail: lastRep,
      repEmailsSinceCustomer: lastCust ? out.filter((m: any) => String(m.sent_at).slice(0, 10) > lastCust).length : out.length,
      lastCustomerActivity: lastAct, daysSilent: lastAct ? days(lastAct, ASOF) : null,
      engaged: capd.length > 0 || cust.length > 0,
      futureMeeting: fut, futureCaptured: false,
    });
  }

  // ---- 1. EXECUTIVE METRICS ----
  console.log(`\n${"=".repeat(78)}\n  1. EXECUTIVE METRICS, recomputed from source as of ${ASOF}\n${"=".repeat(78)}`);
  const rows = report.rows;
  const inReport = new Set(rows.map((r) => norm(r.deal)));
  const open = deals.filter((d: any) => !d.outcome_label);
  console.log(`\n  deals with no outcome_label (open) in DB:      ${open.length}`);
  console.log(`  rows rendered in the report:                  ${rows.length}  (+29 named-only tail = ${rows.length + 29})`);
  console.log(`  report claims "162 deals" open pipeline`);
  const matched = rows.filter((r) => Boolean(resolve(r.deal)));
  console.log(`  report rows resolvable to a deal row:         ${matched.length} of ${rows.length}`);

  // engagement truth vs section
  console.log(`\n  ENGAGEMENT CHECK (report section vs source evidence)`);
  let neverButEngaged = 0, silentButRecent = 0, silentButNotEngaged = 0;
  const problems: string[] = [];
  for (const r of rows) {
    const d = resolve(r.deal); if (!d) continue;
    const t = truth.get(d.id)!;
    if (r.section === "Never engaged" && t.engaged) {
      neverButEngaged++;
      problems.push(`    NEVER-ENGAGED but has evidence  ${r.deal.padEnd(30)} calls=${t.capturedCalls} custEmails=${t.customerEmails} last=${t.lastCustomerActivity}`);
    }
    if (r.section === "Gone silent") {
      if (!t.engaged) { silentButNotEngaged++; problems.push(`    GONE-SILENT but never engaged   ${r.deal.padEnd(30)} calls=0 custEmails=0`); }
      else if (t.daysSilent !== null && t.daysSilent < SILENT_DAYS) {
        silentButRecent++;
        problems.push(`    GONE-SILENT but active <14d     ${r.deal.padEnd(30)} last customer activity ${t.lastCustomerActivity} (${t.daysSilent}d)`);
      }
    }
  }
  console.log(`    never-engaged rows that DO have evidence:   ${neverButEngaged}`);
  console.log(`    gone-silent rows with activity < 14 days:   ${silentButRecent}`);
  console.log(`    gone-silent rows that never engaged:        ${silentButNotEngaged}`);
  for (const p of problems.slice(0, 30)) console.log(p);

  // ---- silence-day claims ----
  console.log(`\n${"=".repeat(78)}\n  5. TIME-SENSITIVE CLAIMS: "Nd silent" vs source\n${"=".repeat(78)}\n`);
  let ok = 0, off = 0;
  const bad: string[] = [];
  for (const r of rows) {
    const m = /(\d+)d silent/.exec(r.status); if (!m) continue;
    const d = resolve(r.deal); if (!d) continue;
    const t = truth.get(d.id)!;
    const claimed = Number(m[1]);
    if (t.daysSilent === null) { bad.push(`    ${r.deal.padEnd(30)} claims ${claimed}d silent, source has NO customer activity ever`); off++; continue; }
    const delta = Math.abs(claimed - t.daysSilent);
    if (delta <= 1) ok++; else { off++; bad.push(`    ${r.deal.padEnd(30)} claims ${String(claimed).padStart(3)}d, source says ${String(t.daysSilent).padStart(3)}d (last ${t.lastCustomerActivity})  Δ${delta}`); }
  }
  console.log(`    silence claims within 1 day of source: ${ok}`);
  console.log(`    silence claims off by 2+ days:         ${off}\n`);
  for (const b of bad.slice(0, 25)) console.log(b);

  // ---- "0 replies" is a hardcoded literal, not a measurement ----
  // lib/activity-report.ts:1028 prints "&middot; 0 replies" unconditionally on
  // every quiet row. It is TRUE BY CONSTRUCTION, because chases counts only
  // outbound since the last inbound, so a reply would have reset it. It is
  // still worth naming: it cannot ever be nonzero, and a reader takes it as a
  // lifetime count on deals that have replied many times.
  const withLifetime: string[] = [];
  for (const r of rows) {
    if (!/0 replies/.test(r.status)) continue;
    const d = resolve(r.deal); if (!d) continue;
    const t = truth.get(d.id)!;
    if (t.customerEmails >= 3) withLifetime.push(`    ${r.deal.padEnd(30)} prints "0 replies"; this customer has written ${t.customerEmails} times, last ${t.lastCustomerEmail}`);
  }
  console.log(`\n  "0 REPLIES" is hardcoded at activity-report.ts:1028`);
  console.log(`    rows printing it: ${rows.filter((r) => /0 replies/.test(r.status)).length}`);
  console.log(`    of those, customers who have actually written 3+ times: ${withLifetime.length}`);
  for (const b of withLifetime.slice(0, 12)) console.log(b);

  // ---- future meetings vs next step ----
  console.log(`\n${"=".repeat(78)}\n  6. NEXT-STEP vs CALENDAR\n${"=".repeat(78)}\n`);
  const futs: string[] = [];
  for (const r of rows) {
    const d = resolve(r.deal); if (!d) continue;
    const t = truth.get(d.id)!;
    const saysNone = /^None/i.test(r.next) || r.next.trim() === "None";
    const saysBooked = /^Booked/i.test(r.next.trim());
    if (t.futureMeeting && saysNone) futs.push(`    FUTURE MEETING, next step NONE   ${r.deal.padEnd(28)} meeting ${t.futureMeeting}  [${r.section}]`);
    if (!t.futureMeeting && saysBooked) futs.push(`    SAYS BOOKED, no future meeting   ${r.deal.padEnd(28)} ${r.next}  [${r.section}]`);
  }
  console.log(`    contradictions found: ${futs.length}\n`);
  for (const f of futs.slice(0, 30)) console.log(f);

  // ---- 7. OCCURRENCE vs CONTENT: does an unverifiable meeting reset silence? ----
  console.log(`\n${"=".repeat(78)}\n  7. OCCURRENCE vs CONTENT: silence clock reset by an unverified meeting\n${"=".repeat(78)}\n`);
  const resets: string[] = [];
  for (const r of rows) {
    const d = resolve(r.deal); if (!d) continue;
    const t = truth.get(d.id)!;
    const m = /(\d+)d silent/.exec(r.status); if (!m) continue;
    // The most recent NON-no-show call, which is what lastConversationAt uses.
    const cs = calls.filter((c: any) => c.deal_id === d.id && at(c) <= ASOF
      && !["no_conversation", "no_show"].includes(String(c.outcome ?? "")));
    const lastAny = cs.map(at).sort().pop() ?? null;
    const capd = (chars.get((cs.find((c: any) => at(c) === lastAny) ?? {}).id) ?? 0) >= MIN_CHARS;
    if (lastAny && !capd && t.lastCustomerActivity && lastAny > t.lastCustomerActivity) {
      resets.push(`    ${r.deal.padEnd(28)} silence counted from ${lastAny} (UNCAPTURED call), real evidence ends ${t.lastCustomerActivity}  claim=${m[1]}d real=${days(t.lastCustomerActivity, ASOF)}d`);
    }
  }
  console.log(`    rows whose silence clock is reset by a call with no transcript: ${resets.length}\n`);
  for (const x of resets) console.log(x);

  console.log("");
}
main().catch((e) => { console.error("Unexpected error:", e.message ?? e); process.exit(1); });
