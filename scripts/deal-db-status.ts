/**
 * Shows the full DB state of a deal so you can see whether the closed loop ran:
 * the deal row, every call (external id, meeting type, whether a transcript body
 * is stored and how long), the extraction field counts, and the recaps /
 * briefings sent. Use it to diagnose a deal that "isn't showing" its meeting.
 *
 * Runs on your Mac (reads Supabase). Writes nothing.
 *
 *   npx tsx scripts/deal-db-status.ts --account "IFF"
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function main(): Promise<void> {
  const account = arg("--account");
  if (!account) { console.log(`\nPass --account "<name>".\n`); return; }
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const { data } = await db.from("deals").select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence, rep_email").eq("tenant_id", tenantId);
  const target = norm(account);
  const deals = ((data ?? []) as Array<{ id: string; account: string; external_id: string | null; rolldog_opportunity_id: string | null; rolldog_link_confidence: string | null; rep_email: string | null }>)
    .filter((d) => norm(d.account).includes(target));
  if (deals.length === 0) { console.log(`\nNo deal matches "${account}".\n`); return; }

  for (const d of deals) {
    console.log(`\n=== ${d.account} ===`);
    console.log(`  dealId: ${d.id}`);
    console.log(`  external_id: ${d.external_id ?? "—"}`);
    console.log(`  rolldog_opportunity_id: ${d.rolldog_opportunity_id ?? "—"}  (link: ${d.rolldog_link_confidence ?? "none"})`);
    console.log(`  rep: ${d.rep_email ?? "—"}`);

    const calls = await db.from("calls").select("id, external_id, call_date, scheduled_start, meeting_type, call_subtype, has_been_extracted").eq("tenant_id", tenantId).eq("deal_id", d.id).order("call_date", { ascending: false });
    const callRows = (calls.data ?? []) as Array<{ id: string; external_id: string | null; call_date: string | null; scheduled_start: string | null; meeting_type: string | null; call_subtype: string | null; has_been_extracted: boolean }>;
    console.log(`\n  CALLS: ${callRows.length}`);
    for (const c of callRows) {
      const tr = await db.from("transcripts").select("body").eq("call_id", c.id).maybeSingle();
      const len = tr.data?.body?.length ?? 0;
      const date = c.scheduled_start ?? c.call_date;
      console.log(`    - ${date ? new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "?"}  callId=${c.id}`);
      console.log(`        external_id=${c.external_id ?? "—"}  type=${c.meeting_type ?? "—"}/${c.call_subtype ?? "—"}  extracted=${c.has_been_extracted}  transcript=${len > 0 ? `${len} chars` : "MISSING"}`);
    }

    const fx = await db.from("field_extractions").select("status").eq("deal_id", d.id);
    const fxRows = (fx.data ?? []) as Array<{ status: string }>;
    const yes = fxRows.filter((r) => r.status === "Yes").length;
    console.log(`\n  FIELD_EXTRACTIONS: ${fxRows.length} total, ${yes} Yes`);

    const sm = await db.from("sent_messages").select("kind").eq("tenant_id", tenantId).eq("deal_id", d.id);
    const smRows = (sm.data ?? []) as Array<{ kind: string }>;
    const byKind = new Map<string, number>();
    for (const m of smRows) byKind.set(m.kind, (byKind.get(m.kind) ?? 0) + 1);
    console.log(`  SENT_MESSAGES: ${[...byKind.entries()].map(([k, n]) => `${k}=${n}`).join(", ") || "none"}`);
  }
  console.log("");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
