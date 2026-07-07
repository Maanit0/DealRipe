/**
 * Capture the day-0 CRM baseline for pilot deals.
 *
 * Run once at pilot start (and any time you want to re-freeze). For each pilot
 * deal that maps to a Rolldog opportunity, this reads the current Rolldog state
 * and freezes it into deal_crm_baseline as reference-only "before" data. It
 * NEVER touches field_extractions and never marks a gate confirmed.
 *
 * Prerequisite: apply supabase/add-crm-baseline.sql first.
 *
 *   npx tsx scripts/capture-crm-baseline.ts            # all mapped pilot deals
 *   npx tsx scripts/capture-crm-baseline.ts iff        # one deal by external_id
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { captureCrmBaseline } from "../lib/crm-baseline";
import { PILOT_DEAL_ROLLDOG_IDS } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SLUG = "magaya";

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const tenantId = await resolveTenantId(SLUG);
  const db = supabaseAdmin();

  const entries = Object.entries(PILOT_DEAL_ROLLDOG_IDS).filter(
    ([ext]) => only.length === 0 || only.includes(ext),
  );
  if (entries.length === 0) {
    console.error(`No pilot deals matched ${JSON.stringify(only)}.`);
    process.exit(1);
  }

  let ok = 0;
  let skipped = 0;
  for (const [externalId, opp] of entries) {
    const dealRow = await db
      .from("deals")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("external_id", externalId)
      .maybeSingle();
    if (dealRow.error || !dealRow.data) {
      console.warn(`  skip ${externalId}: no deal row (${dealRow.error?.message ?? "not found"})`);
      skipped += 1;
      continue;
    }

    try {
      const baseline = await captureCrmBaseline({ tenantId, dealId: dealRow.data.id, opportunityId: opp });
      if (!baseline) {
        console.warn(`  skip ${externalId}: deal has no framework`);
        skipped += 1;
        continue;
      }
      const filled = Object.values(baseline.reportedFields).filter(
        (v) => (v as { status?: string })?.status === "Yes",
      ).length;
      console.log(
        `  ${externalId} (opp ${opp}): stage ${baseline.stageKey ?? "?"}, ` +
          `score ${baseline.summary.score ?? "-"}, deal-size ${baseline.summary.dealSize ?? "-"}, ` +
          `${filled} field(s) reported by CRM (unverified)`,
      );
      ok += 1;
    } catch (err) {
      console.warn(`  skip ${externalId}: ${err instanceof Error ? err.message : String(err)}`);
      skipped += 1;
    }
  }

  console.log("");
  console.log(`Froze ${ok} baseline(s), skipped ${skipped}.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
