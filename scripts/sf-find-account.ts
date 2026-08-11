/**
 * Does a Salesforce Account exist for this company, and would we ever find it?
 *
 * Two different questions, and conflating them is how "no Salesforce context"
 * gets reported for a company that is plainly in the CRM. Our resolver works by
 * email domain. A customer who books from a personal address gives us nothing to
 * resolve, so a real, well-populated Account sits there unread and the briefing
 * says nothing about it. Gezairi is exactly that case: a ten-country forwarder
 * whose only attendee address on the invite is a gmail one.
 *
 * So this reports both, separately:
 *
 *   BY NAME    what actually exists in Salesforce
 *   BY DOMAIN  what our resolver would have found from the invite
 *
 * A row in the first and nothing in the second is not a data gap. It is a
 * lookup gap, and the fix is a name search, not a new record.
 *
 *   npx tsx scripts/sf-find-account.ts --name Gezairi
 *   npx tsx scripts/sf-find-account.ts --name Gezairi --domain gmail.com --email manele.khoury@gmail.com
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { findAccountsByName, getAccountContextByDomain, accountContextLines } from "../lib/salesforce-context";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const name = arg("--name");
  const domain = arg("--domain");
  const email = arg("--email");
  if (!name && !domain) {
    console.log("\nUsage: --name <company> [--domain <domain>] [--email <address>]\n");
    process.exit(1);
  }

  if (name) {
    console.log("");
    console.log(`BY NAME  "${name}"`);
    let rows;
    try {
      rows = await findAccountsByName(name, 12);
    } catch (e) {
      // Say which of the two it is. A thrown error here means we did not learn
      // anything, which is not the same as learning there is no account.
      console.log(`  LOOKUP FAILED: ${e instanceof Error ? e.message : String(e)}`);
      console.log(`  This does NOT mean the account is absent. It means we could not check.`);
      rows = null;
    }
    if (rows) {
      if (rows.length === 0) {
        console.log(`  No account whose name contains "${name}".`);
      } else {
        for (const r of rows) {
          console.log(`  ${r.id}  ${r.name}`);
          console.log(`  ${" ".repeat(18)}website ${r.website ?? "(blank)"}   contacts ${r.contacts}`);
        }
      }
    }
  }

  if (domain) {
    console.log("");
    console.log(`BY DOMAIN  "${domain}"${email ? `  (exact address ${email})` : ""}`);
    try {
      const ctx = await getAccountContextByDomain(domain, email ? [email] : []);
      if (!ctx) {
        console.log(`  Our resolver finds nothing from this domain.`);
        console.log(`  If the name search above returned a row, the account exists and we simply cannot reach it from the invite.`);
      } else {
        console.log(`  ${ctx.accountName}`);
        const lines = accountContextLines(ctx).trim();
        console.log(lines ? lines.split("\n").map((l) => `  ${l}`).join("\n") : "  (account matched, its BDR fields are empty)");
      }
    } catch (e) {
      console.log(`  LOOKUP FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
