/**
 * Which Salesforce Account each upcoming deal resolves to, and why.
 *
 * Read-only by default. `--apply` writes ONLY `confirmed` resolutions (an email
 * domain or exact contact address matched). A name-only match prints as
 * `review` and is left alone, and several candidates print as `ambiguous` with
 * the candidates listed, because that is a state a human resolves and never one
 * the code should guess at.
 *
 * The sweep itself lives in lib/salesforce-relink.ts and is the SAME function
 * the salesforce-relink cron runs. This file only formats it. A diagnostic that
 * reimplements the rule it checks will drift from it, and has here before.
 *
 *   npx tsx scripts/sync-salesforce-links.ts
 *   npx tsx scripts/sync-salesforce-links.ts --days 14
 *   npx tsx scripts/sync-salesforce-links.ts --deal beyond-pegasus
 *   npx tsx scripts/sync-salesforce-links.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { sweepSalesforceLinks } from "../lib/salesforce-relink";

const SLUG = "magaya";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const days = Number(arg("days") ?? 14) || 14;
  const dealFilter = arg("deal");

  const sweep = await sweepSalesforceLinks(SLUG, { days, apply, dealFilter });

  console.log(
    `\n${apply ? "APPLYING" : "DRY RUN"}: Salesforce links for ${sweep.rows.length} deal(s) with a call in the next ${days} day(s)\n`,
  );

  for (const r of sweep.rows) {
    const current =
      r.stored.status === "linked"
        ? `${r.stored.accountId} (${r.stored.confidence})`
        : r.stored.status === "schema_missing"
          ? "unknown (link columns not migrated yet)"
          : r.stored.status === "none"
            ? "none"
            : `unreadable (${r.stored.status})`;

    console.log(`${r.account}`);
    console.log(`   external    ${r.externalId ?? "(none)"}`);
    console.log(`   current     ${current}`);
    console.log(`   resolved    ${r.summary}`);

    switch (r.resolution.status) {
      case "resolved_by_domain":
        if (r.write) {
          console.log(
            `   write       ${r.write.written ? `linked to ${r.resolution.accountId} (confirmed)` : `NOT written: ${r.write.reason}`}`,
          );
        } else {
          console.log(`   would write ${r.resolution.accountId} (confirmed)`);
        }
        break;
      case "resolved_by_name":
        console.log(`   write       held back: a name match is not enough to authorize a CRM write.`);
        break;
      case "ambiguous":
        for (const c of r.resolution.candidates) {
          console.log(`     candidate ${c.id}  ${c.name}  ${c.contacts} contact(s)  ${c.website ?? "no website"}`);
        }
        console.log(`   write       held back: a rep has to say which of these is the customer.`);
        break;
      case "lookup_failed":
        console.log(`   write       held back: we did not get an answer, so nothing is recorded.`);
        break;
      default:
        break;
    }
    console.log("");
  }

  const c = sweep.counts;
  console.log("SUMMARY");
  console.log(`   confirmed (writable)   ${c.confirmed}`);
  console.log(`   name match (review)    ${c.review}`);
  console.log(`   ambiguous              ${c.ambiguous}`);
  console.log(`   no account             ${c.noAccount}`);
  console.log(`   lookup failed          ${c.lookupFailed}`);
  if (apply) console.log(`   links written          ${c.written}`);

  if (sweep.schemaMissing) {
    console.log(
      `\nNo link could be stored: the salesforce_account_id / salesforce_link_confidence` +
        `\ncolumns do not exist yet. Run supabase/add-deal-salesforce-link.sql in the` +
        `\nSupabase SQL editor, then re-run with --apply. The resolutions above are live` +
        `\nSalesforce answers and are unaffected by this.`,
    );
  }
  if (!apply && c.confirmed > 0) {
    console.log(`\nRe-run with --apply to write the ${c.confirmed} confirmed link(s).`);
  }
  if (c.lookupFailed > 0) {
    console.log(
      `\n${c.lookupFailed} deal(s) could not be checked. That is not "no account": re-run before` +
        `\ndrawing any conclusion about them.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
