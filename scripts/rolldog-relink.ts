/**
 * Links unlinked captured deals to their newly-created Rolldog opportunities and
 * backfills the captured data. Confirmed matches only (unambiguous + recent);
 * review/none are printed but never linked.
 *
 *   npx tsx scripts/rolldog-relink.ts            # preview (no writes)
 *   npx tsx scripts/rolldog-relink.ts --commit   # link + backfill confirmed
 *
 * Runs on your Mac. --commit stamps the link on the deal, refreshes the extraction,
 * and writes back to the newly-authorized opp (scope-safe via writeBackDealToRolldog).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { applyConfirmedLinks, findLinkMatches } from "../lib/rolldog-reconcile";

async function main(): Promise<void> {
  const commit = process.argv.includes("--commit");
  const matches = await findLinkMatches("magaya");
  const confirmed = matches.filter((m) => m.status === "confirmed");

  console.log(`\nMatches: ${confirmed.length} confirmed, ${matches.filter((m) => m.status === "review").length} review, ${matches.filter((m) => m.status === "none").length} none.`);
  for (const m of confirmed) console.log(`  ✓ ${m.account} (${m.rep}) -> opp ${m.opp?.id} "${m.opp?.accountName}"`);

  if (!commit) {
    console.log(`\nPreview only. Re-run with --commit to link + backfill the confirmed matches.\n`);
    return;
  }
  if (confirmed.length === 0) {
    console.log(`\nNothing to link.\n`);
    return;
  }

  console.log(`\nLinking + backing up ${confirmed.length} deal(s)...\n`);
  const results = await applyConfirmedLinks("magaya", confirmed);
  for (const r of results) {
    if (r.linked) {
      const wb = r.writeback;
      const fields = wb?.results?.filter((x) => x.status === "ok").flatMap((x) => x.fieldsWritten) ?? [];
      console.log(`  ✓ ${r.account} -> opp ${r.oppId}  ${wb?.written ? `wrote: ${fields.join(", ") || "(no fields)"}` : `write skipped: ${wb?.reason ?? "?"}`}`);
    } else {
      console.log(`  ✗ ${r.account} -> opp ${r.oppId}  link failed: ${r.error}`);
    }
  }
  console.log(`\nDone.\n`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
