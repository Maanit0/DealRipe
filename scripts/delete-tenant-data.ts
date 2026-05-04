/**
 * Delete all data for a tenant. Used for end-of-pilot deletion and DPA
 * compliance. ALWAYS run with --dry-run first.
 *
 * The script counts rows per table, deletes them in FK-safe leaf-to-root
 * order, then deletes the tenant row itself. Output:
 *   1. A console summary.
 *   2. A signed deletion confirmation file at
 *      deletion-confirmations/{slug}-{timestamp}.txt that includes a
 *      SHA-256 hash of the summary as a tamper-evidence check.
 *
 * Usage:
 *   npm run delete:tenant -- <slug> --dry-run
 *   npm run delete:tenant -- <slug>             (LIVE, deletes data)
 *
 * Or directly:
 *   tsx scripts/delete-tenant-data.ts <slug> [--dry-run]
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import { supabaseAdmin } from "../lib/supabase";

const TABLE_DELETE_ORDER = [
  "extraction_runs",
  "briefing_runs",
  "field_extractions",
  "transcripts",
  "calls",
  "contacts",
  "deals",
] as const;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const slug = args.find((a) => !a.startsWith("--"));

  if (!slug) {
    console.error(
      "Usage: tsx scripts/delete-tenant-data.ts <slug> [--dry-run]\n" +
        "       npm run delete:tenant -- <slug> [--dry-run]",
    );
    process.exit(1);
  }

  const db = supabaseAdmin();

  const tenantSel = await db
    .from("tenants")
    .select("id, slug, name")
    .eq("slug", slug)
    .maybeSingle();

  if (tenantSel.error) {
    throw new Error(`tenant lookup failed: ${tenantSel.error.message}`);
  }
  if (!tenantSel.data) {
    console.error(`tenant '${slug}' not found.`);
    process.exit(1);
  }
  const tenant = tenantSel.data;

  console.log("");
  console.log(`tenant slug:  ${tenant.slug}`);
  console.log(`tenant uuid:  ${tenant.id}`);
  console.log(`tenant name:  ${tenant.name}`);
  console.log(
    `mode:         ${dryRun ? "DRY RUN (no rows will be deleted)" : "LIVE (rows WILL be deleted)"}`,
  );
  console.log("");

  const counts: Record<string, number> = {};
  for (const table of TABLE_DELETE_ORDER) {
    const c = await db
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenant.id);
    if (c.error) {
      throw new Error(`count failed for ${table}: ${c.error.message}`);
    }
    const n = c.count ?? 0;
    counts[table] = n;

    if (n === 0 || dryRun) {
      console.log(
        `  ${table.padEnd(20)} ${String(n).padStart(4)} ${dryRun ? "(would delete)" : ""}`,
      );
      continue;
    }

    const del = await db.from(table).delete().eq("tenant_id", tenant.id);
    if (del.error) {
      throw new Error(`delete failed for ${table}: ${del.error.message}`);
    }
    console.log(`  ${table.padEnd(20)} ${String(n).padStart(4)} deleted`);
  }

  const tenantCount = 1;
  if (dryRun) {
    console.log(`  ${"tenants".padEnd(20)} ${String(tenantCount).padStart(4)} (would delete)`);
  } else {
    const td = await db.from("tenants").delete().eq("id", tenant.id);
    if (td.error) throw new Error(`tenant delete failed: ${td.error.message}`);
    console.log(`  ${"tenants".padEnd(20)} ${String(tenantCount).padStart(4)} deleted`);
  }

  const totalRows =
    Object.values(counts).reduce((s, c) => s + c, 0) + tenantCount;
  const timestamp = new Date().toISOString();

  const summary = [
    `DealRipe tenant data ${dryRun ? "deletion DRY RUN" : "deletion"} confirmation`,
    ``,
    `Tenant slug:   ${tenant.slug}`,
    `Tenant UUID:   ${tenant.id}`,
    `Tenant name:   ${tenant.name}`,
    `Timestamp:     ${timestamp}`,
    `Mode:          ${dryRun ? "DRY RUN (no rows deleted)" : "LIVE (rows deleted)"}`,
    ``,
    `Rows ${dryRun ? "that would be deleted" : "deleted"} per table:`,
    ...TABLE_DELETE_ORDER.map(
      (t) => `  ${t.padEnd(20)} ${counts[t]}`,
    ),
    `  ${"tenants".padEnd(20)} ${tenantCount}`,
    `  ${"-".repeat(28)}`,
    `  ${"total".padEnd(20)} ${totalRows}`,
    ``,
  ].join("\n");

  const hash = createHash("sha256").update(summary).digest("hex");
  const fullReport = `${summary}\nSHA-256 of summary: ${hash}\n`;

  const dir = resolve(process.cwd(), "deletion-confirmations");
  mkdirSync(dir, { recursive: true });
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const filename = `${tenant.slug}-${safeTimestamp}${dryRun ? "-dryrun" : ""}.txt`;
  const filepath = resolve(dir, filename);
  writeFileSync(filepath, fullReport);

  console.log("");
  console.log(fullReport);
  console.log(`written to: ${filepath}`);
}

main().catch((err) => {
  console.error("Deletion script failed:", err.message ?? err);
  process.exit(1);
});
