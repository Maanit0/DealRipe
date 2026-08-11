/**
 * Which Salesforce Account each upcoming deal resolves to, and why.
 *
 * Read-only by default. `--apply` writes ONLY `confirmed` resolutions (an email
 * domain or exact contact address matched). A name-only match is printed as
 * `review` and left alone, and several candidates print as `ambiguous` with the
 * candidates listed, because that is a state a human resolves and never one the
 * code should guess at.
 *
 * This imports resolveAccountForDeal from lib rather than restating the rules.
 * A checker that can disagree with the code it checks will, and confidently.
 *
 *   npx tsx scripts/sync-salesforce-links.ts
 *   npx tsx scripts/sync-salesforce-links.ts --days 14
 *   npx tsx scripts/sync-salesforce-links.ts --deal beyond-pegasus.co.uk
 *   npx tsx scripts/sync-salesforce-links.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { resolutionSummary } from "../lib/salesforce-context";
import { resolveAccountForDeal, writeSalesforceLink } from "../lib/salesforce-link";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SLUG = "magaya";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? null) : null;
}

/** The customer domain a deal was created from. auto:<domain> or auto:<address>. */
function domainOfDeal(externalId: string | null): { domain: string | null; address: string | null } {
  if (!externalId?.startsWith("auto:")) return { domain: null, address: null };
  const tail = externalId.slice("auto:".length);
  if (tail.includes("@")) return { domain: tail.split("@")[1] ?? null, address: tail };
  return { domain: tail, address: null };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const days = Number(arg("days") ?? 14) || 14;
  const only = arg("deal");
  const tenantId = await resolveTenantId(SLUG);
  const db = supabaseAdmin();

  const nowIso = new Date().toISOString();
  const endIso = new Date(Date.now() + days * 86_400_000).toISOString();

  const calls = await db
    .from("calls")
    .select("deal_id, title, scheduled_start")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", nowIso)
    .lte("scheduled_start", endIso)
    .order("scheduled_start", { ascending: true });
  if (calls.error) {
    console.error(`could not list upcoming calls: ${calls.error.message}`);
    process.exit(1);
  }

  // One row per deal, keeping the earliest upcoming call's subject as the
  // identifier to mine a company name from.
  const byDeal = new Map<string, { subject: string | null }>();
  for (const c of calls.data ?? []) {
    if (!c.deal_id || byDeal.has(c.deal_id)) continue;
    byDeal.set(c.deal_id, { subject: c.title ?? null });
  }

  if (byDeal.size === 0) {
    console.log(`No calls scheduled in the next ${days} days. Nothing to resolve.`);
    return;
  }

  const deals = await db
    .from("deals")
    .select("id, account, external_id, salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", tenantId)
    .in("id", [...byDeal.keys()]);
  if (deals.error) {
    // The two new columns arrive in supabase/add-deal-salesforce-link.sql. Say
    // that plainly rather than reporting every deal as unlinked.
    if (/column .* does not exist/i.test(deals.error.message)) {
      console.error(
        "The salesforce link columns are not in the database yet.\n" +
          "Run supabase/add-deal-salesforce-link.sql in the Supabase SQL editor, then re-run this.\n" +
          `(${deals.error.message})`,
      );
      process.exit(1);
    }
    console.error(`could not load deals: ${deals.error.message}`);
    process.exit(1);
  }

  console.log(
    `\n${apply ? "APPLYING" : "DRY RUN"}: Salesforce links for ${deals.data?.length ?? 0} deal(s) with a call in the next ${days} day(s)\n`,
  );

  let confirmed = 0;
  let review = 0;
  let ambiguous = 0;
  let none = 0;
  let failed = 0;
  let written = 0;

  for (const d of deals.data ?? []) {
    if (only && !(d.external_id ?? "").includes(only) && !d.account.toLowerCase().includes(only.toLowerCase())) {
      continue;
    }
    const { domain, address } = domainOfDeal(d.external_id);
    const subject = byDeal.get(d.id)?.subject ?? null;

    const { resolution, fresh } = await resolveAccountForDeal({
      tenantId,
      dealId: d.id,
      dealAccountName: d.account,
      domain,
      addresses: address ? [address] : [],
      meetingSubject: subject,
      force: true, // this sweep is the thing that establishes links, so always look
    });

    const current = d.salesforce_account_id
      ? `${d.salesforce_account_id} (${d.salesforce_link_confidence ?? "?"})`
      : "none";

    console.log(`${d.account}`);
    console.log(`   external    ${d.external_id ?? "(none)"}`);
    console.log(`   current     ${current}`);
    console.log(`   resolved    ${resolutionSummary(resolution)}${fresh ? "" : " [from stored link]"}`);

    switch (resolution.status) {
      case "resolved_by_domain": {
        confirmed += 1;
        if (apply) {
          const w = await writeSalesforceLink(tenantId, d.id, resolution.accountId, "confirmed");
          console.log(`   write       ${w.written ? `linked to ${resolution.accountId} (confirmed)` : `NOT written: ${w.reason}`}`);
          if (w.written) written += 1;
        } else {
          console.log(`   would write ${resolution.accountId} (confirmed)`);
        }
        break;
      }
      case "resolved_by_name": {
        review += 1;
        console.log(
          `   write       held back: a name match is not enough to authorize a CRM write. Confirm with --deal and a human eye.`,
        );
        break;
      }
      case "ambiguous": {
        ambiguous += 1;
        for (const c of resolution.candidates) {
          console.log(`     candidate ${c.id}  ${c.name}  ${c.contacts} contact(s)  ${c.website ?? "no website"}`);
        }
        console.log(`   write       held back: a rep has to say which of these is the customer.`);
        break;
      }
      case "lookup_failed": {
        failed += 1;
        console.log(`   write       held back: we did not get an answer, so nothing is recorded.`);
        break;
      }
      default:
        none += 1;
    }
    console.log("");
  }

  console.log("SUMMARY");
  console.log(`   confirmed (writable)   ${confirmed}`);
  console.log(`   name match (review)    ${review}`);
  console.log(`   ambiguous              ${ambiguous}`);
  console.log(`   no account             ${none}`);
  console.log(`   lookup failed          ${failed}`);
  if (apply) console.log(`   links written          ${written}`);
  if (!apply && confirmed > 0) console.log(`\nRe-run with --apply to write the ${confirmed} confirmed link(s).`);
  if (failed > 0) {
    console.log(
      `\n${failed} deal(s) could not be checked. That is not "no account": re-run before drawing any conclusion about them.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
