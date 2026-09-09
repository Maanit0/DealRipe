/**
 * Census of the micro outcomes DealRipe can actually evidence, and what
 * preceded them.
 *
 *   npx tsx scripts/micro-outcomes.ts
 *   npx tsx scripts/micro-outcomes.ts --window 7
 *   npx tsx scripts/micro-outcomes.ts --kind nda_executed
 *
 * READ ONLY. Prints counts and evidence strings, never customer prose.
 *
 * TWO QUESTIONS, and only the first is answered honestly today.
 *
 * HOW MANY are there. This is the argument for micro outcomes at all: if a
 * demo-after-discovery happens 40 times and a close happens 26 times ever, the
 * first is a learnable unit and the second is not.
 *
 * WHAT PRECEDED THEM. For each outcome, what DealRipe observed in the days
 * before it: a call, a prescription issued, a rep email, a customer reply.
 * This is a CO-OCCURRENCE COUNT and not a cause. A rep emails before almost
 * everything, so "a rep email preceded 90% of demos booked" says nothing until
 * it is compared against the deals where a rep emailed and no demo followed.
 * That comparison needs the prescription ledger joined to what the buyer did
 * next, and it is the half that does not exist yet.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { detectMicroOutcomes, type MicroOutcome } from "../lib/micro-outcomes";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function pageAll<T>(table: string, cols: string, tenantId: string): Promise<T[]> {
  const db = supabaseAdmin() as unknown as { from: (t: string) => { select: (c: string) => unknown } };
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: unknown = db.from(table).select(cols);
    q = (q as { eq: (a: string, b: string) => unknown }).eq("tenant_id", tenantId);
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
  const windowDays = Number(arg("--window") ?? 7);
  const onlyKind = arg("--kind");

  const all = await detectMicroOutcomes(tenantId);
  const outcomes = onlyKind ? all.filter((o) => o.kind === onlyKind) : all;

  const byKind = new Map<string, MicroOutcome[]>();
  for (const o of all) byKind.set(o.kind, [...(byKind.get(o.kind) ?? []), o]);

  console.log("\n================ MICRO OUTCOME CENSUS ================\n");
  console.log("  kind                        count   deals   first        last");
  console.log("  " + "-".repeat(66));
  for (const [kind, list] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const deals = new Set(list.map((o) => o.dealId)).size;
    console.log(
      `  ${kind.padEnd(26)} ${String(list.length).padStart(5)}  ${String(deals).padStart(6)}   ` +
        `${list[0].occurredAt.slice(0, 10)}   ${list[list.length - 1].occurredAt.slice(0, 10)}`,
    );
  }
  const macro = (byKind.get("closed_won")?.length ?? 0) + (byKind.get("closed_lost")?.length ?? 0);
  console.log(
    `\n  micro outcomes: ${all.length - macro}    macro outcomes: ${macro}\n` +
      `  That ratio is the whole argument: the macro column cannot be learned from\n` +
      `  this year, and five of the losses are one hygiene sweep.`,
  );

  // --- what preceded them -------------------------------------------------
  const [calls, msgs, rx] = await Promise.all([
    pageAll<{ id: string; deal_id: string; call_date: string | null; scheduled_start: string | null }>(
      "calls",
      "id, deal_id, call_date, scheduled_start",
      tenantId,
    ),
    pageAll<{ id: string; deal_id: string; direction: string; customer_side: boolean | null; is_machine_sender: boolean | null; is_calendar_response: boolean; sent_at: string | null }>(
      "deal_messages",
      "id, deal_id, direction, customer_side, is_machine_sender, is_calendar_response, sent_at",
      tenantId,
    ),
    pageAll<{ id: string; deal_id: string; created_at: string }>("prescribed_actions", "id, deal_id, created_at", tenantId),
  ]);

  /**
   * STRICTLY BEFORE, AND NEVER THE OUTCOME'S OWN ROW.
   *
   * The first version counted any event at or before the outcome, which made
   * "meeting_booked" show 100% "had a call" and "reengaged_after_silence" show
   * 100% "customer reply". Both are definitional: a booked meeting IS a call
   * row and a re-engagement IS a customer reply, so each outcome was being
   * reported as its own antecedent.
   *
   * A 100% column is almost never a discovery. It is usually the measurement
   * eating itself.
   */
  const precedes = (o: MicroOutcome, t: string | null, rowId: string, table: string) => {
    if (!t) return false;
    if (table === o.source.table && rowId === o.source.id) return false;
    const d = (Date.parse(o.occurredAt) - Date.parse(t)) / 86_400_000;
    return d > 0 && d <= windowDays;
  };

  console.log(`\n================ WHAT PRECEDED THEM (${windowDays}d window) ================\n`);
  console.log("  kind                        n     had call  rep email  cust reply  prescription");
  console.log("  " + "-".repeat(80));
  for (const [kind, list] of [...byKind.entries()].sort((a, b) => b[1].length - a[1].length)) {
    if (onlyKind && kind !== onlyKind) continue;
    let c = 0;
    let re = 0;
    let cr = 0;
    let p = 0;
    for (const o of list) {
      const dc = calls.filter((x) => x.deal_id === o.dealId);
      const dm = msgs.filter((x) => x.deal_id === o.dealId && !x.is_calendar_response && !x.is_machine_sender);
      const dp = rx.filter((x) => x.deal_id === o.dealId);
      if (dc.some((x) => precedes(o, x.call_date ?? x.scheduled_start, x.id, "calls"))) c += 1;
      if (dm.some((x) => x.direction === "outbound" && precedes(o, x.sent_at, x.id, "deal_messages"))) re += 1;
      if (dm.some((x) => x.direction === "inbound" && x.customer_side === true && precedes(o, x.sent_at, x.id, "deal_messages"))) cr += 1;
      if (dp.some((x) => precedes(o, x.created_at, x.id, "prescribed_actions"))) p += 1;
    }
    const pct = (x: number) => `${String(Math.round((x / list.length) * 100)).padStart(3)}%`;
    console.log(
      `  ${kind.padEnd(26)} ${String(list.length).padStart(4)}   ${pct(c)}      ${pct(re)}       ${pct(cr)}        ${pct(p)}`,
    );
  }

  console.log(
    `\n  CO-OCCURRENCE, NOT CAUSE. A rep emails before almost everything, so a high\n` +
      `  column here is a base rate until it is compared against the deals where the\n` +
      `  same thing happened and the outcome did NOT follow. That comparison is the\n` +
      `  half of the loop that is still missing.\n`,
  );

  if (onlyKind) {
    console.log(`  first 15 ${onlyKind} events:\n`);
    for (const o of outcomes.slice(0, 15)) {
      console.log(`    ${o.occurredAt.slice(0, 10)}  ${o.evidence}   [${o.source.table}]`);
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
