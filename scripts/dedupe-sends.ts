/**
 * Clean up test-era duplicate rep-facing sends so the coverage board reads true.
 * During development the pipeline was re-run against the same calls, so some
 * meetings have the recap (or briefing / no-show draft) emailed and archived more
 * than once. Normal operation sends each exactly once; these are artifacts.
 *
 * Only touches sent_messages (archived emails). It attributes each real emailed
 * send to a call the same way the coverage view does (its stored call_id, else
 * the deal's nearest call by time), then within each (call, kind) keeps the
 * EARLIEST and removes the rest.
 *
 * Deliberately does NOT touch crm_access_log: that is the tamper-evident audit
 * trail of every write to a customer's CRM under NDA and must not be deleted.
 * Historical write-back "duplicate" flags are handled in the coverage view (it
 * only flags genuine hard-linked double-writes), not by deleting audit rows.
 *
 * Safe by default: prints what it would remove and deletes nothing without --apply.
 *
 *   npx tsx scripts/dedupe-sends.ts
 *   npx tsx scripts/dedupe-sends.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const apply = process.argv.includes("--apply");
const KINDS = new Set(["briefing", "recap", "no_show_draft"]);

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  // All calls, to attribute a send to its nearest call per deal (same logic the
  // coverage view uses).
  const callsRes = await db
    .from("calls")
    .select("id, deal_id, scheduled_start, call_date")
    .eq("tenant_id", tenantId);
  const callsByDeal = new Map<string, Array<{ id: string; t: number }>>();
  for (const c of (callsRes.data ?? []) as Array<{ id: string; deal_id: string | null; scheduled_start: string | null; call_date: string | null }>) {
    const date = c.scheduled_start ?? c.call_date;
    if (!c.deal_id || !date) continue;
    const list = callsByDeal.get(c.deal_id) ?? [];
    list.push({ id: c.id, t: Date.parse(date) });
    callsByDeal.set(c.deal_id, list);
  }
  const attribute = (dealId: string | null, hardCallId: string | null, atIso: string): string | null => {
    if (hardCallId) return hardCallId;
    if (!dealId) return null;
    const list = callsByDeal.get(dealId);
    if (!list || list.length === 0) return null;
    const t = Date.parse(atIso);
    let best: string | null = null;
    let bestDiff = Infinity;
    for (const c of list) {
      const d = Math.abs(c.t - t);
      if (d < bestDiff) {
        bestDiff = d;
        best = c.id;
      }
    }
    return best;
  };

  // Real emailed sends only (provider_id set); dry-run archives never count.
  const sentRes = await db
    .from("sent_messages")
    .select("id, deal_id, call_id, kind, sent_at, provider_id")
    .eq("tenant_id", tenantId)
    .order("sent_at", { ascending: true });
  const sent = (sentRes.data ?? []) as Array<{
    id: string;
    deal_id: string | null;
    call_id: string | null;
    kind: string;
    sent_at: string;
    provider_id: string | null;
  }>;

  const seen = new Set<string>();
  const toDelete: Array<{ id: string; kind: string; call: string; sent_at: string }> = [];
  for (const m of sent) {
    if (!m.provider_id || !KINDS.has(m.kind)) continue;
    const call = attribute(m.deal_id, m.call_id, m.sent_at);
    if (!call) continue;
    const key = `${call}|${m.kind}`;
    if (seen.has(key)) toDelete.push({ id: m.id, kind: m.kind, call, sent_at: m.sent_at });
    else seen.add(key);
  }

  console.log(`\nDuplicate emailed sends to remove: ${toDelete.length}`);
  for (const d of toDelete) console.log(`  ${d.kind}  call ${d.call}  ${d.sent_at}  (sent_messages ${d.id})`);

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to delete these ${toDelete.length} archived duplicates.`);
    return;
  }

  let removed = 0;
  for (const d of toDelete) {
    const r = await db.from("sent_messages").delete().eq("id", d.id);
    if (!r.error) removed++;
    else console.error(`  failed to delete ${d.id}: ${r.error.message}`);
  }
  console.log(`\nRemoved ${removed} rows. Re-run scripts/preview-coverage.ts to confirm the board is clean.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
