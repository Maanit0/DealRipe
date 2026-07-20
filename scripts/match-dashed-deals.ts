/**
 * Propose a Rolldog opportunity for each auto-created (unlinked) magaya deal by
 * matching the deal's domain root against the pulled opp account names. The deal
 * "account" is derived from the email domain (e.g. auto:fmgloballogistics.com ->
 * "Fmgloballogistics"), while Rolldog stores the real name ("FM Global
 * Logistics"), so we compare letters-only compact forms and the domain root.
 *
 * Read-only. Prints candidates for a human to confirm. Requires the pulled
 * lists from scripts/pull-rep-opps.ts (.previews/rep-opps-*.json).
 *
 *   npx tsx scripts/match-dashed-deals.ts
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";
import path from "node:path";

import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

type Opp = { id: string; account: string; stage: string | null; forecast: string | null; dealSize: number | null };

const SUFFIXES = new Set([
  "inc", "llc", "ltd", "co", "corp", "corporation", "company", "group",
  "international", "intl", "usa", "us", "the", "limited", "gmbh", "sa", "srl",
]);

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t && !SUFFIXES.has(t));
}

function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function scoreOpp(domainRoot: string, dealTokens: string[], dealCompact: string, opp: Opp): number {
  const oc = compact(opp.account);
  const ot = tokens(opp.account);
  if (!oc) return 0;
  // Strongest: the deal's domain root IS the opp's compacted name.
  if (oc === domainRoot || oc === dealCompact) return 100;
  if (domainRoot.length >= 5 && (oc.startsWith(domainRoot) || domainRoot.startsWith(oc))) return 90;
  if (oc.includes(domainRoot) || domainRoot.includes(oc)) return 78;
  // Token overlap fallback.
  const overlap = dealTokens.filter((t) => ot.includes(t)).length;
  if (overlap === 0) return 0;
  return Math.round((overlap / Math.max(dealTokens.length, ot.length)) * 70);
}

async function main(): Promise<void> {
  const dir = path.join(process.cwd(), ".previews");
  const opps: Opp[] = [];
  for (const rep of ["juan", "eduardo"]) {
    const file = path.join(dir, `rep-opps-${rep}.json`);
    const arr = JSON.parse(readFileSync(file, "utf8")) as Opp[];
    for (const o of arr) opps.push(o);
  }
  console.log(`Loaded ${opps.length} opportunities.\n`);

  const tenantId = await resolveTenantId("magaya");
  const res = await supabaseAdmin()
    .from("deals")
    .select("external_id, account, rolldog_opportunity_id")
    .eq("tenant_id", tenantId)
    .like("external_id", "auto:%")
    .order("account", { ascending: true });
  if (res.error) throw new Error(res.error.message);

  for (const d of res.data ?? []) {
    const linked = (d as { rolldog_opportunity_id?: string | null }).rolldog_opportunity_id;
    if (linked) continue; // already linked, skip
    const domainRoot = (d.external_id ?? "").replace(/^auto:/, "").split(".")[0].toLowerCase();
    const dTokens = tokens(d.account);
    const dCompact = compact(d.account);
    const ranked = opps
      .map((o) => ({ o, s: scoreOpp(domainRoot, dTokens, dCompact, o) }))
      .filter((x) => x.s >= 55)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);

    console.log(`● ${d.account}  (${d.external_id})`);
    if (ranked.length === 0) {
      console.log("    no candidate found\n");
      continue;
    }
    for (const { o, s } of ranked) {
      console.log(`    [${s}]  opp ${o.id}  ${o.account}  (${o.stage ?? "?"}, ${o.forecast ?? "?"})`);
    }
    console.log();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
