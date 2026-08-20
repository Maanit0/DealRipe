/**
 * DealRipe's own read on each deal, computed from what the BUYER did.
 *
 * Run this before any of it reaches a briefing. It answers the question that
 * decides whether the read is worth shipping: does it say anything a rep does
 * not already know, and does it disagree with the CRM in ways that are
 * defensible line by line.
 *
 * The band here is computed WITHOUT the rep's band, which is the whole point.
 * The existing read in lib/pipeline-changes.ts takes the rep's category and
 * moves it at most one notch, so it can never disagree meaningfully. This one
 * can, and when it agrees that agreement means something.
 *
 * Every rule is imported from lib/deal-signals-buyer.ts. Nothing here restates
 * one.
 *
 *   npx tsx scripts/deal-read-report.ts
 *   npx tsx scripts/deal-read-report.ts --rep ebencomo@magaya.com
 *   npx tsx scripts/deal-read-report.ts --deal Dunavant
 *   npx tsx scripts/deal-read-report.ts --stalling      only deals losing momentum
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { assessDeal, computeBuyerSignals, type DealAssessment } from "../lib/deal-signals-buyer";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const MOMENTUM_MARK: Record<DealAssessment["momentum"], string> = {
  advancing: "ADVANCING",
  steady: "steady   ",
  stalling: "STALLING ",
  unknown: "unknown  ",
};

async function main(): Promise<void> {
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const onlyRep = arg("--rep")?.toLowerCase();
  const onlyDeal = arg("--deal")?.toLowerCase();
  const onlyStalling = process.argv.includes("--stalling");

  const res = await db
    .from("deals")
    .select("id, account, rep_email, outcome_label")
    .eq("tenant_id", tenantId);
  if (res.error) throw new Error(`deals read failed: ${res.error.message}`);

  let deals = (res.data ?? []) as Array<{
    id: string;
    account: string;
    rep_email: string | null;
    outcome_label: string | null;
  }>;
  // A resolved deal has no read worth making.
  deals = deals.filter((d) => !d.outcome_label);
  if (onlyRep) deals = deals.filter((d) => (d.rep_email ?? "").toLowerCase() === onlyRep);
  if (onlyDeal) deals = deals.filter((d) => d.account.toLowerCase().includes(onlyDeal));

  console.log(`\n${"=".repeat(88)}`);
  console.log(`DEALRIPE'S OWN READ, ${TENANT_SLUG}: ${deals.length} open deal(s)`);
  console.log(`Computed from buyer behaviour only. The rep's own band is not an input.`);
  console.log(`${"=".repeat(88)}`);

  const rows: Array<{ account: string; rep: string; a: DealAssessment }> = [];
  for (const d of deals) {
    const signals = await computeBuyerSignals({ tenantId, dealId: d.id });
    const a = assessDeal(signals);
    if (onlyStalling && a.momentum !== "stalling") continue;
    rows.push({ account: d.account, rep: (d.rep_email ?? "").split("@")[0] || "?", a });
  }

  // ---- the table ---------------------------------------------------------
  rows.sort((x, y) => {
    const order = { stalling: 0, unknown: 1, steady: 2, advancing: 3 };
    return order[x.a.momentum] - order[y.a.momentum];
  });

  console.log(
    `\n  ${"deal".padEnd(26)} ${"rep".padEnd(11)} ${"band".padEnd(9)} ${"momentum".padEnd(10)} conf     risks`,
  );
  console.log(`  ${"-".repeat(26)} ${"-".repeat(11)} ${"-".repeat(9)} ${"-".repeat(10)} -------  -----`);
  for (const r of rows) {
    console.log(
      `  ${r.account.slice(0, 26).padEnd(26)} ${r.rep.slice(0, 11).padEnd(11)} ` +
        `${(r.a.band ?? "-").padEnd(9)} ${MOMENTUM_MARK[r.a.momentum]} ${r.a.confidence.padEnd(7)}  ${r.a.risks.length}`,
    );
  }

  // ---- distribution ------------------------------------------------------
  const count = <K extends string>(get: (r: (typeof rows)[number]) => K) => {
    const m = new Map<K, number>();
    for (const r of rows) m.set(get(r), (m.get(get(r)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  console.log(`\n  band       ${JSON.stringify(count((r) => r.a.band ?? "none"))}`);
  console.log(`  momentum   ${JSON.stringify(count((r) => r.a.momentum))}`);
  console.log(`  confidence ${JSON.stringify(count((r) => r.a.confidence))}`);

  // ---- the deals that need a person --------------------------------------
  const stalling = rows.filter((r) => r.a.momentum === "stalling");
  if (stalling.length > 0) {
    console.log(`\n${"-".repeat(88)}`);
    console.log(`LOSING MOMENTUM (${stalling.length})`);
    console.log(`Magaya's dominant recorded loss reason is No Decision / Non-Responsive.`);
    console.log(`These are the deals that die of silence rather than to a competitor.`);
    console.log(`${"-".repeat(88)}`);
    for (const r of stalling.slice(0, 12)) {
      console.log(`\n  ${r.account}  (${r.rep})`);
      console.log(`    ${r.a.momentumReason}`);
      for (const risk of r.a.risks.slice(0, 3)) console.log(`    risk: ${risk}`);
    }
  }

  // ---- one worked example, so the output can be argued with --------------
  const example = rows.find((r) => r.a.confidence === "high") ?? rows[0];
  if (example) {
    console.log(`\n${"-".repeat(88)}`);
    console.log(`WORKED EXAMPLE: ${example.account}`);
    console.log(`${"-".repeat(88)}`);
    console.log(`  band ${example.a.band ?? "none"}, ${example.a.momentum}, confidence ${example.a.confidence}`);
    console.log(`\n  going for it:`);
    for (const s of example.a.strengths) console.log(`    + ${s}`);
    console.log(`\n  against it:`);
    for (const s of example.a.risks) console.log(`    - ${s}`);
    console.log(`\n  could not check:`);
    for (const s of example.a.notChecked) console.log(`    ? ${s}`);
  }

  console.log(`\n${"=".repeat(88)}`);
  console.log(`Nothing here is written anywhere. This is the read, for arguing with.`);
  console.log(`${"=".repeat(88)}\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
