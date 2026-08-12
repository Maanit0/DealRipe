/**
 * Put back the history notes that were correct.
 *
 * scripts/remove-bad-activity.ts swept on the note's WORDING rather than on
 * whether its claim was false, and deleted nine notes on 2026-08-11 when only
 * four were wrong. The four named a call date in the future, on deals that had
 * never been captured. The other five named a real captured call and were
 * accurate: Bee Imagine, Custom Goods, All Square, Cummins and GUYWBD.
 *
 * This restores a note only where the claim can be verified from our own data:
 * the deal must have a captured call, and the date written is that call's, read
 * from the calls table rather than retyped from the deleted text.
 *
 *   npx tsx scripts/restore-backfill-notes.ts
 *   npx tsx scripts/restore-backfill-notes.ts --apply
 *
 * Idempotent by inspection: it reads the interactions tab first and skips an
 * opportunity that already carries a DealRipe history note.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runWithAuthorizedOpportunities } from "../lib/crm-scope";
import { createActivity, listActivities } from "../lib/rolldog";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

/** Deals whose note was accurate and was deleted in error. */
const RESTORE = new Set([
  "Beeimagine",
  "Custom-goods",
  "Allsquarelogistics",
  "Cummins",
  "GUYWBD",
]);

const MARKER = /this opportunity was created after DealRipe had already captured a call/i;

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);

  const callsRes = await db
    .from("calls")
    .select("deal_id, scheduled_start, call_date, outcome, has_been_extracted")
    .eq("tenant_id", tenantId)
    .lte("scheduled_start", new Date().toISOString());
  const captured = new Map<string, string>();
  for (const c of (callsRes.data ?? []) as Array<Record<string, unknown>>) {
    if (!c.deal_id) continue;
    if (!(c.has_been_extracted === true || c.outcome === "captured")) continue;
    const at = String(c.scheduled_start ?? c.call_date ?? "");
    if (!at) continue;
    const prev = captured.get(String(c.deal_id));
    // Newest captured call, which is what the original note named.
    if (!prev || Date.parse(at) > Date.parse(prev)) captured.set(String(c.deal_id), at);
  }

  console.log("");
  console.log(apply ? "APPLYING." : "Dry run. Nothing will be written.");

  let done = 0;
  for (const d of (dealsRes.data ?? []) as Array<Record<string, unknown>>) {
    const account = String(d.account ?? "");
    if (!RESTORE.has(account)) continue;
    const t = resolveWriteTarget(d as never);
    if (!t.authorized) {
      console.log(`\n${account}: not writable (${t.reason})`);
      continue;
    }
    const callAt = captured.get(String(d.id));
    if (!callAt) {
      console.log(`\n${account}: no captured call found, so the claim cannot be verified. Skipping.`);
      continue;
    }

    let already = false;
    try {
      const items = await runWithAuthorizedOpportunities(t.runtimeAuth, () => listActivities(t.opportunityId));
      already = items.some((a) => a.fromDealRipe && (MARKER.test(a.notes) || MARKER.test(a.title)));
    } catch (err) {
      console.log(`\n${account}: COULD NOT READ (${err instanceof Error ? err.message : String(err)}). Skipping.`);
      continue;
    }
    if (already) {
      console.log(`\n${account}: a history note is already present. Skipping.`);
      continue;
    }

    const notes =
      `[DealRipe] This opportunity was created after DealRipe had already captured a call on it ` +
      `(${fmt(callAt)}). The qualification fields on this record were filled from that call, in the ` +
      `customer's own words. Ongoing calls now write back automatically.`;

    console.log(`\n${account}   opportunity ${t.opportunityId}`);
    console.log(`  ${notes}`);
    if (!apply) continue;
    try {
      await runWithAuthorizedOpportunities(t.runtimeAuth, () =>
        createActivity(t.opportunityId, { title: "[DealRipe] Captured history", notes }),
      );
      done += 1;
      console.log(`  restored`);
    } catch (err) {
      console.log(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("");
  console.log(apply ? `${done} note(s) restored.` : "Re-run with --apply.");
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
