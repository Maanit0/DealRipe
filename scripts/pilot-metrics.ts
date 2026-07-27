/**
 * Authoritative pilot metrics for the Magaya proposal. Mirrors the app's own
 * logic (Report page for write-back, Deals dashboard for coverage) so the
 * numbers you quote to Mark reconcile with what he sees in the product.
 *
 *   npx tsx scripts/pilot-metrics.ts
 *
 * Prints, scoped to the magaya tenant:
 *   A. Write-back (what actually hit Rolldog): fields written, calls processed,
 *      deals enriched, the exact date window, and a Juan/Eduardo split.
 *   B. Per-deal write-back detail.
 *   C. Engine coverage: fields auto-logged (confirmed gates), open gaps, calls captured.
 *   D. Digests sent.
 *
 * Runs on your Mac with .env.local (needs Supabase access).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getActivityLog } from "../lib/activity-log";
import { repName } from "../lib/display-names";
import { getFrameworkForDeal } from "../lib/framework";
import { frameworkProgress } from "../lib/framework-stages";
import { supabaseAdmin } from "../lib/supabase";
import { getDealsForTenant } from "../lib/supabase-queries";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function fmt(iso: string | null): string {
  if (!iso) return "?";
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" });
  } catch {
    return "?";
  }
}

async function main(): Promise<void> {
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  // Deal -> rep map (for the Juan/Eduardo split and per-deal labels).
  const dealsRes = await db.from("deals").select("id, account, rep_email").eq("tenant_id", tenantId);
  const dealInfo = new Map(
    ((dealsRes.data ?? []) as Array<{ id: string; account: string; rep_email: string | null }>).map(
      (d) => [d.id, { account: d.account, rep: repName(d.rep_email) }] as const,
    ),
  );

  // ---- A. WRITE-BACK (mirrors app/report/page.tsx) ----
  const entries = await getActivityLog(tenantId);
  const writes = entries.filter((e) => e.kind === "rolldog_write" && e.dealId);

  const fieldPairs = new Set<string>();
  const callSet = new Set<string>();
  const dealSet = new Set<string>();
  const perRep = new Map<string, { fields: Set<string>; calls: Set<string>; deals: Set<string> }>();
  const perDeal = new Map<string, { fields: number; calls: Set<string>; first: string; last: string }>();
  let minAt = "", maxAt = "";

  for (const e of writes) {
    const dealId = e.dealId as string;
    const rep = dealInfo.get(dealId)?.rep ?? "Unknown";
    dealSet.add(dealId);
    if (e.callId) callSet.add(e.callId);
    if (!minAt || e.at < minAt) minAt = e.at;
    if (!maxAt || e.at > maxAt) maxAt = e.at;

    const rp = perRep.get(rep) ?? { fields: new Set(), calls: new Set(), deals: new Set() };
    rp.deals.add(dealId);
    if (e.callId) rp.calls.add(e.callId);

    const pd = perDeal.get(dealId) ?? { fields: 0, calls: new Set<string>(), first: e.at, last: e.at };
    if (e.callId) pd.calls.add(e.callId);
    if (e.at < pd.first) pd.first = e.at;
    if (e.at > pd.last) pd.last = e.at;

    for (const f of (e.fields ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      fieldPairs.add(`${dealId}::${f}`);
      rp.fields.add(`${dealId}::${f}`);
      pd.fields += 1;
    }
    perRep.set(rep, rp);
    perDeal.set(dealId, pd);
  }

  console.log("==================================================");
  console.log("A. WRITE-BACK TO ROLLDOG  (the defensible proof)");
  console.log("==================================================");
  console.log(`  Qualification fields written : ${fieldPairs.size}`);
  console.log(`  Calls processed              : ${callSet.size}`);
  console.log(`  Deals enriched               : ${dealSet.size}`);
  console.log(`  Active window                : ${fmt(minAt)}  ->  ${fmt(maxAt)}`);
  console.log(`  Digests sent                 : ${entries.filter((e) => e.kind === "digest").length}`);
  console.log("\n  By rep:");
  for (const [rep, v] of [...perRep.entries()].sort((a, b) => b[1].fields.size - a[1].fields.size)) {
    console.log(`    ${rep.padEnd(10)}  ${v.fields.size} fields   ${v.calls.size} calls   ${v.deals.size} deals`);
  }

  console.log("\nB. PER-DEAL WRITE-BACK");
  const perDealSorted = [...perDeal.entries()].sort((a, b) => b[1].fields - a[1].fields);
  for (const [dealId, v] of perDealSorted) {
    const info = dealInfo.get(dealId);
    console.log(
      `    ${(info?.account ?? dealId).slice(0, 22).padEnd(23)} ${(info?.rep ?? "").padEnd(9)} ${String(v.fields).padStart(2)} fields  ${v.calls.size} calls  ${fmt(v.first)}-${fmt(v.last)}`,
    );
  }

  // ---- C. ENGINE COVERAGE (mirrors the Deals dashboard) ----
  const deals = await getDealsForTenant(tenantId);
  let confirmed = 0, total = 0, callsCaptured = 0;
  const repCalls = new Map<string, number>();
  for (const d of deals) {
    const fw = await getFrameworkForDeal(d.id);
    if (fw) {
      const p = frameworkProgress(fw, d.extraction);
      confirmed += p.confirmed;
      total += p.total;
    }
    callsCaptured += d.calls.length;
    const rp = repName(d.repEmail ?? null);
    repCalls.set(rp, (repCalls.get(rp) ?? 0) + d.calls.length);
  }
  console.log("\n==================================================");
  console.log("C. ENGINE COVERAGE  (matches the Deals dashboard)");
  console.log("==================================================");
  console.log(`  Fields auto-logged (confirmed gates) : ${confirmed}`);
  console.log(`  Open gaps flagged                    : ${total - confirmed}`);
  console.log(`  Calls captured (all deals)           : ${callsCaptured}`);
  console.log("  Calls by rep:");
  for (const [rep, n] of [...repCalls.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${rep.padEnd(10)} ${n}`);
  }

  console.log("\nUse section A for the proposal's proof numbers; they are the actual Rolldog writes.\n");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
