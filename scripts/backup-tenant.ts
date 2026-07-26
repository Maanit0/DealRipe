/**
 * Lightweight, no-password backup: dumps every tenant-scoped row for a tenant to
 * a timestamped JSON file, using the Supabase service-role key already in
 * .env.local (the same one the app uses). No pg_dump, no DB password, no reset.
 *
 * Use it to snapshot Magaya before seeding Keelson, so you can diff row counts
 * before/after and confirm nothing changed.
 *
 *   npx tsx scripts/backup-tenant.ts             # defaults to magaya
 *   npx tsx scripts/backup-tenant.ts --tenant magaya
 *
 * Writes ./backup-<slug>-<timestamp>.json. Read-only against the DB.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { writeFileSync } from "node:fs";

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// Every table that carries a tenant_id. Missing tables are skipped gracefully.
const TABLES = [
  "deals",
  "contacts",
  "calls",
  "transcripts",
  "field_extractions",
  "extraction_runs",
  "briefing_runs",
  "deal_signal_snapshots",
  "prescribed_actions",
  "tasks",
  "sent_messages",
  "crm_access_log",
  "qualification_frameworks",
  "framework_fields",
] as const;

async function main(): Promise<void> {
  const slug = arg("--tenant") ?? "magaya";
  const tenantId = await resolveTenantId(slug);
  const db = supabaseAdmin();

  const out: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const table of TABLES) {
    const res = await db.from(table).select("*").eq("tenant_id", tenantId);
    if (res.error) {
      console.log(`  ${table.padEnd(24)} skipped (${res.error.message})`);
      continue;
    }
    out[table] = res.data ?? [];
    counts[table] = res.data?.length ?? 0;
    console.log(`  ${table.padEnd(24)} ${counts[table]}`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `backup-${slug}-${stamp}.json`;
  writeFileSync(file, JSON.stringify({ tenant: slug, tenantId, at: new Date().toISOString(), counts, data: out }, null, 2));
  console.log(`\nWrote ${file}. Keep it locally (it contains customer data; do not commit).\n`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
