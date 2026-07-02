/**
 * List every Microsoft calendar connection for the Magaya tenant.
 *
 * Use this during rep onboarding to confirm each rep completed the
 * Connect flow. Unlike `test:graph` (which pulls only the most recent
 * connection and lists that person's meetings), this lists ALL rows so
 * you can see both reps at a glance.
 *
 *   npx tsx scripts/check-connections.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const PILOT_TENANT_SLUG = "magaya";

async function main(): Promise<void> {
  let tenantId: string;
  try {
    tenantId = await resolveTenantId(PILOT_TENANT_SLUG);
  } catch {
    console.error(`Tenant '${PILOT_TENANT_SLUG}' not found. Run the magaya seed first.`);
    process.exit(1);
  }

  const db = supabaseAdmin();
  const res = await db
    .from("microsoft_connections")
    .select("user_principal_name, microsoft_user_id, connected_at, last_synced_at, scopes")
    .eq("tenant_id", tenantId)
    .order("connected_at", { ascending: false });

  if (res.error) {
    console.error(`Query failed: ${res.error.message}`);
    process.exit(1);
  }

  const rows = res.data ?? [];
  console.log("");
  console.log(`Microsoft calendar connections for tenant '${PILOT_TENANT_SLUG}': ${rows.length}`);
  console.log("");

  if (rows.length === 0) {
    console.log("  (none yet) — no rep has completed /auth/microsoft/connect");
    console.log("");
    return;
  }

  for (const r of rows) {
    const upn = r.user_principal_name ?? "(unknown UPN)";
    const when = r.connected_at ?? "(unknown)";
    const synced = r.last_synced_at ?? "never";
    const calRead = (r.scopes ?? "").includes("Calendars.Read") ? "Calendars.Read ok" : "MISSING Calendars.Read";
    console.log(`  ${upn}`);
    console.log(`      connected: ${when}`);
    console.log(`      last sync: ${synced}   scopes: ${calRead}`);
    console.log("");
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
