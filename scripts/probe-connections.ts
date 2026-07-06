/**
 * Probe every Microsoft calendar connection for the Magaya tenant: try a
 * calendar read on each and report OK or the error. Pinpoints the connection
 * causing MailboxNotEnabledForRESTAPI or a revoked token.
 *
 *   npx tsx scripts/probe-connections.ts
 *   npx tsx scripts/probe-connections.ts --delete someone@example.com
 *
 * --delete removes the connection row for that UPN (use to prune a stale or
 * mailbox-less connection so it stops breaking sync).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { listUpcomingMeetings } from "../lib/microsoft-graph";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SLUG = "magaya";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const delIdx = argv.indexOf("--delete");
  const delUpn = delIdx !== -1 ? argv[delIdx + 1] : null;

  const tenantId = await resolveTenantId(SLUG);
  const db = supabaseAdmin();

  const res = await db
    .from("microsoft_connections")
    .select("id, user_principal_name, connected_at")
    .eq("tenant_id", tenantId)
    .order("connected_at", { ascending: false });
  if (res.error) {
    console.error(`query failed: ${res.error.message}`);
    process.exit(1);
  }
  const rows = res.data ?? [];

  if (delUpn) {
    const row = rows.find((r) => (r.user_principal_name ?? "").toLowerCase() === delUpn.toLowerCase());
    if (!row) {
      console.error(`No connection found for UPN '${delUpn}'.`);
      process.exit(1);
    }
    const del = await db.from("microsoft_connections").delete().eq("id", row.id);
    if (del.error) {
      console.error(`delete failed: ${del.error.message}`);
      process.exit(1);
    }
    console.log(`Deleted connection for ${delUpn}.`);
    return;
  }

  console.log("");
  console.log(`Probing ${rows.length} connection(s) for tenant '${SLUG}':`);
  console.log("");
  for (const r of rows) {
    const upn = r.user_principal_name ?? "(unknown UPN)";
    try {
      const events = await listUpcomingMeetings(r.id, 1);
      console.log(`  OK    ${upn}  (${events.length} event(s) in next 24h)`);
    } catch (err) {
      console.log(`  FAIL  ${upn}  -> ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  console.log("");
  console.log("To remove a bad one: npx tsx scripts/probe-connections.ts --delete <upn>");
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
