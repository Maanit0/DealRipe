/**
 * Is this customer in Rolldog at all, opportunity or not?
 *
 * rolldog-opp-detail.ts searches OPPORTUNITIES, and Magaya does not create one
 * until after the discovery call. So a prospect can sit in Rolldog as an account
 * for weeks and read as completely absent. On 2026-08-11 Lumistar and MLX
 * Trading Group were reported as "not in Rolldog" on that basis; the honest
 * statement was "no opportunity yet", which is a normal stage of their process
 * rather than a gap.
 *
 * Searching accounts also gives the reliable route to the opportunity later:
 * once the account id is known, list ITS opportunities instead of guessing at
 * names. "Nat Forwarding" is the account "NAT" in Rolldog, three characters, and
 * no name search was ever going to reach it.
 *
 *   npx tsx scripts/rolldog-account-search.ts --name "Lumistar"
 *   npx tsx scripts/rolldog-account-search.ts --name "MLX"
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { opportunitiesForAccount, searchAccounts } from "../lib/rolldog";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const q = arg("--name");
  if (!q) {
    console.log("\nPass --name <company>.\n");
    process.exit(1);
  }

  let accounts;
  try {
    accounts = await searchAccounts(q);
  } catch (err) {
    console.log(`\nCould not search Rolldog accounts: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`That says nothing about whether they are there. We failed to ask.\n`);
    process.exit(1);
  }

  console.log("");
  if (accounts.length === 0) {
    console.log(`"${q}"  ->  no Rolldog account. Rolldog answered and has no such customer.`);
    console.log("");
    return;
  }

  console.log(`"${q}"  ->  ${accounts.length} account(s)`);
  for (const a of accounts) {
    console.log("");
    console.log(`  ${a.id}  ${a.name}${a.website ? `  ${a.website}` : ""}${a.createdAt ? `  created ${a.createdAt.slice(0, 10)}` : ""}`);
    let opps;
    try {
      opps = await opportunitiesForAccount(a.id);
    } catch (err) {
      console.log(`      could not list opportunities: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const live = opps.filter((o) => !o.archived);
    if (opps.length === 0) {
      console.log(`      no opportunities yet, which before a discovery call is expected`);
      continue;
    }
    for (const o of opps) {
      console.log(
        `      opp ${o.id.padEnd(7)} ${(o.stageName ?? "-").padEnd(30)} owner ${o.owner ?? "?"}` +
          `  ${o.createdAt?.slice(0, 10) ?? ""}${o.archived ? "  ARCHIVED" : ""}`,
      );
    }
    if (live.length === 1) {
      console.log(`      one live opportunity: link with link-deal.ts --opp ${live[0].id} --apply`);
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
