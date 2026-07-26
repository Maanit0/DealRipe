/**
 * Prints the Magaya qualification framework: every field DealRipe extracts from a
 * call, grouped by stage, with the total count. This is the exact field set the
 * extraction prompt asks the model to fill (buildExtractionSystemPrompt uses
 * framework.fields), resolved via the same getFrameworkForDeal path production uses.
 *
 * Runs on your Mac (reads Supabase). Writes nothing.
 *
 *   npx tsx scripts/framework-fields.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getFrameworkForDeal, loadFramework } from "../lib/framework";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  // Prefer the framework a real deal resolves to (what extraction actually uses),
  // falling back to the tenant default.
  const { data } = await db.from("deals").select("id, account").eq("tenant_id", tenantId).limit(1);
  const dealId = (data?.[0] as { id?: string } | undefined)?.id;
  const fw = (dealId ? await getFrameworkForDeal(dealId) : null) ?? (await loadFramework(tenantId));

  if (!fw) {
    console.log("\nNo framework resolved for tenant 'magaya'.\n");
    return;
  }

  console.log(`\n=== Framework: ${fw.name} ===`);
  console.log(`Total fields extracted per call: ${fw.fields.length}\n`);

  const byStage = new Map<string, typeof fw.fields>();
  for (const f of fw.fields) {
    const s = f.stageKey ?? "(no stage)";
    (byStage.get(s) ?? byStage.set(s, []).get(s)!).push(f);
  }

  for (const [stage, fields] of byStage) {
    console.log(`${stage}  (${fields.length} field${fields.length === 1 ? "" : "s"})`);
    for (const f of fields) {
      console.log(`  - ${f.fieldKey}  |  ${f.label}`);
      if (f.question) console.log(`      Q: ${f.question}`);
    }
    console.log("");
  }

  console.log(`Total: ${fw.fields.length} fields across ${byStage.size} stage group(s).\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
