/**
 * Which CUSTOMER VERIFIABLE OUTCOMES actually predict progression at Magaya.
 *
 *   npx tsx scripts/magaya-cvos.ts
 *
 * READ ONLY. Counts and rates, no customer text.
 *
 * A CVO is a thing the BUYER did that can be pointed at: they invited the
 * decision maker, they reviewed the collateral, they went into contract review
 * and redlines came back. Not "the rep says they are interested". The claim
 * attached to it is that stage advancement should rest on these rather than on
 * a rep's assertion, and that a forecast without them cannot be accurate.
 *
 * That is the same split lib/deal-journey.ts already carries as `authorship`,
 * and this codebase has independent evidence for it: on comparable observation
 * windows every buyer signal correlated NEGATIVELY with stage_advanced, which is
 * rep bookkeeping, and sensibly with nda_executed, which Adobe Sign asserts.
 *
 * WHAT THIS DOES NOT DO. It does not assume the canonical CVO examples transfer
 * to Magaya. Every candidate below is measured against what actually happened
 * next, with its fire rate printed beside its lift, because a CVO that fires on
 * most of the book cannot advance a stage any more than a rep's opinion can.
 *
 * THE OUTCOME IS ANOTHER CAPTURED MEETING. Not won: 10 wins against 20 losses,
 * five of the losses one hygiene sweep. Not stage movement: that is the rep
 * updating Salesforce, and using it here would measure bookkeeping.
 *
 * EVERY CANDIDATE IS BUYER OR SYSTEM AUTHORED. A rep sending a proposal is not
 * a CVO. The customer sending one back is.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const MIN_CONVERSATION_CHARS = 2000;
/** Below this a candidate is reported but never ranked. */
const MIN_FIRE = 5;

async function page<T>(table: string, cols: string, tenantId: string | null): Promise<T[]> {
  const db = supabaseAdmin() as unknown as { from: (t: string) => { select: (c: string) => unknown } };
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: unknown = db.from(table).select(cols);
    if (tenantId) q = (q as { eq: (a: string, b: string) => unknown }).eq("tenant_id", tenantId);
    q = (q as { order: (c: string, o: unknown) => unknown }).order("id", { ascending: true });
    q = (q as { range: (a: number, b: number) => unknown }).range(from, from + 999);
    const res = (await (q as Promise<{ data: T[] | null; error: { message: string } | null }>));
    if (res.error) throw new Error(`${table} read failed: ${res.error.message}`);
    const rows = res.data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const day = (s: unknown) => String(s ?? "").slice(0, 10);

  const calls = await page<{ id: string; deal_id: string; call_date: string | null; scheduled_start: string | null; call_subtype: string | null; participants: unknown }>(
    "calls", "id, deal_id, call_date, scheduled_start, call_subtype, participants", tenantId);
  const trs = await page<{ call_id: string; body: string | null }>("transcripts", "id, call_id, body", null);
  const chars = new Map(trs.map((t) => [t.call_id, String(t.body ?? "").length]));
  const msgs = await page<{ deal_id: string; direction: string; customer_side: boolean | null; is_machine_sender: boolean | null; is_calendar_response: boolean; sent_at: string | null; body_trimmed: string | null; agreement_kind: string | null; agreement_state: string | null; to_emails: string[] | null; cc_emails: string[] | null }>(
    "deal_messages",
    "id, deal_id, direction, customer_side, is_machine_sender, is_calendar_response, sent_at, body_trimmed, agreement_kind, agreement_state, to_emails, cc_emails",
    tenantId);
  const atts = await page<{ deal_id: string | null; direction: string | null; classification: string | null; first_seen_at: string }>(
    "deal_attachments", "id, deal_id, direction, classification, first_seen_at", tenantId);

  const at = (c: { call_date: string | null; scheduled_start: string | null }) => day(c.call_date ?? c.scheduled_start);
  const byDeal = new Map<string, typeof calls>();
  for (const c of calls) if (at(c)) byDeal.set(c.deal_id, [...(byDeal.get(c.deal_id) ?? []), c]);

  // The cohort: a captured first conversation, and a 30-day window after it.
  // Everything is measured INSIDE that window, so a CVO always precedes the
  // outcome it is being scored against.
  type Row = { dealId: string; t0: number; t1: number; progressed: boolean; cvo: Record<string, boolean> };
  const rows: Row[] = [];

  for (const [dealId, cs] of byDeal) {
    const real = cs.filter((c) => (chars.get(c.id) ?? 0) >= MIN_CONVERSATION_CHARS && at(c))
      .sort((a, b) => at(a).localeCompare(at(b)));
    if (real.length === 0) continue;
    const first = real[0];
    const t0 = Date.parse(at(first));
    const t1 = t0 + 30 * 86_400_000;
    const inWin = (d: unknown) => {
      const x = Date.parse(String(d ?? ""));
      return Number.isFinite(x) && x > t0 && x <= t1;
    };

    const mine = msgs.filter((m) => m.deal_id === dealId && !m.is_machine_sender && !m.is_calendar_response);
    const inbound = mine.filter((m) => m.customer_side === true && inWin(m.sent_at));
    const dealAtts = atts.filter((a) => a.deal_id === dealId && inWin(a.first_seen_at));

    // Customer-side people on the first call versus any later call in window.
    const people = (c: (typeof calls)[number]) =>
      (Array.isArray(c.participants) ? (c.participants as Array<{ email?: string | null }>) : [])
        .map((p) => String(p?.email ?? "").toLowerCase())
        .filter((e) => e && !e.endsWith("@magaya.com"));
    const firstRoster = new Set(people(first));
    const laterRoster = new Set(real.filter((c) => Date.parse(at(c)) > t0 && Date.parse(at(c)) <= t1).flatMap(people));
    void firstRoster; void laterRoster; // see the unscored candidate below

    // An executed agreement is SYSTEM authored: Adobe Sign asserts it and
    // neither side can edit it. The strongest evidence class available.
    const executed = mine.some((m) => m.agreement_state === "executed" && inWin(m.sent_at));
    const agreementOut = mine.some((m) => m.agreement_kind && inWin(m.sent_at));

    rows.push({
      dealId, t0, t1,
      progressed: real.some((c) => Date.parse(at(c)) > t0 && Date.parse(at(c)) <= t1),
      cvo: {
        "customer replied at all": inbound.length > 0,
        "customer replied 3+ times": inbound.length >= 3,
        "customer replied within 48h of the call": inbound.some((m) => Date.parse(String(m.sent_at)) <= t0 + 2 * 86_400_000),
        "customer wrote 400+ characters": inbound.some((m) => (m.body_trimmed ?? "").length >= 400),
        "customer asked a question in writing": inbound.some((m) => (m.body_trimmed ?? "").includes("?")),
        "customer SENT US a document": dealAtts.some((a) => a.direction === "inbound"),
        "an agreement went out": agreementOut,
        "AGREEMENT CAME BACK EXECUTED": executed,
        // DELIBERATELY NOT SCORED AGAINST THIS OUTCOME. "A new person joined a
        // LATER CALL" presupposes a later call, so it scores 100% by
        // construction: the measurement contains the thing it measures. The
        // first run reported +83pp and it was a tautology.
        //
        // It is a real CVO and probably a strong one, and it is exactly
        // Richard's "invited the decision maker into the meeting". Scoring it
        // needs an outcome that does not include the meeting itself: a THIRD
        // conversation, an executed agreement, or a close. Kept here, unscored,
        // rather than deleted, so the next person does not re-derive it and
        // report the same 100%.
        //
        // Its email-side twin below is NOT circular and is measurable now.
        // "a NEW customer person joined a later call": newPerson,
        "customer brought someone new onto the thread": (() => {
          const early = new Set(mine.filter((m) => Date.parse(String(m.sent_at)) <= t0).flatMap((m) => [...(m.to_emails ?? []), ...(m.cc_emails ?? [])].map((e) => e.toLowerCase())));
          const late = new Set(inbound.flatMap((m) => [...(m.to_emails ?? []), ...(m.cc_emails ?? [])].map((e) => e.toLowerCase())));
          return early.size > 0 && [...late].some((e) => !early.has(e) && !e.endsWith("@magaya.com"));
        })(),
      },
    });
  }

  const base = rows.filter((r) => r.progressed).length / rows.length;
  const pct = (x: number) => `${String(Math.round(x * 100)).padStart(3)}%`;
  const names = Object.keys(rows[0]?.cvo ?? {});

  const scored = names.map((n) => {
    const yes = rows.filter((r) => r.cvo[n]);
    const no = rows.filter((r) => !r.cvo[n]);
    const py = yes.length ? yes.filter((r) => r.progressed).length / yes.length : 0;
    const pn = no.length ? no.filter((r) => r.progressed).length / no.length : 0;
    return { n, fires: yes.length, rate: yes.length / rows.length, py, pn, lift: py - pn };
  });

  console.log(`\n  ${rows.length} deals with a captured conversation. Base rate: ${pct(base)} saw another meeting inside 30 days.\n`);
  console.log(`  CANDIDATE CVO                                fires  of book   with   without   lift`);
  console.log("  " + "-".repeat(88));
  for (const s of scored.filter((s) => s.fires >= MIN_FIRE).sort((a, b) => b.lift - a.lift)) {
    const flag = s.rate > 0.8 ? "  fires on too much of the book to gate a stage" : "";
    console.log(
      `  ${s.n.padEnd(44)} ${String(s.fires).padStart(4)} ${pct(s.rate)}   ${pct(s.py)}   ${pct(s.pn)}   ${(s.lift >= 0 ? "+" : "") + Math.round(s.lift * 100)}pp${flag}`,
    );
  }
  const thin = scored.filter((s) => s.fires < MIN_FIRE);
  if (thin.length) {
    console.log(`\n  too thin to rank (under ${MIN_FIRE} occurrences), reported rather than dropped:`);
    for (const s of thin) console.log(`    ${s.n.padEnd(44)} fires ${s.fires}`);
  }
  console.log(
    `\n  A CVO has to do BOTH: separate the outcome AND fire on a minority of deals.\n` +
      `  One that fires on most of the book cannot gate a stage any more than a rep's opinion can.\n`,
  );
}

main().catch((e) => { console.error("Unexpected error:", e); process.exit(1); });
