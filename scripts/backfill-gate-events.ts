/**
 * Seed the gate-transition log with what is still recoverable, and be explicit
 * about what is not.
 *
 *   npx tsx scripts/backfill-gate-events.ts            # dry run
 *   npx tsx scripts/backfill-gate-events.ts --apply    # WRITES
 *
 * WHAT IS RECOVERABLE. One event per current field_extractions row: the state
 * as it stands, dated by that row's updated_at, attributed to
 * last_updated_from_call_id. That gives every deal a floor to its trajectory
 * instead of nothing.
 *
 * WHAT IS NOT, and this is the reason the table exists. The row holds the
 * CURRENT answer only, so a field that went Unknown -> Yes on Aug 12 and had
 * its evidence refreshed on Sep 2 backfills as a single Sep 2 event. The Aug 12
 * flip, and the call that produced it, are gone. Nothing in the database can
 * reconstruct them: that is the cost of six weeks of upserts and it is why the
 * forward-looking write matters more than this script.
 *
 * from_status is written as null on every backfilled row, which is honest:
 * "this is the first thing we know about this field", not "it flipped from
 * nothing". Real transitions from here on carry a real prior.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  // PAGINATED, and it must stay that way. PostgREST caps a plain select at
  // 1000 rows and says nothing about it, so the first version of this script
  // reported "would seed 1000" against 2140 real rows and would have left 1140
  // fields with no floor event and nobody any the wiser. A silent cap reads as
  // "covered everything" exactly when it did not.
  const PAGE = 1000;
  const rows: Array<{
    deal_id: string;
    framework_field_key: string;
    framework_id: string | null;
    status: string;
    answer: string | null;
    evidence: string | null;
    confidence: number | null;
    last_updated_from_call_id: string | null;
    updated_at: string;
    created_at: string;
  }> = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("field_extractions")
      .select("deal_id, framework_field_key, framework_id, status, answer, evidence, confidence, last_updated_from_call_id, updated_at, created_at")
      .eq("tenant_id", tenantId)
      .order("deal_id", { ascending: true })
      .order("framework_field_key", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`field_extractions read failed: ${error.message}`);
    rows.push(...((data ?? []) as typeof rows));
    if ((data ?? []).length < PAGE) break;
  }

  // Cross-check against the count, so a future paging change that silently
  // truncates is loud rather than invisible.
  const { count: total } = await db
    .from("field_extractions")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId);
  if (typeof total === "number" && total !== rows.length) {
    throw new Error(`read ${rows.length} field_extractions rows but the table reports ${total}; refusing to seed a partial floor`);
  }

  const seen = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("field_extraction_events")
      .select("deal_id, framework_field_key")
      .eq("tenant_id", tenantId)
      .order("deal_id", { ascending: true })
      .range(from, from + PAGE - 1);
    // A failed read here would look like "no events yet" and re-seed every
    // field a second time. Refuse instead.
    if (error) throw new Error(`field_extraction_events read failed: ${error.message}`);
    for (const e of data ?? []) seen.add(`${e.deal_id}|${e.framework_field_key}`);
    if ((data ?? []).length < PAGE) break;
  }

  const callIds = [...new Set((rows ?? []).map((r) => r.last_updated_from_call_id).filter(Boolean))] as string[];
  const callDate = new Map<string, string | null>();
  for (let i = 0; i < callIds.length; i += 100) {
    const { data: cs } = await db
      .from("calls")
      .select("id, call_date, scheduled_start")
      .in("id", callIds.slice(i, i + 100));
    for (const c of cs ?? []) callDate.set(c.id, c.call_date ?? c.scheduled_start ?? null);
  }

  const toWrite = (rows ?? [])
    .filter((r) => !seen.has(`${r.deal_id}|${r.framework_field_key}`))
    .map((r) => ({
      tenant_id: tenantId,
      deal_id: r.deal_id,
      framework_field_key: r.framework_field_key,
      framework_id: r.framework_id,
      from_status: null,
      to_status: r.status,
      from_answer: null,
      to_answer: r.answer,
      evidence: r.evidence,
      confidence: r.confidence,
      source_call_id: r.last_updated_from_call_id,
      // The row's updated_at is when we last touched it, which is the best
      // available stamp and is NOT when the field first flipped.
      observed_at: r.updated_at,
      occurred_at: r.last_updated_from_call_id ? (callDate.get(r.last_updated_from_call_id) ?? null) : null,
    }));

  const lostHistory = (rows ?? []).filter((r) => r.created_at.slice(0, 10) !== r.updated_at.slice(0, 10)).length;

  console.log(`\n  field_extractions rows on magaya:     ${rows?.length ?? 0}`);
  console.log(`  already have an event:                ${(rows?.length ?? 0) - toWrite.length}`);
  console.log(`  would seed:                           ${toWrite.length}`);
  console.log(`  rows whose created_at != updated_at:  ${lostHistory}   <- these changed at least once and the earlier state is unrecoverable`);
  console.log(`  with a source call attributed:        ${toWrite.filter((r) => r.source_call_id).length}`);

  if (!apply) {
    console.log("\n  Dry run. Re-run with --apply to write.\n");
    return;
  }
  let written = 0;
  for (let i = 0; i < toWrite.length; i += 200) {
    const slice = toWrite.slice(i, i + 200);
    const res = await db.from("field_extraction_events").insert(slice).select("id");
    if (res.error) {
      console.error(`  insert failed at offset ${i}: ${res.error.message}`);
      break;
    }
    written += res.data?.length ?? 0;
  }
  console.log(`\n  wrote ${written} seed event(s).\n`);
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
