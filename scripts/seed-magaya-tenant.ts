/**
 * Idempotent seed: ensure a 'magaya' tenant row exists in Supabase.
 *
 * Why this exists:
 *   The CRM access enforcement layer in lib/crm-scope.ts writes every
 *   assert outcome (pass or fail) to crm_access_log. The default audit
 *   hook resolves the tenant_id by slug = 'magaya'. Until the magaya
 *   tenant row exists, every audit write fails (silently logged, not
 *   blocking) and the audit table stays empty. Run this script once
 *   per Supabase project before wiring Rolldog.
 *
 * Run: npm run seed:magaya
 *
 * Behaviour:
 *   - If a tenant with slug 'magaya' already exists, prints its id and
 *     exits 0. Safe to run repeatedly.
 *   - If not, inserts { slug: 'magaya', name: 'Magaya Corporation' }
 *     and prints the new id.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";

const SLUG = "magaya";
const NAME = "Magaya Corporation";

async function main(): Promise<void> {
  const db = supabaseAdmin();

  const existing = await db
    .from("tenants")
    .select("id, slug, name")
    .eq("slug", SLUG)
    .maybeSingle();

  if (existing.error) {
    console.error(
      `Failed to query tenants table: ${existing.error.message}`,
    );
    process.exit(1);
  }

  if (existing.data) {
    console.log(`Tenant '${SLUG}' already exists.`);
    console.log(`  id:   ${existing.data.id}`);
    console.log(`  name: ${existing.data.name}`);
    process.exit(0);
  }

  const insert = await db
    .from("tenants")
    .insert({ slug: SLUG, name: NAME })
    .select("id, slug, name")
    .single();

  if (insert.error) {
    console.error(`Insert failed: ${insert.error.message}`);
    process.exit(1);
  }

  console.log(`Created tenant '${SLUG}'.`);
  console.log(`  id:   ${insert.data.id}`);
  console.log(`  name: ${insert.data.name}`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
