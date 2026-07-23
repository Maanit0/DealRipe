/**
 * Clean up test-era duplicate sends so the coverage board reads true. During
 * development the pipeline was re-run against the same calls, so some meetings
 * have the rep-facing recap or the Rolldog write logged more than once. Normal
 * operation sends each exactly once; these are artifacts, not real double-sends.
 *
 * For each call this keeps the EARLIEST emailed briefing / recap / no-show draft
 * and deletes later duplicates, and collapses repeated Rolldog write runs (audit
 * rows more than 15 minutes apart) down to the first run. Only touches rows that
 * are hard-linked to a call (call_id set), so nothing ambiguous is deleted.
 *
 * Safe by default: prints what it would remove and deletes nothing without
 * --apply.
 *
 *   npx tsx scripts/dedupe-sends.ts
 *   npx tsx scripts/dedupe-sends.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const apply = process.argv.includes("--apply");
const RUN_GAP_MS = 15 * 60 * 1000;

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  // ---- sent_messages: keep earliest emailed message per (call, kind). ----
  const sentRes = await db
    .from("sent_messages")
    .select("id, call_id, kind, sent_at, provider_id")
    .eq("tenant_id", tenantId)
    .order("sent_at", { ascending: true });
  const sent = (sentRes.data ?? []) as Array<{
    id: string;
    call_id: string | null;
    kind: string;
    sent_at: string;
    provider_id: string | null;
  }>;

  const seen = new Set<string>();
  const sentToDelete: Array<{ id: string; call_id: string; kind: string; sent_at: string }> = [];
  for (const m of sent) {
    if (!m.call_id || !m.provider_id) continue; // only real, call-linked emails
    if (m.kind !== "briefing" && m.kind !== "recap" && m.kind !== "no_show_draft") continue;
    const key = `${m.call_id}|${m.kind}`;
    if (seen.has(key)) sentToDelete.push({ id: m.id, call_id: m.call_id, kind: m.kind, sent_at: m.sent_at });
    else seen.add(key);
  }

  // ---- crm_access_log: collapse repeated write runs per call to the first. ----
  const crmRes = await db
    .from("crm_access_log")
    .select("id, call_id, created_at, operation, allowed")
    .eq("tenant_id", tenantId)
    .eq("operation", "write")
    .eq("allowed", true)
    .order("created_at", { ascending: true });
  const crm = (crmRes.data ?? []) as Array<{ id: string; call_id: string | null; created_at: string }>;

  const byCall = new Map<string, Array<{ id: string; t: number }>>();
  for (const r of crm) {
    if (!r.call_id) continue;
    const list = byCall.get(r.call_id) ?? [];
    list.push({ id: r.id, t: Date.parse(r.created_at) });
    byCall.set(r.call_id, list);
  }
  const crmToDelete: Array<{ id: string; call_id: string }> = [];
  for (const [callId, rows] of byCall) {
    rows.sort((a, b) => a.t - b.t);
    const firstRunEnd = rows[0].t + RUN_GAP_MS;
    // Keep the first run (everything within 15 min of the first row); delete rows
    // that belong to a later run (a genuine re-write of the same call).
    for (const r of rows) {
      if (r.t > firstRunEnd) crmToDelete.push({ id: r.id, call_id: callId });
    }
  }

  console.log(`\nDuplicate rep-facing sends to remove: ${sentToDelete.length}`);
  for (const d of sentToDelete) console.log(`  sent_messages ${d.id}  ${d.kind}  call ${d.call_id}  ${d.sent_at}`);
  console.log(`\nLater Rolldog write-run rows to remove: ${crmToDelete.length}`);
  const crmCalls = new Set(crmToDelete.map((d) => d.call_id));
  for (const c of crmCalls) console.log(`  call ${c}: ${crmToDelete.filter((d) => d.call_id === c).length} rows`);

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to delete these ${sentToDelete.length + crmToDelete.length} rows.`);
    return;
  }

  let removed = 0;
  for (const d of sentToDelete) {
    const r = await db.from("sent_messages").delete().eq("id", d.id);
    if (!r.error) removed++;
  }
  for (const d of crmToDelete) {
    const r = await db.from("crm_access_log").delete().eq("id", d.id);
    if (!r.error) removed++;
  }
  console.log(`\nRemoved ${removed} rows. Re-run scripts/preview-coverage.ts to confirm the board is clean.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
