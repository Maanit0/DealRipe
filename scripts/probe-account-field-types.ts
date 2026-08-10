/**
 * What can DealRipe actually write to the Sales Development fields?
 *
 * Reading a field and writing it are different permissions and different
 * problems. This prints, for each field: its API name, its Salesforce type,
 * whether the integration user may update it, its maximum length, and its
 * picklist values where it has them.
 *
 * Run this before building any write mapping. Half the section is checkboxes
 * ("Compelling Events", "Budget Confirmed", "Does lead have a warehouse?"),
 * one is a date, and at least one is a picklist with fixed values. A mapping
 * built on the assumption that they are all text produces 400s on some fields
 * and, worse, silently plausible garbage on others.
 *
 *   npx tsx scripts/probe-account-field-types.ts
 *
 * READ ONLY. One describe call.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { accountFieldMeta } from "../lib/salesforce-context";

async function main(): Promise<void> {
  const meta = await accountFieldMeta();

  console.log("");
  console.log(`SALES DEVELOPMENT FIELDS  ·  ${meta.size} visible to the integration user`);
  console.log("");
  console.log(`${"LABEL".padEnd(34)}${"API NAME".padEnd(36)}${"TYPE".padEnd(14)}${"WRITE".padEnd(8)}LIMIT`);
  console.log("-".repeat(110));

  const byType = new Map<string, number>();
  let notWritable = 0;

  for (const [label, f] of meta) {
    byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
    if (!f.updateable) notWritable += 1;
    console.log(
      `${label.slice(0, 32).padEnd(34)}${f.name.padEnd(36)}${f.type.padEnd(14)}${(f.updateable ? "yes" : "NO").padEnd(8)}${
        f.length ? String(f.length) : ""
      }`,
    );
    if (f.picklistValues.length > 0) {
      console.log(`${" ".repeat(34)}values: ${f.picklistValues.slice(0, 12).join(" | ")}`);
    }
  }

  console.log("");
  console.log("BY TYPE");
  for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(3)}  ${t}`);
  }

  if (notWritable > 0) {
    console.log("");
    console.log(`${notWritable} field(s) are readable but NOT updateable by this user.`);
    console.log("Those need a field-level security change from Ernesto before anything can");
    console.log("be written to them. Send him the API names above rather than the labels.");
  }
  console.log("");
  console.log("Nothing was written. This is a describe call only.");
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
