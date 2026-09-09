/**
 * List what actually rode along on each message.
 *
 *   npx tsx scripts/ingest-attachments.ts               # dry run
 *   npx tsx scripts/ingest-attachments.ts --apply       # WRITES
 *   npx tsx scripts/ingest-attachments.ts --apply --limit 800
 *
 * One Graph GET per message that Graph says carries an attachment, so it is
 * bounded and re-runnable. Inline signature furniture is filtered inside
 * listMessageAttachments and counted rather than silently dropped.
 *
 * METADATA ONLY. No file bytes are stored: that needs a private Storage bucket
 * that does not exist, and createBucket defaults to public.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { ingestAttachments } from "../lib/deal-attachments";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const GRAPH_TENANT = process.env.GRAPH_TENANT_DOMAIN ?? "magaya.com";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = await resolveTenantId("magaya");
  const r = await ingestAttachments({
    tenantId,
    graphTenant: GRAPH_TENANT,
    limit: Number(arg("--limit") ?? 400),
    dryRun: !apply,
  });

  console.log(`\n  messages to list:   ${r.messagesConsidered}`);
  if (!apply) {
    console.log("\n  Dry run. Re-run with --apply to write.\n");
    return;
  }
  console.log(`  listed OK:          ${r.listed}`);
  console.log(`  unavailable:        ${r.unavailable}   <- transient, retried next run`);
  console.log(`  message gone:       ${r.gone}          <- permanent`);
  console.log(`\n  real attachments:   ${r.attachmentsFound}`);
  console.log(`  inline skipped:     ${r.inlineSkipped}   <- signature logos, NOT documents`);
  console.log(`  by class:`, r.byClass);
  console.log(`  deals with a real file: ${r.dealsTouched}\n`);
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
