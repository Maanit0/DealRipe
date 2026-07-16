/**
 * Reset/set the outcome of a deal's no-content call(s). Use to undo a misclick
 * (set back to 'no_conversation' so the rep classifies it) or to correct a
 * classification. Only touches calls already in the no-content set; never
 * overrides a captured call. Read-only unless --apply.
 *
 *   npx tsx scripts/set-call-outcome.ts --deal dutyfreeamericas --to no_conversation
 *   npx tsx scripts/set-call-outcome.ts --deal dutyfreeamericas --to no_conversation --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const NO_CONTENT = ["no_conversation", "no_show", "rescheduled", "placeholder"];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ext = arg("--deal");
  const to = arg("--to") ?? "no_conversation";
  const apply = process.argv.includes("--apply");
  if (!ext) {
    console.error("Usage: --deal <external_id> --to <outcome> [--apply]");
    process.exit(1);
  }
  if (!NO_CONTENT.includes(to)) {
    console.error(`--to must be one of: ${NO_CONTENT.join(", ")}`);
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

  const calls = await db
    .from("calls")
    .select("id, scheduled_start, outcome")
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.data.id)
    .in("outcome", NO_CONTENT);
  const targets = calls.data ?? [];
  if (targets.length === 0) {
    console.log(`No no-content calls on ${deal.data.account} to change.`);
    return;
  }

  console.log(`${deal.data.account}: ${targets.length} call(s) -> outcome '${to}'`);
  for (const c of targets) console.log(`  ${c.scheduled_start ?? c.id}: ${c.outcome} -> ${to}`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply.");
    return;
  }
  const upd = await db
    .from("calls")
    .update({ outcome: to })
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.data.id)
    .in("outcome", NO_CONTENT);
  if (upd.error) {
    console.error(`Update failed: ${upd.error.message}`);
    process.exit(1);
  }
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
