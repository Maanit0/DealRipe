/**
 * What ACTUALLY changed between two Mondays, measured from the source tables.
 *
 *   npx tsx scripts/week-over-week.ts
 *   npx tsx scripts/week-over-week.ts --from 2026-09-07 --to 2026-09-14
 *
 * READ ONLY.
 *
 * WHY. Two consecutive pipeline reviews look similar, and "similar" has two
 * very different causes: the week really was quiet, or the report is not
 * tracking the week. Nothing in either report distinguishes them, so this
 * counts the underlying events directly and independently of the renderer.
 *
 * Every source the review claims to read gets counted separately, because a
 * report that moves while one channel is silent is a different fact from one
 * that moves while all of them are.
 */
import { config } from "dotenv"; config({ path: ".env.local" });
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };

/** PostgREST silently caps a plain select at 1000. */
async function page<T>(table: string, cols: string, tenantId: string | null, extra?: (q: any) => any): Promise<T[]> {
  const db = supabaseAdmin() as any; const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from(table).select(cols);
    if (tenantId) q = q.eq("tenant_id", tenantId);
    if (extra) q = extra(q);
    q = q.order("id", { ascending: true }).range(from, from + 999);
    const res = await q;
    if (res.error) throw new Error(`${table}: ${res.error.message}`);
    out.push(...(res.data ?? [])); if ((res.data ?? []).length < 1000) break;
  }
  return out;
}

async function main(): Promise<void> {
  const from = arg("--from") ?? "2026-09-07";
  const to = arg("--to") ?? "2026-09-14";
  const prevFrom = new Date(Date.parse(from) - 7 * 864e5).toISOString().slice(0, 10);
  const tenantId = await resolveTenantId("magaya");
  const inWin = (d: unknown, a: string, b: string) => {
    const s = String(d ?? ""); return s >= a && s < b;
  };

  console.log(`\n  WEEK OVER WEEK, from the source tables`);
  console.log(`  this week ${from} to ${to}   (previous ${prevFrom} to ${from})\n`);

  // 1. CONVERSATIONS
  const calls = await page<any>("calls", "id, deal_id, outcome, call_date, scheduled_start, call_subtype, created_at", tenantId);
  const trs = await page<any>("transcripts", "id, call_id, body", null);
  const chars = new Map(trs.map((t: any) => [t.call_id, String(t.body ?? "").length]));
  const at = (c: any) => String(c.call_date ?? c.scheduled_start ?? "").slice(0, 10);
  const real = (c: any) => (chars.get(c.id) ?? 0) >= 2000;

  const row = (label: string, now: number, prev: number) => {
    const d = now - prev;
    console.log(`    ${label.padEnd(42)} ${String(now).padStart(5)}   (prev ${String(prev).padStart(4)}, ${d >= 0 ? "+" : ""}${d})`);
  };

  console.log("  CONVERSATIONS");
  row("meetings scheduled in window", calls.filter((c) => inWin(at(c), from, to)).length,
      calls.filter((c) => inWin(at(c), prevFrom, from)).length);
  row("captured with a real transcript", calls.filter((c) => inWin(at(c), from, to) && real(c)).length,
      calls.filter((c) => inWin(at(c), prevFrom, from) && real(c)).length);
  row("capture failed / no media", calls.filter((c) => inWin(at(c), from, to) && c.outcome === "capture_failed").length,
      calls.filter((c) => inWin(at(c), prevFrom, from) && c.outcome === "capture_failed").length);
  const dealsWithCall = new Set(calls.filter((c) => inWin(at(c), from, to) && real(c)).map((c) => c.deal_id));
  const dealsPrev = new Set(calls.filter((c) => inWin(at(c), prevFrom, from) && real(c)).map((c) => c.deal_id));
  row("distinct deals with a captured call", dealsWithCall.size, dealsPrev.size);

  // 2. EMAIL
  const msgs = await page<any>("deal_messages", "id, deal_id, direction, customer_side, is_machine_sender, is_calendar_response, sent_at", tenantId);
  const human = (m: any) => !m.is_machine_sender && !m.is_calendar_response;
  console.log("\n  EMAIL");
  row("inbound from customers", msgs.filter((m) => human(m) && m.customer_side === true && inWin(m.sent_at, from, to)).length,
      msgs.filter((m) => human(m) && m.customer_side === true && inWin(m.sent_at, prevFrom, from)).length);
  row("outbound from reps", msgs.filter((m) => human(m) && m.direction === "outbound" && inWin(m.sent_at, from, to)).length,
      msgs.filter((m) => human(m) && m.direction === "outbound" && inWin(m.sent_at, prevFrom, from)).length);
  const repliedDeals = new Set(msgs.filter((m) => human(m) && m.customer_side === true && inWin(m.sent_at, from, to)).map((m) => m.deal_id));
  const repliedPrev = new Set(msgs.filter((m) => human(m) && m.customer_side === true && inWin(m.sent_at, prevFrom, from)).map((m) => m.deal_id));
  row("distinct deals a customer wrote on", repliedDeals.size, repliedPrev.size);

  // 3. CALENDAR
  try {
    const rsvp = await page<any>("calendar_response_events", "id, deal_id, to_response, observed_at", tenantId);
    console.log("\n  CALENDAR (RSVP)");
    row("RSVP changes observed", rsvp.filter((r) => inWin(r.observed_at, from, to)).length,
        rsvp.filter((r) => inWin(r.observed_at, prevFrom, from)).length);
  } catch (e) { console.log("\n  CALENDAR (RSVP): unavailable —", (e as Error).message); }

  // 4. CRM
  try {
    const fe = await page<any>("crm_field_events", "id, field, changed_at, opportunity_id", tenantId);
    console.log("\n  CRM FIELD HISTORY (Salesforce)");
    row("field changes in window", fe.filter((r) => inWin(r.changed_at, from, to)).length,
        fe.filter((r) => inWin(r.changed_at, prevFrom, from)).length);
    const byField = new Map<string, number>();
    for (const r of fe.filter((r: any) => inWin(r.changed_at, from, to))) byField.set(r.field, (byField.get(r.field) ?? 0) + 1);
    for (const [f, n] of [...byField].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`      ${f.padEnd(38)} ${n}`);
  } catch (e) { console.log("\n  CRM FIELD HISTORY: unavailable —", (e as Error).message); }

  // 5. GATES
  try {
    const ge = await page<any>("field_extraction_events", "id, deal_id, framework_field_key, observed_at, to_status", tenantId);
    console.log("\n  QUALIFICATION GATES");
    row("gate transitions recorded", ge.filter((r) => inWin(r.observed_at, from, to)).length,
        ge.filter((r) => inWin(r.observed_at, prevFrom, from)).length);
  } catch (e) { console.log("\n  QUALIFICATION GATES: unavailable —", (e as Error).message); }

  // 6. OUTCOMES + DEAL CREATION
  const deals = await page<any>("deals", "id, account, created_at, outcome_label, outcome_recorded_at", tenantId);
  console.log("\n  DEALS");
  row("new deals created", deals.filter((d) => inWin(d.created_at, from, to)).length,
      deals.filter((d) => inWin(d.created_at, prevFrom, from)).length);
  const closedNow = deals.filter((d) => d.outcome_label && inWin(d.outcome_recorded_at, from, to));
  row("labelled won/lost", closedNow.length,
      deals.filter((d) => d.outcome_label && inWin(d.outcome_recorded_at, prevFrom, from)).length);
  if (closedNow.length) {
    console.log(`      ${closedNow.map((d: any) => `${d.account}=${d.outcome_label}`).join(", ")}`);
  }
  console.log(`\n  total deals now: ${deals.length}, of which labelled: ${deals.filter((d) => d.outcome_label).length}\n`);
}

main().catch((e) => { console.error("Unexpected error:", e.message ?? e); process.exit(1); });
