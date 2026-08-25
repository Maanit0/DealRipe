/**
 * Where Magaya's deals actually progress and where they stall, per stage.
 *
 * Built to answer one question with data instead of intuition: of the 33
 * qualification gates, which ones get answered, which never do, and which
 * separate a deal that advanced from one that sat still.
 *
 * The distinction that matters most and that a raw coverage number hides:
 * a gate at 0% can mean the rep never asked, OR that the customer was asked and
 * would not say. Those need opposite interventions, so this reports Yes and No
 * separately and never collapses them into "confirmed".
 *
 *   npx tsx scripts/journey-map.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const STAGE_ORDER = ["SQL1", "SQL2", "SQL3", "SQL4", "SQL5"];

(async () => {
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const fw = await db.from("qualification_frameworks").select("id").eq("tenant_id", tenantId).eq("source", "rolldog").maybeSingle();
  const frameworkId = (fw.data as { id: string } | null)?.id;
  if (!frameworkId) throw new Error("no rolldog framework");

  const fields = await db.from("framework_fields")
    .select("field_key, label, stage_key, question").eq("framework_id", frameworkId).order("sort_order");
  const F = (fields.data ?? []) as Array<{ field_key: string; label: string; stage_key: string; question: string }>;

  const deals = await db.from("deals").select("id, account, outcome_label, stage_key").eq("tenant_id", tenantId);
  const D = (deals.data ?? []) as Array<{ id: string; account: string; outcome_label: string | null; stage_key: string }>;

  // Only deals DealRipe has actually heard. A deal with no captured call has no
  // opinion on any gate and would drag every rate toward zero for a reason that
  // has nothing to do with the sales process.
  const calls = await db.from("calls").select("deal_id, outcome, scheduled_start, call_subtype").eq("tenant_id", tenantId);
  const heard = new Set<string>();
  const callsByDeal = new Map<string, Array<{ at: string; subtype: string | null }>>();
  for (const c of (calls.data ?? []) as Array<{ deal_id: string; outcome: string | null; scheduled_start: string | null; call_subtype: string | null }>) {
    if (c.outcome !== "captured" || !c.deal_id) continue;
    heard.add(c.deal_id);
    if (c.scheduled_start) {
      const arr = callsByDeal.get(c.deal_id) ?? [];
      arr.push({ at: c.scheduled_start, subtype: c.call_subtype });
      callsByDeal.set(c.deal_id, arr);
    }
  }
  const inScope = D.filter((d) => heard.has(d.id));

  const fx = await db.from("field_extractions").select("deal_id, framework_field_key, status").eq("tenant_id", tenantId);
  const answer = new Map<string, string>();
  for (const r of (fx.data ?? []) as Array<{ deal_id: string; framework_field_key: string; status: string }>) {
    answer.set(`${r.deal_id}|${r.framework_field_key}`, r.status);
  }

  const N = inScope.length;
  console.log(`\n${"=".repeat(88)}`);
  console.log(`MAGAYA JOURNEY MAP   ${N} deals DealRipe has captured at least one call on`);
  console.log("=".repeat(88));

  // How deep do deals get? Furthest stage with any Yes.
  const depth: Record<string, number> = {};
  for (const d of inScope) {
    let furthest = "none";
    for (const st of STAGE_ORDER) {
      const any = F.filter((f) => f.stage_key === st).some((f) => answer.get(`${d.id}|${f.field_key}`) === "Yes");
      if (any) furthest = st;
    }
    depth[furthest] = (depth[furthest] ?? 0) + 1;
  }
  console.log(`\nHOW FAR DEALS GET (furthest stage with any gate answered Yes)\n`);
  for (const k of ["none", ...STAGE_ORDER]) {
    const n = depth[k] ?? 0;
    if (!n) continue;
    console.log(`  ${k.padEnd(6)} ${String(n).padStart(3)}  ${"#".repeat(Math.round((n / N) * 50))} ${((n / N) * 100).toFixed(0)}%`);
  }

  for (const st of STAGE_ORDER) {
    const stageFields = F.filter((f) => f.stage_key === st);
    if (!stageFields.length) continue;
    console.log(`\n${"-".repeat(88)}`);
    console.log(`${st}   ${stageFields.length} gates`);
    console.log("-".repeat(88));
    const rows = stageFields.map((f) => {
      let yes = 0, no = 0;
      for (const d of inScope) {
        const a = answer.get(`${d.id}|${f.field_key}`);
        if (a === "Yes") yes++;
        else if (a === "No") no++;
      }
      return { f, yes, no, silent: N - yes - no };
    }).sort((a, b) => a.yes - b.yes);
    console.log(`  ${"gate".padEnd(34)} ${"YES".padStart(4)} ${"NO".padStart(4)} ${"never came up".padStart(14)}`);
    for (const r of rows) {
      const pct = ((r.yes / N) * 100).toFixed(0).padStart(3);
      console.log(`  ${(r.f.label + " · " + r.f.field_key).slice(0, 34).padEnd(34)} ${String(r.yes).padStart(4)} ${String(r.no).padStart(4)} ${String(r.silent).padStart(14)}   ${pct}% yes`);
    }
  }
})().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
