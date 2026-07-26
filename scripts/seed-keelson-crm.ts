/**
 * Seed the CRM write-back trail for the keelson demo tenant, so the Report page
 * ("Post-call write-back") and the Activity coverage view show DealRipe writing
 * qualification fields back to the CRM automatically, exactly like the live pilot.
 *
 * It does two things, both strictly scoped to the keelson tenant:
 *   1. Sets a (fake) rolldog_opportunity_id on each keelson deal, so the deal
 *      resolves to a CRM opportunity and the write-preview + coverage light up.
 *   2. Inserts one crm_access_log write row per deal (operation "write", allowed),
 *      listing the sub-resources the call confirmed (situation, timeline, budget,
 *      competitors, people), stamped shortly after the call and hard-linked to it.
 *
 * INERT + SAFE: keelson has no Rolldog connection and every cron is pinned to
 * magaya, so a rolldog_opportunity_id here is never acted on. Nothing is written
 * to a real CRM. Idempotent: clears keelson crm_access_log rows first.
 *
 * Called at the end of scripts/seed-keelson.ts on --apply, and runnable standalone:
 *   npx tsx scripts/seed-keelson-crm.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getFrameworkForDeal } from "../lib/framework";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "keelson";

// framework write method -> Rolldog sub-resource (mirrors lib/meeting-coverage).
const METHOD_SUBRESOURCE: Record<string, string> = {
  writeBudget: "budget",
  writeTimeline: "timeline",
  writeSituation: "situation",
  writeCompetitionNotes: "competitors",
  writeParticipantNotes: "people",
};

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type CrmSeedResult = { deals: number; writes: number };

export async function seedKeelsonCrm(opts?: {
  tenantId?: string;
  apply?: boolean;
  log?: (s: string) => void;
}): Promise<CrmSeedResult> {
  const apply = opts?.apply ?? true;
  const log = opts?.log ?? ((s: string) => console.log(s));
  const tenantId = opts?.tenantId ?? (await resolveTenantId(TENANT_SLUG));
  const db = supabaseAdmin();
  const result: CrmSeedResult = { deals: 0, writes: 0 };

  if (!apply) {
    log("  crm: DRY RUN (nothing written)");
    return result;
  }

  // Idempotent: clear keelson's write-log rows first (strictly tenant-scoped).
  const del = await db.from("crm_access_log").delete().eq("tenant_id", tenantId);
  if (del.error) log(`  crm: clear crm_access_log failed: ${del.error.message}`);

  const dealsRes = await db.from("deals").select("id, external_id, account").eq("tenant_id", tenantId);
  const deals = (dealsRes.data ?? []) as Array<{ id: string; external_id: string | null; account: string }>;

  for (const d of deals) {
    const oppId = `keelson-opp-${d.external_id ?? d.id}`;

    // 1. Link the deal to a (fake) CRM opportunity.
    const upd = await db.from("deals").update({ rolldog_opportunity_id: oppId }).eq("id", d.id).eq("tenant_id", tenantId);
    if (upd.error) {
      log(`  crm: set opportunity id failed (${d.account}): ${upd.error.message}`);
      continue;
    }
    result.deals += 1;

    // The deal's most recent call (hard-link the write to it).
    const callRes = await db
      .from("calls")
      .select("id, scheduled_start, call_date, duration_minutes")
      .eq("tenant_id", tenantId)
      .eq("deal_id", d.id)
      .order("call_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const callId = (callRes.data?.id as string | undefined) ?? null;
    const startIso = (callRes.data?.scheduled_start as string | undefined) ?? (callRes.data?.call_date as string | undefined) ?? null;
    const durMin = (callRes.data?.duration_minutes as number | undefined) ?? 40;
    const createdAt = startIso ? new Date(Date.parse(startIso) + (durMin + 8) * 60_000).toISOString() : new Date().toISOString();

    // Which sub-resources did the call confirm? Map confirmed gates -> sub-resource.
    let subs: string[] = [];
    try {
      const fw = await getFrameworkForDeal(d.id);
      const fieldToSub = new Map<string, string>();
      if (fw) {
        for (const f of fw.fields) {
          const method = f.writeTarget && f.writeTarget.system === "rolldog" ? String(f.writeTarget.method ?? "") : "";
          const sub = METHOD_SUBRESOURCE[method];
          if (sub) fieldToSub.set(f.fieldKey, sub);
        }
      }
      const fxRes = await db
        .from("field_extractions")
        .select("framework_field_key, status")
        .eq("deal_id", d.id)
        .eq("status", "Yes");
      const confirmed = ((fxRes.data ?? []) as Array<{ framework_field_key: string }>).map((r) => r.framework_field_key);
      const set = new Set<string>();
      for (const key of confirmed) {
        const sub = fieldToSub.get(key);
        if (sub) set.add(sub);
      }
      subs = Array.from(set);
    } catch (err) {
      log(`  crm: framework map failed (${d.account}): ${msg(err)}`);
    }

    if (subs.length === 0) {
      log(`  crm: no writeable sub-resources for ${d.account}, skipped write row`);
      continue;
    }

    const ins = await db.from("crm_access_log").insert({
      tenant_id: tenantId,
      opportunity_external_id: oppId,
      operation: "write",
      allowed: true,
      fields: subs,
      call_id: callId,
      created_at: createdAt,
    });
    if (ins.error) {
      log(`  crm: write-log insert failed (${d.account}): ${ins.error.message}`);
      continue;
    }
    result.writes += 1;
    log(`  crm write-back logged: ${d.account} (${subs.join(", ")})`);
  }

  return result;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  console.log(`\nDealRipe keelson CRM write-back seed  (${apply ? "APPLY" : "DRY RUN, nothing written"})\n`);
  const res = await seedKeelsonCrm({ apply });
  console.log("");
  if (apply) {
    console.log(`crm seed complete: linked ${res.deals} deals, logged ${res.writes} write-backs.`);
    console.log(`View: /report?tenant=${TENANT_SLUG} and /activity?tenant=${TENANT_SLUG}`);
  } else {
    console.log("Dry run only. Re-run with --apply to write.");
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
  });
}
