/**
 * Collapse duplicate archived messages in sent_messages. Re-running the recap
 * during debugging archived the same recap several times; this keeps the newest
 * copy of each (deal_id, kind, subject) group and deletes the older duplicates.
 * Read-only unless --apply.
 *
 *   npx tsx scripts/dedupe-recaps.ts                              # all magaya deals, dry run
 *   npx tsx scripts/dedupe-recaps.ts --deal auto:corelogistics.net
 *   npx tsx scripts/dedupe-recaps.ts --deal auto:corelogistics.net --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ext = arg("--deal");
  const apply = process.argv.includes("--apply");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  // Restrict to one deal if asked.
  let dealIds: string[] | null = null;
  if (ext) {
    const d = await db
      .from("deals")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("external_id", ext)
      .maybeSingle();
    if (d.error || !d.data) {
      console.error(`Deal '${ext}' not found.`);
      process.exit(1);
    }
    dealIds = [d.data.id];
  }

  let q = db
    .from("sent_messages")
    .select("id, deal_id, kind, subject, sent_at")
    .eq("tenant_id", tenantId)
    .order("sent_at", { ascending: false });
  if (dealIds) q = q.in("deal_id", dealIds);
  const rows = await q;
  if (rows.error) {
    console.error(rows.error.message);
    process.exit(1);
  }

  // Group by deal_id + kind + subject; the first seen (newest, since ordered
  // desc) is the keeper, the rest are duplicates to delete.
  const seen = new Set<string>();
  const toDelete: Array<{ id: string; subject: string; sent_at: string | null }> = [];
  for (const r of rows.data ?? []) {
    const key = `${r.deal_id}|${r.kind}|${r.subject}`;
    if (seen.has(key)) toDelete.push({ id: r.id, subject: r.subject, sent_at: r.sent_at });
    else seen.add(key);
  }

  if (toDelete.length === 0) {
    console.log("No duplicate messages found.");
    return;
  }

  console.log(`${toDelete.length} duplicate message(s) to delete (keeping the newest of each):`);
  for (const d of toDelete) console.log(`  ${d.sent_at ?? "?"}  ${d.subject}`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to delete these duplicates.");
    return;
  }
  const del = await db.from("sent_messages").delete().in("id", toDelete.map((d) => d.id));
  if (del.error) {
    console.error(`Delete failed: ${del.error.message}`);
    process.exit(1);
  }
  console.log(`\nDeleted ${toDelete.length} duplicate(s).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
