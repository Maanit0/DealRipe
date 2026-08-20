/**
 * Pull each rep's mailbox into deal_messages.
 *
 * DealRipe has read the mailbox since before the pilot and kept none of it, so
 * "the customer has gone quiet" and "we never looked" are currently the same
 * absence. Ten deals are flagged as losing momentum right now with the caveat
 * "this counts calls only". This is what removes the caveat.
 *
 * Every rule is imported from lib/email-log.ts. Nothing here restates one.
 *
 *   npx tsx scripts/ingest-email-log.ts                 dry run, 60 days
 *   npx tsx scripts/ingest-email-log.ts --days 90
 *   npx tsx scripts/ingest-email-log.ts --mailbox ebencomo@magaya.com
 *   npx tsx scripts/ingest-email-log.ts --apply         WRITES
 *
 * Dry run by default. --apply writes to deal_messages and nothing else. It
 * never writes to a CRM and never stores a message body.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { ingestMailbox } from "../lib/email-log";
import { allowedMailboxes } from "../lib/graph-mail";
import { autoJoinRepEmails } from "../lib/pilot-config";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";
const GRAPH_TENANT = "magaya.com";
const SELLER_DOMAIN = "magaya.com";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const days = Number(arg("--days") ?? 60);
  if (!Number.isFinite(days) || days <= 0) {
    console.error("--days must be a positive number");
    process.exit(1);
  }
  const one = arg("--mailbox")?.toLowerCase();

  // allowedMailboxes is the only boundary between this and every mailbox in
  // Magaya's tenant, because the Application Access Policy was declined. Every
  // mailbox is intersected with it rather than trusted from pilot config.
  const allowed = new Set(allowedMailboxes().map((m) => m.toLowerCase()));
  let mailboxes = autoJoinRepEmails().map((m) => m.toLowerCase());
  if (one) mailboxes = mailboxes.filter((m) => m === one);
  const skipped = mailboxes.filter((m) => !allowed.has(m));
  mailboxes = mailboxes.filter((m) => allowed.has(m));

  const since = new Date(Date.now() - days * 86_400_000);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`${apply ? "INGESTING" : "DRY RUN"}: email log, ${days} days back to ${since.toISOString().slice(0, 10)}`);
  console.log(`${mailboxes.length} mailbox(es). Bodies are never stored.`);
  if (skipped.length > 0) {
    console.log(`\n  NOT READ, outside GRAPH_MAIL_ALLOWED_MAILBOXES: ${skipped.join(", ")}`);
  }
  console.log(`${"=".repeat(80)}\n`);

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const totals = { read: 0, written: 0, noDeal: 0, freeMail: 0 };

  for (const mailbox of mailboxes) {
    const r = await ingestMailbox({
      tenantId,
      graphTenant: GRAPH_TENANT,
      mailbox,
      sellerDomain: SELLER_DOMAIN,
      since,
      dryRun: !apply,
    });
    totals.read += r.messagesRead;
    totals.written += r.rowsWritten;
    totals.noDeal += r.skippedNoDeal;
    totals.freeMail += r.skippedFreeMail;

    console.log(
      `  ${mailbox.padEnd(26)} read ${String(r.messagesRead).padStart(5)}   ` +
        `matched ${String(r.rowsWritten).padStart(5)}   ` +
        `no deal ${String(r.skippedNoDeal).padStart(4)}   free-mail ${String(r.skippedFreeMail).padStart(3)}`,
    );
    for (const e of r.errors) console.log(`      ERROR: ${e}`);
  }

  console.log(`\n${"-".repeat(80)}`);
  console.log(
    `  ${totals.read} message(s) read, ${totals.written} matched to a deal, ` +
      `${totals.noDeal} on a domain we could not map, ${totals.freeMail} free-mail only`,
  );
  console.log(
    `  A message on an unmappable domain is not a failure: it is mail with a\n` +
      `  customer we have no deal for, which is a fact about coverage.`,
  );
  console.log(`${"-".repeat(80)}`);
  if (!apply) console.log(`\nDRY RUN. Nothing written. Re-run with --apply.\n`);
  else console.log("");
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
