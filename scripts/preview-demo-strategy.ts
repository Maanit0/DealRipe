/**
 * Generate a demo strategy for one deal and print it.
 *
 *   npx tsx scripts/preview-demo-strategy.ts --deal Dunavant
 *   npx tsx scripts/preview-demo-strategy.ts --deal Dunavant --json
 *
 * READ ONLY. Writes nothing, posts nothing, sends nothing.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { buildDemoStrategyForDeal, renderDemoStrategy } from "../lib/demo-strategy";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const q = (arg("--deal") ?? "").trim();
  if (!q) {
    console.log("Usage: --deal <account fragment> [--as-of YYYY-MM-DD] [--json]");
    process.exit(1);
  }
  const tenantId = await resolveTenantId("magaya");
  const { data, error } = await supabaseAdmin()
    .from("deals").select("id, account").eq("tenant_id", tenantId).ilike("account", `%${q}%`).limit(5);
  if (error) throw new Error(error.message);
  const deals = (data ?? []) as Array<{ id: string; account: string }>;
  if (deals.length === 0) { console.log(`No deal matching "${q}".`); return; }
  if (deals.length > 1) {
    console.log(`"${q}" matches ${deals.length} deals: ${deals.map((d) => d.account).join(", ")}. Be more specific.`);
    return;
  }

  const t0 = Date.now();
  const asOf = arg("--as-of");
  if (asOf) console.log(`Reading only calls on or before ${asOf}.`);
  const res = await buildDemoStrategyForDeal({ dealId: deals[0].id, asOf });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (res.status !== "ok") {
    console.log(`\n${res.status.toUpperCase()}: ${res.reason}\n`);
    return;
  }
  console.log(
    `\nBuilt in ${secs}s from ${res.sources.transcripts} of ${res.sources.calls} calls, ` +
      `${res.sources.transcriptChars.toLocaleString()} transcript chars, ` +
      `${res.sources.extractedFields} captured fields.\n`,
  );
  console.log(process.argv.includes("--json")
    ? JSON.stringify(res.doc, null, 2)
    : renderDemoStrategy(deals[0].account, res.doc));
  console.log();
}

main().catch((err) => { console.error("Unexpected error:", err); process.exit(1); });
