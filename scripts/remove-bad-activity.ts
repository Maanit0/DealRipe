/**
 * Delete a DealRipe activity that should never have been written.
 *
 * Three opportunities received this on 2026-08-10 at 21:23, on deals that had
 * never had a captured call:
 *
 *   "This opportunity was created after DealRipe had already captured a call on
 *    it (Aug 14). The qualification fields on this record were filled from that
 *    call, in the customer's own words."
 *
 * Both claims are false. Aug 14 had not happened, and no field had been filled.
 * The cause was rolldog-reconcile treating a scheduled meeting as captured
 * history, fixed the same day. This removes what it left behind.
 *
 *   npx tsx scripts/remove-bad-activity.ts --opp 88494
 *   npx tsx scripts/remove-bad-activity.ts --opp 88494 --apply
 *   npx tsx scripts/remove-bad-activity.ts --all-dealripe-notes          # the three
 *   npx tsx scripts/remove-bad-activity.ts --all-dealripe-notes --apply
 *
 * SAFETY
 *
 * It will only ever delete an activity that carries the [DealRipe] marker, and
 * with --all-dealripe-notes only ones whose text matches the specific false
 * claim above. A rep's own note can never be selected by this script. Every
 * candidate is printed in full before anything is sent, and nothing happens
 * without --apply.
 *
 * Deletion is not recoverable. Read the dry run.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runWithAuthorizedOpportunities } from "../lib/crm-scope";
import { deleteActivity, listActivities, type RolldogActivity } from "../lib/rolldog";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

/** The specific wrong note. Narrow on purpose: a broad "any DealRipe activity"
 *  sweep would also delete legitimate next-step to-dos reps are working from. */
const BAD_NOTE = /this opportunity was created after DealRipe had already captured a call/i;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const oppArg = arg("--opp") ?? null;
  const sweep = process.argv.includes("--all-dealripe-notes");
  if (!oppArg && !sweep) {
    console.log("\nPass --opp <id> or --all-dealripe-notes.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);

  const targets = ((dealsRes.data ?? []) as Array<Record<string, unknown>>)
    .map((d) => ({ account: String(d.account ?? "?"), t: resolveWriteTarget(d as never) }))
    .filter((x) => x.t.authorized)
    .filter((x) => !oppArg || String((x.t as { opportunityId: string }).opportunityId) === oppArg);

  if (targets.length === 0) {
    console.log("\nNo writable opportunity matches.\n");
    return;
  }

  console.log("");
  console.log(apply ? "APPLYING. Deletion cannot be undone." : "Dry run. Nothing will be deleted.");

  let found = 0;
  let removed = 0;

  for (const { account, t } of targets) {
    if (!t.authorized) continue;
    let items: RolldogActivity[];
    try {
      items = await runWithAuthorizedOpportunities(t.runtimeAuth, () => listActivities(t.opportunityId));
    } catch (err) {
      console.log(`\n${account}: COULD NOT READ (${err instanceof Error ? err.message : String(err)})`);
      console.log(`  Skipping. Nothing is deleted on an opportunity we could not inspect.`);
      continue;
    }

    const bad = items.filter(
      (a) => a.fromDealRipe && (sweep ? BAD_NOTE.test(a.notes) || BAD_NOTE.test(a.title) : true),
    );
    if (bad.length === 0) continue;

    console.log(`\n${account}   opportunity ${t.opportunityId}`);
    for (const a of bad) {
      found += 1;
      console.log(`  id ${a.id}${a.createdAt ? `  ${a.createdAt.slice(0, 19)}` : ""}`);
      if (a.title) console.log(`    ${a.title}`);
      if (a.notes) console.log(`    ${a.notes}`);
      if (!apply) continue;
      try {
        await runWithAuthorizedOpportunities(t.runtimeAuth, () => deleteActivity(t.opportunityId, a.id));
        removed += 1;
        console.log(`    deleted`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`    FAILED: ${msg}`);
        if (/405|not allowed|method/i.test(msg)) {
          console.log(`    Rolldog appears not to support deleting an activity. The note cannot`);
          console.log(`    simply be removed, so the honest alternative is to correct its text`);
          console.log(`    rather than leave a false claim marked complete.`);
        }
      }
    }
  }

  console.log("");
  if (found === 0) {
    console.log("Nothing matched. No DealRipe activity of that shape is present.");
  } else if (!apply) {
    console.log(`${found} activity(ies) would be deleted. Re-run with --apply.`);
  } else {
    console.log(`${removed} of ${found} deleted.`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
