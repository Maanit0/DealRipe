/**
 * Seed the CRM write-back trail for the second-nature demo tenant, so the Report
 * page ("Post-call write-back") and the Activity coverage view show DealRipe
 * writing NEAT qualification fields back to Salesforce automatically.
 *
 *   1. Sets a (fake) opportunity id on each deal so it resolves to a CRM opp.
 *   2. Inserts one crm_access_log write row per deal, listing the Salesforce
 *      opportunity fields the call confirmed (Economic_Buyer__c, Why_Now__c, ...).
 *
 * INERT + SAFE: second-nature has no live CRM connection and every cron is pinned
 * to magaya. Nothing is written to a real CRM. Idempotent. Runnable standalone:
 *   npx tsx scripts/seed-second-nature-crm.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getFrameworkForDeal } from "../lib/framework";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "second-nature";

export type CrmSeedResult = { deals: number; writes: number };

export async function seedSecondNatureCrm(opts?: { tenantId?: string; apply?: boolean; log?: (s: string) => void }): Promise<CrmSeedResult> {
  const apply = opts?.apply ?? true;
  const log = opts?.log ?? ((s: string) => console.log(s));
  const tenantId = opts?.tenantId ?? (await resolveTenantId(TENANT_SLUG));
  const db = supabaseAdmin();
  const result: CrmSeedResult = { deals: 0, writes: 0 };
  if (!apply) {
    log("  crm: DRY RUN");
    return result;
  }

  const del = await db.from("crm_access_log").delete().eq("tenant_id", tenantId);
  if (del.error) log(`  crm: clear failed: ${del.error.message}`);

  const dealsRes = await db.from("deals").select("id, external_id, account").eq("tenant_id", tenantId);
  const deals = (dealsRes.data ?? []) as Array<{ id: string; external_id: string | null; account: string }>;

  for (const d of deals) {
    const oppId = `sn-opp-${d.external_id ?? d.id}`;
    const upd = await db.from("deals").update({ rolldog_opportunity_id: oppId }).eq("id", d.id).eq("tenant_id", tenantId);
    if (upd.error) {
      log(`  crm: set opportunity id failed (${d.account}): ${upd.error.message}`);
      continue;
    }
    result.deals += 1;

    const callRes = await db
      .from("calls")
      .select("id, scheduled_start, call_date, duration_minutes")
      .eq("tenant_id", tenantId)
      .eq("deal_id", d.id)
      .eq("has_been_extracted", true)
      .order("call_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const callId = (callRes.data?.id as string | undefined) ?? null;
    const startIso = (callRes.data?.scheduled_start as string | undefined) ?? (callRes.data?.call_date as string | undefined) ?? null;
    const durMin = (callRes.data?.duration_minutes as number | undefined) ?? 30;
    const createdAt = startIso ? new Date(Date.parse(startIso) + (durMin + 8) * 60_000).toISOString() : new Date().toISOString();

    // Which Salesforce opportunity fields did the call confirm?
    let fields: string[] = [];
    try {
      const fw = await getFrameworkForDeal(d.id);
      const keyToField = new Map<string, string>();
      if (fw) {
        for (const f of fw.fields) {
          const wt = f.writeTarget as { system?: string; field?: string } | null;
          if (wt && wt.system === "salesforce" && wt.field) keyToField.set(f.fieldKey, wt.field);
        }
      }
      const fxRes = await db.from("field_extractions").select("framework_field_key, status").eq("deal_id", d.id).eq("status", "Yes");
      const confirmed = ((fxRes.data ?? []) as Array<{ framework_field_key: string }>).map((r) => r.framework_field_key);
      const set = new Set<string>();
      for (const key of confirmed) {
        const f = keyToField.get(key);
        if (f) set.add(f);
      }
      // Standard fields always kept current after a captured call.
      set.add("NextStep");
      set.add("CloseDate");
      fields = Array.from(set);
    } catch (err) {
      log(`  crm: framework map failed (${d.account}): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (fields.length === 0) {
      log(`  crm: no writeable fields for ${d.account}, skipped`);
      continue;
    }

    const ins = await db.from("crm_access_log").insert({
      tenant_id: tenantId,
      opportunity_external_id: oppId,
      operation: "write",
      allowed: true,
      fields,
      call_id: callId,
      created_at: createdAt,
    });
    if (ins.error) {
      log(`  crm: write-log insert failed (${d.account}): ${ins.error.message}`);
      continue;
    }
    result.writes += 1;
    log(`  crm write-back logged: ${d.account} (${fields.join(", ")})`);
  }

  return result;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`\nDealRipe second-nature CRM write-back seed  (${apply ? "APPLY" : "DRY RUN"})\n`);
  const res = await seedSecondNatureCrm({ apply });
  console.log(`\ncrm seed: linked ${res.deals} deals, logged ${res.writes} write-backs.`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
}
