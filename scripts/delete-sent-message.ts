/**
 * Delete archived sent_messages for a deal by kind (e.g. remove a test no-show
 * draft). Prints what it would delete; --apply performs it.
 *
 *   npx tsx scripts/delete-sent-message.ts --deal auto:extrum.com --kind no_show_draft
 *   npx tsx scripts/delete-sent-message.ts --deal auto:extrum.com --kind no_show_draft --apply
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
  const kind = arg("--kind");
  const apply = process.argv.includes("--apply");
  if (!ext || !kind) {
    console.error("Usage: --deal <external_id> --kind <briefing|recap|no_show_draft|digest> [--apply]");
    process.exit(1);
  }
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const deal = await db
    .from("deals")
    .select("id, account")
    .eq("tenant_id", tenantId)
    .eq("external_id", ext)
    .maybeSingle();
  if (deal.error || !deal.data) {
    console.error(`Deal '${ext}' not found.`);
    process.exit(1);
  }

  const rows = await db
    .from("sent_messages")
    .select("id, subject, sent_at")
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.data.id)
    .eq("kind", kind);
  const found = rows.data ?? [];
  console.log(`\n${deal.data.account}: ${found.length} '${kind}' message(s).`);
  for (const r of found) console.log(`  ${r.id}  ${r.sent_at}  ${r.subject ?? ""}`);

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to delete.`);
    return;
  }
  const del = await db
    .from("sent_messages")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.data.id)
    .eq("kind", kind);
  console.log(del.error ? `\nDelete failed: ${del.error.message}` : `\nDeleted ${found.length} message(s).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
