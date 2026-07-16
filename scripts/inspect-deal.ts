/**
 * Inspect a single deal's current DB state — framework pointer + extraction keys.
 *
 * Read-only. Prints exactly what's in Supabase right now for the deal(s)
 * matching --account (substring, case-insensitive) or --external-id (exact).
 * Purpose: diagnose "why is the UI still showing the old framework / old
 * recap after I ran fix-auto-frameworks.ts."
 *
 *   npx tsx scripts/inspect-deal.ts --account "core"
 *   npx tsx scripts/inspect-deal.ts --external-id auto:corelogistics.net
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function parseArgs(argv: string[]): { account: string | null; externalId: string | null } {
  let account: string | null = null;
  let externalId: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--account") { account = argv[++i] ?? null; continue; }
    if (argv[i] === "--external-id") { externalId = argv[++i] ?? null; continue; }
    console.error(`unknown argument: ${argv[i]}`);
    process.exit(1);
  }
  if (!account && !externalId) {
    console.error("Usage: npx tsx scripts/inspect-deal.ts --account <substring> | --external-id <exact>");
    process.exit(1);
  }
  return { account, externalId };
}

async function main(): Promise<void> {
  const { account, externalId } = parseArgs(process.argv.slice(2));
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  // Build map: framework_id -> name
  const fw = await db
    .from("qualification_frameworks")
    .select("id, name, source")
    .eq("tenant_id", tenantId);
  if (fw.error) { console.error(fw.error.message); process.exit(1); }
  const fwNameById = new Map<string, string>();
  for (const row of fw.data ?? []) fwNameById.set(row.id, `${row.name} (${row.source})`);

  // Find matching deals.
  let q = db
    .from("deals")
    .select("id, external_id, account, framework_id, stage_key, created_at")
    .eq("tenant_id", tenantId);
  if (externalId) q = q.eq("external_id", externalId);
  if (account) q = q.ilike("account", `%${account}%`);
  const deals = await q;
  if (deals.error) { console.error(deals.error.message); process.exit(1); }
  if (!deals.data?.length) {
    console.log("No deals match.");
    return;
  }

  console.log("");
  console.log(`Found ${deals.data.length} deal(s):\n`);

  for (const d of deals.data) {
    const fwLabel = d.framework_id
      ? fwNameById.get(d.framework_id) ?? `(unknown framework ${d.framework_id})`
      : "(none)";
    console.log(`---------------------------------------------------------------`);
    console.log(`deal_id:       ${d.id}`);
    console.log(`account:       ${d.account}`);
    console.log(`external_id:   ${d.external_id ?? "(none)"}`);
    console.log(`stage_key:     ${d.stage_key}`);
    console.log(`framework_id:  ${d.framework_id ?? "(none)"}`);
    console.log(`framework:     ${fwLabel}`);
    console.log(`created_at:    ${d.created_at}`);

    const fx = await db
      .from("field_extractions")
      .select("framework_field_key, status, framework_id, updated_at")
      .eq("deal_id", d.id)
      .order("framework_field_key", { ascending: true });
    if (fx.error) { console.error(`  extractions read failed: ${fx.error.message}`); continue; }

    const rows = fx.data ?? [];
    console.log(`extractions:   ${rows.length} row(s)`);
    if (rows.length > 0) {
      const keySample = rows.slice(0, 20).map((r) => r.framework_field_key);
      console.log(`  field_keys:  ${JSON.stringify(keySample)}`);
      // Cross-check: do any extraction rows reference a framework_id that
      // doesn't match the deal's current framework_id? That's the "stale
      // extractions from a prior framework" case.
      const staleFwIds = new Set(
        rows
          .map((r) => r.framework_id)
          .filter((id): id is string => typeof id === "string" && id !== d.framework_id),
      );
      if (staleFwIds.size > 0) {
        console.log(`  STALE: some extractions reference framework(s):`);
        for (const id of staleFwIds) {
          console.log(`    ${fwNameById.get(id) ?? "(unknown)"}  ${id}`);
        }
      }
      // Would fix-auto-frameworks.ts have touched this deal?
      if (!d.external_id?.startsWith("auto:")) {
        console.log(`  NOTE: external_id does NOT start with 'auto:' — fix-auto-frameworks.ts would have SKIPPED this deal.`);
      }
    }
    console.log("");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
