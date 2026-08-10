/**
 * Everything we can see about specific Rolldog opportunities.
 *
 * Written for the TOC/ProTrans question: Alexandra pasted opportunity 80731
 * named "TOC LOGISTICS - INBOND ONLY", and her Wednesday meeting is "TOC
 * Inbond Additional Session" with attendees at protrans.com whose Salesforce
 * account is "ProTrans". Three different names for what may or may not be one
 * customer. Before pinning that in the crosswalk, the opportunity's own
 * account name, owner and stage decide it.
 *
 *   npx tsx scripts/rolldog-opp-detail.ts --name "TOC LOGISTICS"
 *   npx tsx scripts/rolldog-opp-detail.ts --name "ProTrans"
 *   npx tsx scripts/rolldog-opp-detail.ts --name "TQL GLOBAL" --open-only
 *
 * Searches by name because Rolldog does not support filtering opportunities by
 * id, and readOpportunity is gated to the pilot allowlist. Prints the owner
 * against REP_UID so you can see whose deal it is.
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { searchOpportunities } from "../lib/rolldog";
import { REP_UID } from "../lib/rolldog-reconcile";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function day(iso: string | null): string {
  if (!iso) return "-";
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return iso;
  }
}

async function main(): Promise<void> {
  const name = arg("--name");
  const openOnly = process.argv.includes("--open-only");
  const wantId = arg("--id");
  if (!name) {
    console.error('Usage: --name "<account or opportunity name>" [--id 80731] [--open-only]');
    process.exit(1);
  }

  const ownerToEmail = new Map(Object.entries(REP_UID).map(([email, uid]) => [uid, email]));

  const rows = await searchOpportunities(name, { pageSize: 50 });
  const filtered = rows
    .filter((r) => (wantId ? String(r.id) === wantId : true))
    .filter((r) => (openOnly ? !r.archived : true));

  console.log("");
  console.log(`"${name}"  ->  ${filtered.length} opportunity(ies)${openOnly ? " (open only)" : ""}`);
  console.log("");
  console.log(
    `${"ID".padEnd(9)}${"ACCOUNT".padEnd(34)}${"OPPORTUNITY".padEnd(38)}${"STAGE".padEnd(30)}${"OWNER".padEnd(24)}CREATED`,
  );
  console.log("-".repeat(150));

  for (const r of filtered.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))) {
    const owner = String(r.owner ?? "");
    const who = ownerToEmail.get(owner);
    console.log(
      `${String(r.id).padEnd(9)}${(r.accountName || "-").slice(0, 32).padEnd(34)}${(r.name || "-").slice(0, 36).padEnd(38)}${(r.stageName || "-").slice(0, 28).padEnd(30)}${(who ? who.split("@")[0] : owner || "-").padEnd(24)}${day(r.createdAt)}${r.archived ? "   ARCHIVED" : ""}`,
    );
  }

  console.log("");
  console.log("The ACCOUNT column is what the reconciler matches deals against.");
  console.log("If it differs from the email domain and the Salesforce account name,");
  console.log("no automatic match will ever find it and it needs a crosswalk entry.");
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
