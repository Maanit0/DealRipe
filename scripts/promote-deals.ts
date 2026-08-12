/**
 * Deals that have just become Rolldog opportunities, and their history.
 *
 * See lib/promotion.ts for what a promotion is and why detecting it matters.
 * Short version: a rep decides a deal is real and creates the opportunity, and
 * everything DealRipe learned before that moment is sitting outside it.
 *
 *   npx tsx scripts/promote-deals.ts            # detect only
 *   npx tsx scripts/promote-deals.ts --apply    # write the history in
 *
 * Idempotent: a migrated deal has an audit row and stops being detected.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { detectPromotions, migratePromotions } from "../lib/promotion";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  const found = await detectPromotions("magaya");
  console.log("");
  if (found.length === 0) {
    console.log("No promoted deals waiting. Every linked opportunity has received its history.\n");
    return;
  }

  console.log(
    `${found.length} deal(s) gained a Rolldog opportunity and have never been written to. ` +
      `${apply ? "MIGRATING." : "Detect only."}`,
  );
  console.log("");
  for (const p of found) {
    console.log(
      `  ${p.account.padEnd(24)} opp ${p.opportunityId.padEnd(8)} ${String(p.answersCarried).padStart(2)} confirmed answer(s)` +
        ` from ${p.callsBefore} call(s)${p.salesforceAccountId ? `   was Salesforce ${p.salesforceAccountId}` : ""}`,
    );
  }

  if (!apply) {
    console.log("");
    console.log("Re-run with --apply to write that history into the opportunities.");
    console.log("");
    console.log("Note what changes at this moment: Rolldog becomes the system of record for");
    console.log("these deals, so future qualification writes there instead of to the");
    console.log("Salesforce account. The Salesforce link stays for reading context.");
    console.log("");
    return;
  }

  const done = await migratePromotions("magaya", found);
  console.log("");
  for (const p of done) {
    console.log(`  ${p.migrated ? "ok  " : "FAIL"}  ${p.account.padEnd(24)} ${p.note}`);
  }
  const ok = done.filter((p) => p.migrated).length;
  console.log("");
  console.log(`${ok} of ${done.length} migrated. Values are recorded, so Activity shows the full text.`);
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
