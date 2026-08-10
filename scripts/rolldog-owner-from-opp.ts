/**
 * Turn a Rolldog opportunity a rep says is theirs into that rep's owner user id.
 *
 * REP_UID needs the owner user id, not the opportunity id, and there is no
 * screen in Rolldog that just tells you yours. Asking each rep to paste one
 * opportunity they own takes them five seconds and gives us the mapping, which
 * is how Juan's 82 and Eduardo's 79 were derived from Core Logistics and Alba
 * Wheels Up.
 *
 * This is deliberately a lookup and not a writer. It prints the REP_UID lines
 * for you to paste into lib/rolldog-reconcile.ts, because a wrong owner id
 * silently misattributes a rep's whole book during reconciliation and that
 * belongs under review.
 *
 *   npx tsx scripts/rolldog-owner-from-opp.ts 83618 80731 82005
 *   npx tsx scripts/rolldog-owner-from-opp.ts https://app.rolldog.com/opportunities/83618/overview
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { listOpportunities, searchOpportunities } from "../lib/rolldog";
import { REP_UID } from "../lib/rolldog-reconcile";

/** Accept a bare id or a pasted app.rolldog.com URL. */
function toId(raw: string): string | null {
  const m = raw.match(/opportunities\/(\d+)/);
  if (m) return m[1];
  return /^\d+$/.test(raw.trim()) ? raw.trim() : null;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  // --name is the fallback path: Rolldog's filter[search] matches account
  // names, so when no id filter works, the account name the rep pasted
  // alongside the link is what finds the record.
  const nameHint = arg("--name") ?? null;
  const skip = new Set([nameHint ?? ""]);
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--") && !skip.has(a));
  const ids = [...new Set(args.map(toId).filter((x): x is string => !!x))];
  if (ids.length === 0) {
    console.error("Usage: rolldog-owner-from-opp.ts <opp id or rolldog url> [...]");
    process.exit(1);
  }

  console.log("");
  console.log(`Looking up ${ids.length} opportunity id(s).`);
  console.log("");

  // Already-mapped owner ids, so a known rep is recognised rather than
  // presented as a new discovery.
  const knownByUid = new Map(Object.entries(REP_UID).map(([email, uid]) => [uid, email]));

  const found: Array<{ id: string; account: string; owner: string; known: string | null }> = [];

  for (const id of ids) {
    // filter[search] matches names and accounts, not ids, so passing the id as
    // a search term finds nothing. Filter on the id directly instead. Several
    // JSON:API spellings are tried because Rolldog's filter vocabulary is
    // inconsistent: the reconciler uses filter[user-id], list-rep-opps had to
    // try both filter[user-id] and filter[owner]. readOpportunity is not an
    // option here; it is gated on PILOT_OPPORTUNITY_IDS and these are not on it.
    let hit = null;
    const attempts = [`filter[id]=${id}`, `filter[opportunity-id]=${id}`, `filter[ids]=${id}`];
    for (const q of attempts) {
      try {
        const rows = await listOpportunities(`${q}&page[size]=25`);
        hit = rows.find((r) => String(r.id) === id) ?? null;
        if (hit) break;
      } catch {
        // An unsupported filter returns 400. Try the next spelling.
      }
    }

    // Last resort: the rep also gave us the account name, and that IS
    // searchable. Pass it with --name to use this path.
    if (!hit && nameHint) {
      try {
        const rows = await searchOpportunities(nameHint, { pageSize: 25 });
        hit = rows.find((r) => String(r.id) === id) ?? null;
      } catch {
        /* fall through to not-found */
      }
    }

    if (!hit) {
      console.log(`  ${id.padEnd(8)} not found in search results`);
      continue;
    }

    const owner = hit.owner ?? "(no owner on the record)";
    const known = knownByUid.get(String(owner)) ?? null;
    console.log(
      `  ${id.padEnd(8)} ${(hit.accountName || hit.name || "(unnamed)").slice(0, 38).padEnd(40)}owner ${String(owner).padEnd(8)}${known ? `already mapped to ${known}` : "NEW"}`,
    );
    found.push({ id, account: hit.accountName || hit.name || "", owner: String(owner), known });
  }

  const news = found.filter((f) => !f.known);
  console.log("");
  if (news.length === 0) {
    console.log("No new owner ids. Everything resolved to a rep already in REP_UID.");
    console.log("");
    return;
  }

  console.log("Paste into REP_UID in lib/rolldog-reconcile.ts, filling in each email:");
  console.log("");
  for (const f of news) {
    console.log(`  "<email>@magaya.com": "${f.owner}", // measured from ${f.account}`);
  }
  console.log("");
  console.log("Check the account name matches the rep who sent you that link before pasting.");
  console.log("A wrong owner id misattributes that rep's entire book, and does it silently.");
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
