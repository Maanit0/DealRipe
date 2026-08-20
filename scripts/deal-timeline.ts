/**
 * One deal, call by call: what we asked for, what happened, what changed.
 *
 * The terminal rendering of the same reading /read/[id] shows. Both go through
 * buildDealTimeline and loadPortfolioRead, so a founder at a terminal and a
 * leader on the page cannot see different numbers about the same deal. Two
 * renderers over one builder; never two builders.
 *
 *   npx tsx scripts/deal-timeline.ts --deal Dunavant
 *   npx tsx scripts/deal-timeline.ts --rep ebencomo@magaya.com --limit 3
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { loadPortfolioRead } from "../lib/deal-read-portfolio";
import { buildDealTimeline } from "../lib/deal-timeline";
import { readEmailEngagement } from "../lib/email-log";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const d10 = (iso: string) => (iso ? iso.slice(0, 10) : "?");

type DealRow = {
  id: string;
  account: string;
  rep_email: string | null;
  outcome_label: string | null;
  salesforce_account_id: string | null;
  salesforce_link_confidence: string | null;
};

async function printDeal(tenantId: string, deal: DealRow): Promise<void> {
  const accountId =
    deal.salesforce_link_confidence === "confirmed" ? deal.salesforce_account_id : null;

  const [reads, timeline, mail] = await Promise.all([
    loadPortfolioRead({ tenantId, dealIds: [deal.id] }),
    buildDealTimeline({ tenantId, dealId: deal.id, accountId }),
    readEmailEngagement({ tenantId, dealId: deal.id }),
  ]);
  const read = reads[0];

  console.log(`\n${"=".repeat(92)}`);
  console.log(`${deal.account}   ${deal.rep_email ?? "?"}`);
  if (read) {
    console.log(
      `rep says ${read.crm?.forecastCategory ?? "no band"}` +
        `${read.crm?.closeDate ? ` closing ${read.crm.closeDate}` : ""}   ` +
        `DealRipe says ${read.assessment.band ?? "no read"}, ${read.assessment.momentum}` +
        `   (confidence ${read.assessment.confidence})`,
    );
    if (read.crm) {
      console.log(
        `Salesforce stage: ${read.crm.stageName}` +
          `${read.crm.openCount > 1 ? `   (1 of ${read.crm.openCount} open opportunities on this account)` : ""}`,
      );
    }
  }
  console.log(`${"=".repeat(92)}`);

  for (const e of timeline.entries) {
    console.log(
      `\n  ${d10(e.at)}  ${e.upcoming ? "UPCOMING  " : ""}${e.kind}` +
        `${e.outcome ? `  [${e.outcome}]` : ""}`,
    );
    if (e.title) console.log(`    "${e.title.slice(0, 78)}"`);
    console.log(
      `    before  ${e.briefingLeadMinutes !== null ? `briefing sent ${e.briefingLeadMinutes} min ahead` : "no briefing"}`,
    );
    for (const p of e.prescriptions.slice(0, 4)) {
      console.log(`            asked: ${p.text.slice(0, 66)}  [${p.followed}]`);
    }
    if (e.prescriptions.length > 4) console.log(`            and ${e.prescriptions.length - 4} more`);
    if (e.upcoming) continue;

    if (e.artifacts.length > 0) console.log(`    after   delivered: ${e.artifacts.join(", ")}`);
    for (const o of e.outcomes) console.log(`            ${o}`);
    if (e.emailOut > 0 || e.emailIn > 0) {
      console.log(`            email after: ${e.emailOut} out, ${e.emailIn} back from the customer`);
    }
    for (const m of e.crmMoves) console.log(`            CRM: ${m}`);
  }
  if (timeline.entries.length === 0) console.log(`\n  no calls captured on this deal`);

  console.log(`\n  ${"-".repeat(88)}`);
  if (!read || read.flags.length === 0) console.log(`  no flags`);
  for (const f of read?.flags ?? []) {
    console.log(`  [${f.severity}] ${f.title}`);
    console.log(`      ${f.evidence}`);
    console.log(`      -> ${f.move}`);
  }
  console.log(
    `\n  email: ${!timeline.emailLogged ? "no log yet for this tenant" : mail ? mail.evidence : "nothing logged on this deal"}`,
  );
  console.log("");
}

async function main(): Promise<void> {
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const onlyDeal = arg("--deal")?.toLowerCase();
  const onlyRep = arg("--rep")?.toLowerCase();
  const limit = Number(arg("--limit") ?? 1);

  const res = await supabaseAdmin()
    .from("deals")
    .select("id, account, rep_email, outcome_label, salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", tenantId);
  if (res.error) throw new Error(`deals read failed: ${res.error.message}`);

  let deals = (res.data ?? []) as DealRow[];
  if (onlyDeal) deals = deals.filter((d) => d.account.toLowerCase().includes(onlyDeal));
  if (onlyRep) deals = deals.filter((d) => (d.rep_email ?? "").toLowerCase() === onlyRep);
  deals = deals.slice(0, Math.max(1, limit));

  if (deals.length === 0) {
    console.log("\nNo deal matched.\n");
    return;
  }
  for (const d of deals) await printDeal(tenantId, d);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
