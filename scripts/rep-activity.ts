/**
 * What DealRipe has actually done for one rep so far: Rolldog write-backs (with
 * the specific fields written), pre-call briefings generated, post-call recaps
 * sent, and no-show drafts. Use it to walk a rep through the concrete value.
 *
 * Runs on your Mac (reads Supabase). Sends nothing.
 *
 *   npx tsx scripts/rep-activity.ts --rep juan
 *   npx tsx scripts/rep-activity.ts --rep eduardo
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { repName } from "../lib/display-names";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function d(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

async function main(): Promise<void> {
  const rep = (arg("--rep") ?? "juan").toLowerCase();
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealsRes = await db.from("deals").select("id, account, rep_email").eq("tenant_id", tenantId);
  const deals = ((dealsRes.data ?? []) as Array<{ id: string; account: string; rep_email: string | null }>).filter(
    (x) => (x.rep_email ?? "").toLowerCase().includes(rep) || repName(x.rep_email).toLowerCase().includes(rep),
  );
  const dealIds = deals.map((x) => x.id);
  const acct = new Map(deals.map((x) => [x.id, x.account] as const));
  if (dealIds.length === 0) {
    console.log(`\nNo deals found for rep "${rep}".\n`);
    return;
  }

  const callsRes = await db.from("calls").select("id, deal_id").eq("tenant_id", tenantId).in("deal_id", dealIds);
  const calls = (callsRes.data ?? []) as Array<{ id: string; deal_id: string }>;
  const dealByCall = new Map(calls.map((c) => [c.id, c.deal_id] as const));
  const callIds = calls.map((c) => c.id);

  const [crmRes, briefRes, msgRes] = await Promise.all([
    db.from("crm_access_log").select("operation, fields, allowed, call_id, opportunity_external_id, created_at").eq("tenant_id", tenantId),
    db.from("briefing_runs").select("deal_id, created_at").eq("tenant_id", tenantId).in("deal_id", dealIds),
    db.from("sent_messages").select("deal_id, call_id, kind, sent_at").eq("tenant_id", tenantId).in("deal_id", dealIds),
  ]);

  console.log(`\n=== DealRipe activity for ${rep.toUpperCase()} — ${deals.length} deals ===\n`);

  // Rolldog write-backs (attributed via call_id -> Juan's calls, allowed writes only).
  const writes = ((crmRes.data ?? []) as Array<{ operation: string; fields: string[] | null; allowed: boolean; call_id: string | null; created_at: string | null }>)
    .filter((w) => w.allowed && w.call_id && callIds.includes(w.call_id) && (w.fields?.length ?? 0) > 0);
  console.log(`ROLLDOG WRITE-BACKS: ${writes.length}`);
  for (const w of writes) {
    const account = acct.get(dealByCall.get(w.call_id!) ?? "") ?? "?";
    console.log(`  - ${d(w.created_at)}  ${account}: ${(w.fields ?? []).join(", ")}`);
  }

  // Pre-call briefings.
  const briefs = (briefRes.data ?? []) as Array<{ deal_id: string; created_at: string | null }>;
  console.log(`\nPRE-CALL BRIEFINGS: ${briefs.length}`);
  for (const b of briefs) console.log(`  - ${d(b.created_at)}  ${acct.get(b.deal_id) ?? "?"}`);

  // Post-call recaps + no-show drafts.
  const msgs = (msgRes.data ?? []) as Array<{ deal_id: string; kind: string; sent_at: string | null }>;
  const recaps = msgs.filter((m) => m.kind === "recap");
  const noShows = msgs.filter((m) => m.kind === "no_show_draft");
  console.log(`\nPOST-CALL RECAPS: ${recaps.length}`);
  for (const m of recaps) console.log(`  - ${d(m.sent_at)}  ${acct.get(m.deal_id) ?? "?"}`);
  console.log(`\nNO-SHOW DRAFTS: ${noShows.length}`);
  for (const m of noShows) console.log(`  - ${d(m.sent_at)}  ${acct.get(m.deal_id) ?? "?"}`);
  console.log("");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
