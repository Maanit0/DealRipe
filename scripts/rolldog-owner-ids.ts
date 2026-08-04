/**
 * Discover Rolldog owner user-ids so REP_UID in lib/rolldog-reconcile.ts can be
 * extended past Juan and Eduardo.
 *
 * Reconciliation (the job that links a deal to its Rolldog opportunity once a
 * BDR converts the lead) walks each rep's own opportunities. REP_UID is a
 * hand-measured map of rep -> Rolldog user-id, so any rep missing from it is
 * silently skipped and their deals never get linked or backfilled. The four AEs
 * going live August 10 are all missing.
 *
 * Rolldog exposes no users endpoint, but every opportunity carries its owner's
 * user-id. So: pull the newest opportunities, group by owner, and print the
 * accounts each owner holds. Recognise the accounts, and you have the rep.
 *
 *   npx tsx scripts/rolldog-owner-ids.ts
 *   npx tsx scripts/rolldog-owner-ids.ts --pages 10 --sample 12
 *
 * Read only. Lists opportunity metadata and writes nothing.
 * Must run on your Mac: the sandbox has no network route to Rolldog.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { listOpportunities, type OppSummary } from "../lib/rolldog";
import { REP_UID } from "../lib/rolldog-reconcile";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Reverse REP_UID so a discovered id can be labelled if we already know it. */
function knownRepFor(uid: string): string | null {
  for (const [rep, id] of Object.entries(REP_UID)) if (id === uid) return rep;
  return null;
}

async function main(): Promise<void> {
  const pages = arg("--pages", 6);
  const sample = arg("--sample", 8);

  const all: OppSummary[] = [];
  for (let page = 1; page <= pages; page++) {
    const rows = await listOpportunities(`sort=-created-at&page[size]=200&page[number]=${page}`);
    if (rows.length === 0) break;
    all.push(...rows);
    if (rows.length < 200) break;
  }

  if (all.length === 0) {
    console.log("\nNo opportunities returned. Check ROLLDOG credentials in .env.local.\n");
    return;
  }

  // Group by owner, newest first (the listing is already sorted -created-at).
  const byOwner = new Map<string, OppSummary[]>();
  for (const o of all) {
    const uid = o.owner ?? "(no owner)";
    const list = byOwner.get(uid);
    if (list) list.push(o);
    else byOwner.set(uid, [o]);
  }

  const owners = [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length);

  console.log(`\nScanned ${all.length} opportunities across ${owners.length} owners.\n`);
  console.log("Match the accounts below to a rep, then add that user-id to REP_UID");
  console.log("in lib/rolldog-reconcile.ts (and widen the RepKey union).\n");

  for (const [uid, opps] of owners) {
    const known = knownRepFor(uid);
    const label = known ? `  <-- already mapped: ${known}` : "";
    console.log(`user-id ${uid}   (${opps.length} opportunities)${label}`);
    for (const o of opps.slice(0, sample)) {
      const created = o.createdAt ? o.createdAt.slice(0, 10) : "unknown date";
      const stage = o.stageName ?? "no stage";
      console.log(`    ${created}  ${o.accountName || o.name}  [${stage}]`);
    }
    if (opps.length > sample) console.log(`    ... and ${opps.length - sample} more`);
    console.log("");
  }

  const unmapped = owners.filter(([uid]) => !knownRepFor(uid) && uid !== "(no owner)");
  console.log(`Currently mapped: ${Object.entries(REP_UID).map(([r, i]) => `${r}=${i}`).join(", ")}`);
  console.log(`Unmapped owner ids seen: ${unmapped.map(([u]) => u).join(", ") || "(none)"}\n`);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
