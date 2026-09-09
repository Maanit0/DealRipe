/**
 * What the action-outcome dataset actually contains, per source and per deal.
 *
 *   npx tsx scripts/trajectory-coverage.ts
 *   npx tsx scripts/trajectory-coverage.ts --deal <uuid>
 *   npx tsx scripts/trajectory-coverage.ts --thin       # only deals missing something
 *
 * READ ONLY.
 *
 * WHY THIS EXISTS. Seven ledger families now write to Supabase and each one can
 * be empty for a completely different reason. Without a single honest read of
 * coverage, "the trajectory is backfilled" is a belief rather than a
 * measurement, and this codebase's dominant failure mode is exactly that:
 * treating absence of evidence as evidence of absence.
 *
 * THE COLUMN THAT MATTERS IS "recoverable". Three of these families have no
 * history to recover and never will:
 *
 *   gate transitions   field_extractions was upserted for six weeks, so every
 *                      answer is a tombstone over its own history. The seed is
 *                      a floor, not a past.
 *   checklist ticks    Rolldog exposes current state and has no history
 *                      endpoint. Same shape.
 *   RSVP               calls.participants was overwritten on every five-minute
 *                      sync, so only what happens from now on exists.
 *
 * Two are fully recoverable and one is partly:
 *
 *   CRM field history  Salesforce kept it back to 2025-02-19, including a
 *                      pre-pilot baseline. Recoverable until retention expires.
 *   calls/transcripts  stored since the pilot began.
 *   email bodies       recoverable from Graph EXCEPT where the message was
 *                      deleted, which is recorded as 'gone' and is permanent.
 *
 * Printing those side by side is the point. A dataset that says "0 RSVP events
 * before today" is complete and correct; one that says "0 CRM field events" is
 * a backfill nobody ran.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

/**
 * This script walks eleven tables by NAME, so the generated per-table types
 * fight it at every call. One honest untyped handle beats a cast at each of
 * thirty call sites pretending to be type safety it does not have. Everything
 * it reads is checked at runtime below.
 */
type Loose = {
  from: (t: string) => {
    select: (
      cols: string,
      opts?: { count?: "exact"; head?: boolean },
    ) => {
      eq: (a: string, b: string) => unknown;
      order: (c: string, o: { ascending: boolean }) => unknown;
      range: (a: number, b: number) => unknown;
    } & PromiseLike<{ data: unknown[] | null; count: number | null; error: { message: string } | null }>;
  };
};

function loose(): Loose {
  return supabaseAdmin() as unknown as Loose;
}

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Res = { data: unknown[] | null; count: number | null; error: { message: string } | null };

/**
 * Count rows honestly. PostgREST caps a plain select at 1000 and says nothing,
 * which produced three confidently wrong numbers in one afternoon, so every
 * count here is a head+exact count and a failed count is REPORTED rather than
 * defaulted to zero. A zero that is really an error is the whole problem this
 * script exists to expose.
 */
async function countOf(table: string, tenantId: string | null): Promise<number | string> {
  let q: unknown = loose().from(table).select("id", { count: "exact", head: true });
  if (tenantId) q = (q as { eq: (a: string, b: string) => unknown }).eq("tenant_id", tenantId);
  const res = (await (q as PromiseLike<Res>)) as Res;
  if (res.error) return `ERR ${res.error.message.slice(0, 46)}`;
  if (res.count === null) return "ERR count was null";
  return res.count;
}

/** Page through a table without the 1000-row cap silently truncating it. */
async function pageAll<T>(table: string, cols: string, tenantId: string | null): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: unknown = loose().from(table).select(cols);
    if (tenantId) q = (q as { eq: (a: string, b: string) => unknown }).eq("tenant_id", tenantId);
    q = (q as { order: (c: string, o: { ascending: boolean }) => unknown }).order("id", { ascending: true });
    q = (q as { range: (a: number, b: number) => unknown }).range(from, from + 999);
    const res = (await (q as PromiseLike<Res>)) as Res;
    if (res.error) throw new Error(`${table} read failed: ${res.error.message}`);
    const rows = (res.data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

async function main(): Promise<void> {
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");
  const onlyDeal = arg("--deal");
  const thin = process.argv.includes("--thin");

  console.log("\n================ LEDGER COVERAGE, tenant magaya ================\n");
  console.log("  family                     rows    recoverable history?");
  console.log("  --------------------------------------------------------------");
  const families: Array<[string, string, string]> = [
    ["calls", "calls", "yes, stored since the pilot began"],
    ["transcripts", "transcripts", "yes"],
    ["deal_messages", "deal_messages", "metadata yes; bodies except where deleted"],
    ["field_extractions", "field_extractions", "current state only"],
    ["field_extraction_events", "field_extraction_events", "NO - upserted for six weeks, seed is a floor"],
    ["rolldog_gate_events", "rolldog_gate_events", "NO - Rolldog has no history endpoint"],
    ["rolldog_checklist_reads", "rolldog_checklist_reads", "NO - same"],
    ["calendar_response_events", "calendar_response_events", "NO - participants was overwritten every 5 min"],
    ["crm_field_events", "crm_field_events", "YES - Salesforce kept it back to 2025-02-19"],
    ["prescribed_actions", "prescribed_actions", "yes, since 2026-08-16"],
    ["deal_signal_snapshots", "deal_signal_snapshots", "partial - 5 of 6 daily readings were upserted away"],
  ];
  for (const [label, table, recoverable] of families) {
    const n = await countOf(table, table === "transcripts" ? null : tenantId);
    console.log(`  ${label.padEnd(26)} ${String(n).padStart(6)}    ${recoverable}`);
  }

  // Email body recovery, which is the one number that says whether the
  // expensive backfill is finished.
  console.log("\n  email bodies");
  const msgs = await pageAll<{ body_status: string | null; body_chars: number | null }>(
    "deal_messages",
    "id, body_status, body_chars",
    tenantId,
  );
  const bs: Record<string, number> = {};
  for (const m of msgs) bs[m.body_status ?? "(null, never considered)"] = (bs[m.body_status ?? "(null, never considered)"] ?? 0) + 1;
  for (const [k, v] of Object.entries(bs).sort((a, b) => b[1] - a[1])) {
    const note =
      k === "gone" ? "   <- deleted from the mailbox, PERMANENT"
      : k === "not_fetched" ? "   <- backfill unfinished, re-run it"
      : k === "skipped" ? "   <- machine sender or calendar response, deliberate"
      : "";
    console.log(`    ${k.padEnd(26)} ${String(v).padStart(6)}${note}`);
  }
  const withBody = msgs.filter((m) => m.body_status === "stored" || m.body_status === "truncated").length;
  const eligible = msgs.filter((m) => m.body_status !== "skipped").length;
  console.log(`    recovery rate:             ${eligible > 0 ? Math.round((withBody / eligible) * 100) : 0}% of eligible messages`);

  // ================================================================
  // THE DISTINCTION THAT MATTERS MOST, AND THE EASIEST ONE TO LOSE.
  // ================================================================
  //
  // Salesforce history goes back to 2025. DealRipe's first captured call was
  // 2026-07-16. Those are DIFFERENT DATASETS and mixing them produces exactly
  // the claim CLAUDE.md already warns about with the 163 closed opportunities:
  // a prior about Magaya's business is not evidence DealRipe changed anything.
  //
  // A deal's observation window opens at its FIRST CAPTURED CONVERSATION, not
  // at the pilot start and not at the deal's creation. A deal created in
  // February whose first call we captured in August has six months of CRM
  // history that is Magaya's, not ours.
  //
  // 2000 chars is the conversation threshold used everywhere else here: a
  // no-show still produces a transcript of joining noise, and it passes any
  // length check that is not this one.
  console.log("\n================ OBSERVATION WINDOW ================\n");
  const MIN_CONVERSATION_CHARS = 2000;
  const callRows = await pageAll<{ id: string; deal_id: string; call_date: string | null; scheduled_start: string | null }>(
    "calls",
    "id, deal_id, call_date, scheduled_start",
    tenantId,
  );
  const trRows = await pageAll<{ call_id: string; body: string | null }>("transcripts", "id, call_id, body", null);
  const charsByCall = new Map(trRows.map((t) => [t.call_id, String(t.body ?? "").length]));

  const firstObserved = new Map<string, string>();
  let realConversations = 0;
  for (const c of callRows) {
    if ((charsByCall.get(c.id) ?? 0) < MIN_CONVERSATION_CHARS) continue;
    realConversations += 1;
    const d = String(c.call_date ?? c.scheduled_start ?? "").slice(0, 10);
    if (!d) continue;
    const cur = firstObserved.get(c.deal_id);
    if (!cur || d < cur) firstObserved.set(c.deal_id, d);
  }

  const crmRows = await pageAll<{ deal_id: string | null; changed_at: string }>(
    "crm_field_events",
    "id, deal_id, changed_at",
    tenantId,
  );
  let crmBefore = 0;
  let crmAfter = 0;
  let crmUnobserved = 0;
  const bothSides = new Set<string>();
  const beforeOnly = new Map<string, number>();
  for (const e of crmRows) {
    const obs = e.deal_id ? firstObserved.get(e.deal_id) : undefined;
    if (!obs) {
      crmUnobserved += 1;
      continue;
    }
    if (String(e.changed_at).slice(0, 10) < obs) {
      crmBefore += 1;
      beforeOnly.set(e.deal_id as string, (beforeOnly.get(e.deal_id as string) ?? 0) + 1);
    } else {
      crmAfter += 1;
      if (beforeOnly.has(e.deal_id as string)) bothSides.add(e.deal_id as string);
    }
  }

  const firstEver = [...firstObserved.values()].sort()[0] ?? "never";
  console.log(`  call rows:                          ${callRows.length}`);
  console.log(`  with a >=${MIN_CONVERSATION_CHARS}-char transcript:        ${realConversations}   <- conversations DealRipe actually observed`);
  console.log(`  deals ever observed:                ${firstObserved.size} of ${(await countOf("deals", tenantId))}`);
  console.log(`  first observation:                  ${firstEver}\n`);
  console.log(`  CRM changes BEFORE we observed:     ${String(crmBefore).padStart(5)}   <- Magaya's history. A PRIOR, not ours.`);
  console.log(`  CRM changes AFTER we observed:      ${String(crmAfter).padStart(5)}   <- the only window we can claim`);
  console.log(`  CRM changes on unobserved deals:    ${String(crmUnobserved).padStart(5)}   <- no captured conversation at all`);
  console.log(`  deals with history on BOTH sides:   ${String(bothSides.size).padStart(5)}   <- the only before/after comparisons that exist`);
  console.log(
    `\n  Any claim that mixes the first two lines is the "163 closed opportunities" mistake\n` +
      `  in a new table: a prior about Magaya's business read as evidence DealRipe changed one.`,
  );

  // Per-deal, the join that the learning loop will actually run.
  console.log("\n================ PER DEAL ================\n");
  const dealsRes = await db
    .from("deals")
    .select("id, account, outcome_label, salesforce_account_id, rolldog_opportunity_id")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(`deals read failed: ${dealsRes.error.message}`);
  const deals = (dealsRes.data ?? []).filter((d) => !onlyDeal || d.id === onlyDeal);

  const tally = async (table: string, col: string) => {
    const rows = await pageAll<Record<string, string>>(table, `id, ${col}`, table === "transcripts" ? null : tenantId);
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = r[col];
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const callsBy = await tally("calls", "deal_id");
  const msgBy = await tally("deal_messages", "deal_id");
  const gateBy = await tally("field_extraction_events", "deal_id");
  const tickBy = await tally("rolldog_gate_events", "deal_id");
  const rsvpBy = await tally("calendar_response_events", "deal_id");
  const crmBy = await tally("crm_field_events", "deal_id");
  const rxBy = await tally("prescribed_actions", "deal_id");

  let complete = 0;
  const rows = deals
    .map((d) => ({
      d,
      calls: callsBy.get(d.id) ?? 0,
      msgs: msgBy.get(d.id) ?? 0,
      gates: gateBy.get(d.id) ?? 0,
      ticks: tickBy.get(d.id) ?? 0,
      rsvp: rsvpBy.get(d.id) ?? 0,
      crm: crmBy.get(d.id) ?? 0,
      rx: rxBy.get(d.id) ?? 0,
    }))
    .sort((a, b) => b.calls + b.msgs - (a.calls + a.msgs));

  console.log("  account                        calls  msgs  gates  ticks  rsvp   crm    rx   outcome");
  console.log("  " + "-".repeat(94));
  for (const r of rows) {
    // "Complete" is deliberately narrow: a captured conversation AND email AND
    // something the CRM recorded. Anything less cannot support the join the
    // learning loop needs, however many rows it has.
    const isComplete = r.calls > 0 && r.msgs > 0 && r.crm > 0;
    if (isComplete) complete += 1;
    if (thin && isComplete) continue;
    console.log(
      `  ${String(r.d.account).slice(0, 28).padEnd(30)}` +
        `${String(r.calls).padStart(5)} ${String(r.msgs).padStart(5)} ${String(r.gates).padStart(6)} ` +
        `${String(r.ticks).padStart(6)} ${String(r.rsvp).padStart(5)} ${String(r.crm).padStart(5)} ` +
        `${String(r.rx).padStart(5)}   ${r.d.outcome_label ?? ""}`,
    );
  }

  console.log(`\n  deals: ${rows.length}`);
  console.log(`  with calls + email + CRM history (joinable for learning): ${complete}`);
  console.log(`  with an outcome label: ${rows.filter((r) => r.d.outcome_label).length}`);
  console.log(`  with prescriptions:    ${rows.filter((r) => r.rx > 0).length}`);
  console.log(
    `\n  THE LEARNING JOIN today: ${rows.filter((r) => r.rx > 0 && r.gates > 0).length} deals carry both a ` +
      `prescription and a gate event.\n  That, not the ${rows.filter((r) => r.d.outcome_label).length} outcome labels, is the ` +
      `substrate available now: gate flips run to hundreds a month against ~26 closes a quarter.\n`,
  );
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
