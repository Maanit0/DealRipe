/**
 * Push accumulated qualification into opportunities we have only just linked.
 *
 * A deal linked to Rolldog after its calls happened has months of confirmed
 * answers sitting in field_extractions and nothing in the opportunity. Two
 * different paths lead there:
 *
 *   applyConfirmedLinks replays captured calls when IT does the linking, but
 *   findLinkMatches skips any deal that already carries an opportunity id
 *   (rolldog-reconcile.ts:141), so a deal linked by anything else is invisible
 *   to it forever.
 *
 *   On 2026-08-11 six deals were linked by the resolver writing the column
 *   directly, before that was changed to go through applyConfirmedLinks. Those
 *   six are exactly the case this exists for.
 *
 * It finds deals that are writable and have never had a Rolldog write recorded
 * in crm_access_log, and runs the writer. No re-extraction: the answers already
 * exist, so this is a write, not an LLM pass.
 *
 * The next-step activity is deliberately not sent. It is a create rather than an
 * update, so a backfill would leave a duplicate to-do in the interactions tab.
 *
 *   npx tsx scripts/backfill-linked-deals.ts
 *   npx tsx scripts/backfill-linked-deals.ts --apply
 *
 * Idempotent: a deal with any prior Rolldog write is skipped, so running it
 * twice writes nothing the second time.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runWithAuthorizedOpportunities } from "../lib/crm-scope";
import { syncDealToRolldog } from "../lib/crm-writer";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  // --all re-sends every writable deal, not just the ones never written to.
  //
  // Writes before 2026-08-11 15:00 predate value recording, so their audit rows
  // carry field names only and the Activity view falls back to re-composing the
  // content at page load. Re-sending is idempotent for the note fields, which
  // are PATCHed rather than appended, and it produces a row that DOES carry its
  // values. The old rows stay as they are: what was written months ago cannot be
  // reconstructed, only what is there now.
  const all = process.argv.includes("--all");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);

  // Opportunities we have written to before. Anything absent here has never
  // received a thing from DealRipe.
  const logRes = await db
    .from("crm_access_log")
    .select("opportunity_external_id")
    .eq("tenant_id", tenantId)
    .eq("operation", "write")
    .eq("allowed", true);
  if (logRes.error) throw new Error(logRes.error.message);
  const written = new Set(
    (logRes.data ?? []).map((r) => String((r as { opportunity_external_id: string }).opportunity_external_id)),
  );

  const fxRes = await db
    .from("field_extractions")
    .select("deal_id")
    .eq("tenant_id", tenantId)
    .eq("status", "Yes");
  const yesCount = new Map<string, number>();
  for (const f of (fxRes.data ?? []) as Array<{ deal_id: string }>) {
    yesCount.set(f.deal_id, (yesCount.get(f.deal_id) ?? 0) + 1);
  }

  const todo: Array<{ id: string; account: string; opp: string; auth: readonly string[]; answers: number }> = [];
  for (const d of (dealsRes.data ?? []) as Array<Record<string, unknown>>) {
    const t = resolveWriteTarget(d as never);
    if (!t.authorized) continue;
    if (!all && written.has(String(t.opportunityId))) continue;
    const answers = yesCount.get(String(d.id)) ?? 0;
    if (answers === 0) continue; // nothing confirmed, nothing to send

    // Confirmed answers are not the same as sendable content. Some framework
    // fields are briefing-only and reach no CRM by design, so a deal can have
    // answers and compose nothing. United CHB has two, both briefing-only, and
    // without this check it reported as unwritten on every single run forever.
    const preview = await syncDealToRolldog({
      tenantSlug: "magaya",
      dealId: String(d.id),
      rolldogOpportunityId: t.opportunityId,
      dryRun: true,
    });
    if (!preview.some((r) => r.status === "preview")) continue;

    todo.push({
      id: String(d.id),
      account: String(d.account ?? "?"),
      opp: t.opportunityId,
      auth: t.runtimeAuth,
      answers,
    });
  }

  console.log("");
  if (todo.length === 0) {
    console.log("Nothing to send. Every writable deal with sendable content has been written to.\n");
    return;
  }
  console.log(
    all
      ? `${todo.length} writable deal(s) will be re-sent so their audit rows carry values. ${apply ? "APPLYING." : "Dry run."}`
      : `${todo.length} linked deal(s) have qualification and no Rolldog write on record. ${apply ? "APPLYING." : "Dry run."}`,
  );
  console.log("");

  for (const d of todo) {
    console.log(`${d.account}  ·  opportunity ${d.opp}  ·  ${d.answers} confirmed answer(s)`);
    if (!apply) continue;
    try {
      const results = await runWithAuthorizedOpportunities(d.auth, () =>
        syncDealToRolldog({ tenantSlug: "magaya", dealId: d.id, rolldogOpportunityId: d.opp }),
      );
      for (const r of results) {
        if (r.status === "ok") console.log(`    sent    ${r.method}  (${r.fieldsWritten.join(", ")})`);
        else if (r.status === "error") console.log(`    FAILED  ${r.method}: ${r.error}`);
      }
    } catch (err) {
      console.log(`    FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("");
  if (!apply) console.log("Re-run with --apply to send them.\n");
  else console.log("Check Activity: these writes record their values, so the full text is visible.\n");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
