/**
 * One row per upcoming call: the resolved Salesforce Account, the link
 * confidence, whether a write is authorized, and exactly which fields would be
 * written.
 *
 * Every judgement here is imported, not restated:
 *   resolveAccountForDeal          lib/salesforce-link.ts
 *   resolveSalesforceWriteTarget   lib/salesforce-scope.ts
 *   writeBackDealToSalesforce      lib/salesforce-writeback-run.ts (dry run)
 *
 * That is deliberate. Two of the four bad calls in this codebase's history came
 * from a script reimplementing a rule and drifting from it, and one of those
 * reported four writable deals as blocked on the day one of them wrote.
 *
 *   npx tsx scripts/salesforce-writeback-preflight.ts
 *   npx tsx scripts/salesforce-writeback-preflight.ts --deal beyond-pegasus
 *   npx tsx scripts/salesforce-writeback-preflight.ts --days 7
 *
 * READ-ONLY. It calls the write path with apply omitted, which is a dry run.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { resolutionSummary } from "../lib/salesforce-context";
import { resolveAccountForDeal } from "../lib/salesforce-link";
import { resolveSalesforceWriteTarget, salesforceWritebackEnabled } from "../lib/salesforce-scope";
import { writeBackDealToSalesforce } from "../lib/salesforce-writeback-run";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { formatMeetingTime } from "../lib/graph-time";

const SLUG = "magaya";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? null) : null;
}

function domainOfDeal(externalId: string | null): { domain: string | null; address: string | null } {
  if (!externalId?.startsWith("auto:")) return { domain: null, address: null };
  const tail = externalId.slice("auto:".length);
  if (tail.includes("@")) return { domain: tail.split("@")[1] ?? null, address: tail };
  return { domain: tail, address: null };
}

async function main(): Promise<void> {
  const days = Number(arg("days") ?? 14) || 14;
  const only = arg("deal");
  const tenantId = await resolveTenantId(SLUG);
  const db = supabaseAdmin();

  console.log(
    `\nSalesforce write-back preflight, next ${days} day(s)` +
      `\nglobal switch: ${salesforceWritebackEnabled() ? "ON (SALESFORCE_WRITEBACK_ENABLED=1)" : "OFF (SALESFORCE_WRITEBACK_ENABLED is not '1')"}\n`,
  );

  const calls = await db
    .from("calls")
    .select("deal_id, title, scheduled_start")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", new Date().toISOString())
    .lte("scheduled_start", new Date(Date.now() + days * 86_400_000).toISOString())
    .order("scheduled_start", { ascending: true });
  if (calls.error) {
    console.error(`could not list upcoming calls: ${calls.error.message}`);
    process.exit(1);
  }

  const seen = new Set<string>();
  let rows = 0;

  for (const c of calls.data ?? []) {
    if (!c.deal_id || seen.has(c.deal_id)) continue;
    seen.add(c.deal_id);

    const deal = await db
      .from("deals")
      .select("id, account, external_id")
      .eq("tenant_id", tenantId)
      .eq("id", c.deal_id)
      .maybeSingle();
    if (deal.error || !deal.data) continue;
    if (only && !`${deal.data.external_id ?? ""} ${deal.data.account}`.toLowerCase().includes(only.toLowerCase())) {
      continue;
    }
    rows += 1;

    const { domain, address } = domainOfDeal(deal.data.external_id);
    const { resolution, stored } = await resolveAccountForDeal({
      tenantId,
      dealId: deal.data.id,
      dealAccountName: deal.data.account,
      domain,
      addresses: address ? [address] : [],
      meetingSubject: c.title ?? null,
    });

    console.log(`${formatMeetingTime(c.scheduled_start ?? undefined)}   ${c.title ?? "(no subject)"}`);
    console.log(`   deal        ${deal.data.account}  [${deal.data.external_id ?? "no external id"}]`);
    console.log(`   resolved    ${resolutionSummary(resolution)}`);

    // The stored link is what the write path actually consults, so report it
    // separately from what a fresh resolution would say. If they disagree, the
    // sweep has not been applied yet and that is worth seeing.
    const linkLine =
      stored.status === "linked"
        ? `${stored.accountId} (${stored.confidence})`
        : stored.status === "schema_missing"
          ? "NOT MIGRATED: run supabase/add-deal-salesforce-link.sql"
          : stored.status === "none"
            ? "none stored (run scripts/sync-salesforce-links.ts --apply)"
            : `unreadable (${stored.status})`;
    console.log(`   stored link ${linkLine}`);

    const target = resolveSalesforceWriteTarget({
      salesforce_account_id: stored.status === "linked" ? stored.accountId : null,
      salesforce_link_confidence: stored.status === "linked" ? stored.confidence : null,
    });
    console.log(
      `   authorized  ${target.authorized ? `YES via ${target.route} route -> ${target.accountId}` : `NO: ${target.reason}`}`,
    );

    // Dry run through the real write path, so the fields shown are the fields
    // that would actually go.
    const dry = await writeBackDealToSalesforce(SLUG, deal.data.external_id ?? "", {
      callId: null,
      callDate: c.scheduled_start ?? null,
    });
    if (dry.plan) {
      if (dry.plan.writes.length === 0) {
        console.log(`   would write nothing`);
      } else {
        for (const w of dry.plan.writes) {
          console.log(`   would write ${w.label} (${w.apiName}, ${w.mode}): ${w.display.slice(0, 110)}`);
        }
      }
      for (const s of dry.plan.skips) {
        console.log(`   skipped     ${s.label}: ${s.reason}`);
      }
    } else {
      console.log(`   plan        none: ${dry.reason}`);
    }
    console.log("");
  }

  if (rows === 0) console.log("No matching upcoming calls.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
