/**
 * Idempotent: ensure the 'keelson' demo tenant row exists. Run this before
 * seeding the keelson framework/deals, since the framework seed requires the
 * tenant to already exist. Safe to re-run.
 *
 *   npx tsx scripts/seed-keelson-tenant.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";

const SLUG = "keelson";
const NAME = "Keelson";

async function main(): Promise<void> {
  const db = supabaseAdmin();

  const existing = await db.from("tenants").select("id, slug, name").eq("slug", SLUG).maybeSingle();
  if (existing.error) {
    console.error(`Failed to query tenants: ${existing.error.message}`);
    process.exit(1);
  }
  if (existing.data) {
    console.log(`Tenant '${SLUG}' already exists (id=${existing.data.id}).`);
    return;
  }

  const insert = await db.from("tenants").insert({ slug: SLUG, name: NAME }).select("id, slug, name").single();
  if (insert.error) {
    console.error(`Insert failed: ${insert.error.message}`);
    process.exit(1);
  }
  console.log(`Created tenant '${SLUG}' (id=${insert.data.id}).`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
