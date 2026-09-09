/**
 * Fetch and store bodies for rows that predate the body columns.
 *
 *   npx tsx scripts/backfill-message-bodies.ts                  # dry run
 *   npx tsx scripts/backfill-message-bodies.ts --apply          # WRITES
 *   npx tsx scripts/backfill-message-bodies.ts --apply --limit 400
 *   npx tsx scripts/backfill-message-bodies.ts --apply --days 120 --mailbox ebencomo@magaya.com
 *
 * THE EXPENSIVE ONE. Every row is a Graph GET, so run
 * scripts/backfill-message-signals.ts first: it is free, and it marks machine
 * senders and calendar responses as 'skipped' so this walks past them instead
 * of fetching a body nobody should keep.
 *
 * IT IMPORTS fillMissingBodies RATHER THAN REIMPLEMENTING IT, so a backfilled
 * body is byte-identical to an ingested one. Two code paths that both "trim and
 * store a body" would drift, and the drift would be invisible because both
 * produce plausible text. A diagnostic imports production logic or it does not
 * exist.
 *
 * RUN IT SOON. Graph retains mail for months, not forever, and a message the
 * rep deletes is gone: readMessageBody records that as 'gone' and never retries
 * it. Every day this waits, a few more rows become permanently unrecoverable.
 *
 * Newest first, deliberately. If this is interrupted, the rows that matter most
 * to a live deal are the ones already done.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { fillMissingBodies } from "../lib/email-log";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const GRAPH_TENANT = process.env.GRAPH_TENANT_DOMAIN ?? "magaya.com";

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * PAGINATED. PostgREST caps a plain select at 1000 rows and says nothing about
 * it, so the first version of this reported a tidy status table covering the
 * first 1000 of 2,495 messages and looked completely plausible. That is the
 * third time today the same cap has produced a confident wrong number; assume
 * any select without a range() here is lying about the tail.
 */
async function statuses(tenantId: string): Promise<Record<string, number>> {
  const db = supabaseAdmin();
  const out: Record<string, number> = {};
  let seen = 0;
  for (let from = 0; ; from += 1000) {
    const res = await db
      .from("deal_messages")
      .select("body_status")
      .eq("tenant_id", tenantId)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (res.error) throw new Error(`status read failed: ${res.error.message}`);
    for (const r of res.data ?? []) {
      const k = r.body_status ?? "(null, predates the column)";
      out[k] = (out[k] ?? 0) + 1;
    }
    seen += (res.data ?? []).length;
    if ((res.data ?? []).length < 1000) break;
  }

  const { count } = await db.from("deal_messages").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId);
  if (typeof count === "number" && count !== seen) {
    throw new Error(`counted ${seen} rows but the table reports ${count}; the status table would be wrong`);
  }
  return out;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const reprocess = process.argv.includes("--reprocess");
  const limit = Number(arg("--limit") ?? 200);
  const days = arg("--days") ? Number(arg("--days")) : undefined;
  const mailbox = arg("--mailbox");
  const tenantId = await resolveTenantId("magaya");

  console.log("\n  body_status before:");
  for (const [k, v] of Object.entries(await statuses(tenantId))) console.log(`    ${k.padEnd(34)} ${v}`);

  // REPROCESS. Rows fetched before 2026-09-08 hold a trimmed body and nothing
  // else: no body_preview, no raw customer text, and 195 of them were trimmed
  // to an empty string by a quoted-tail cut that fired on the first line.
  // Re-fetching is the only way to recover any of that, because the raw text
  // was never kept. Only 'stored' and 'truncated' are reset: 'gone' is
  // permanent, 'skipped' is deliberate, and walking either back would undo a
  // decision rather than repair one.
  if (reprocess) {
    if (!apply) {
      console.log("\n  --reprocess needs --apply. Nothing reset.\n");
    } else {
      const r = await supabaseAdmin()
        .from("deal_messages")
        .update({ body_status: "not_fetched" })
        .eq("tenant_id", tenantId)
        .in("body_status", ["stored", "truncated"])
        .select("id");
      console.log(`\n  reset ${r.data?.length ?? 0} row(s) to not_fetched for reprocessing${r.error ? ` (ERROR ${r.error.message})` : ""}`);
    }
  }

  const r = await fillMissingBodies({
    tenantId,
    graphTenant: GRAPH_TENANT,
    limit,
    mailbox,
    since: days ? new Date(Date.now() - days * 86_400_000) : undefined,
    dryRun: !apply,
  });

  console.log(`\n  considered:   ${r.considered}`);
  if (apply) {
    console.log(`  stored:       ${r.stored}`);
    console.log(`  truncated:    ${r.truncated}   <- body kept, the 4000 cap cut it`);
    console.log(`  empty:        ${r.empty}       <- Graph returned the message, body genuinely empty`);
    console.log(`  gone:         ${r.gone}        <- 404/410, PERMANENT, never retried`);
    console.log(`  unavailable:  ${r.unavailable} <- transient, will be retried`);
    console.log(`  raw kept:     ${r.rawKept}     <- customer-side inbound, untrimmed`);
    console.log(`  raw too big:  ${r.rawTooLarge}  <- over the ceiling, recorded not dropped`);
    console.log(`  cut fell through: ${r.cutFellThrough}  <- quoted-tail cut removed everything, uncut text used`);
    console.log("\n  body_status after:");
    for (const [k, v] of Object.entries(await statuses(tenantId))) console.log(`    ${k.padEnd(34)} ${v}`);
    console.log("\n  Re-run until 'not_fetched' reaches 0. 'gone' will not shrink.\n");
  } else {
    console.log("\n  Dry run: nothing fetched, nothing written. Re-run with --apply.\n");
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
