/**
 * What did DealRipe put in the interactions tab?
 *
 * On 2026-08-10 at 21:23 three opportunities received a next-step activity each:
 * Integrity Customs Service (88494), Elif Utsukarci (82986) and Joe Arevalo
 * (80082). None of those deals has ever had a captured call. Something composed
 * a next step from no conversation, and because value recording did not exist
 * until the following afternoon, the audit row says only "activities".
 *
 * getDealRoom does not fetch this sub-resource, so those opportunities read back
 * as empty and there was no way to see what was written into a customer's CRM.
 *
 *   npx tsx scripts/rolldog-activities.ts --deal Integritycustoms
 *   npx tsx scripts/rolldog-activities.ts --opp 88494
 *   npx tsx scripts/rolldog-activities.ts --today      # every opp written to today
 *
 * READ ONLY. This deliberately does not delete anything: see the note at the
 * bottom of the output for why removal is a separate decision.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runWithAuthorizedOpportunities } from "../lib/crm-scope";
import { listActivities } from "../lib/rolldog";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dealArg = arg("--deal")?.toLowerCase() ?? null;
  const oppArg = arg("--opp") ?? null;
  const today = process.argv.includes("--today");
  if (!dealArg && !oppArg && !today) {
    console.log("\nPass --deal <name>, --opp <id>, or --today.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);
  let deals = (dealsRes.data ?? []) as Array<Record<string, unknown>>;

  if (dealArg) {
    deals = deals.filter((d) => String(d.account ?? "").toLowerCase().includes(dealArg));
  } else if (oppArg) {
    deals = deals.filter((d) => {
      const t = resolveWriteTarget(d as never);
      return t.authorized && String(t.opportunityId) === String(oppArg);
    });
  } else {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const logRes = await db
      .from("crm_access_log")
      .select("opportunity_external_id, fields")
      .eq("tenant_id", tenantId)
      .eq("operation", "write")
      .eq("allowed", true)
      .gte("created_at", since.toISOString());
    const opps = new Set(
      (logRes.data ?? []).map((r) => String((r as { opportunity_external_id: string }).opportunity_external_id)),
    );
    deals = deals.filter((d) => {
      const t = resolveWriteTarget(d as never);
      return t.authorized && opps.has(String(t.opportunityId));
    });
  }

  if (deals.length === 0) {
    console.log("\nNo matching deal that DealRipe can read.\n");
    return;
  }

  let ours = 0;
  for (const d of deals) {
    const t = resolveWriteTarget(d as never);
    if (!t.authorized) {
      console.log(`\n${d.account}: not readable (${t.reason})`);
      continue;
    }
    console.log(`\n${"=".repeat(76)}`);
    console.log(`${d.account}   opportunity ${t.opportunityId}`);
    console.log(`${"=".repeat(76)}`);

    let items;
    try {
      items = await runWithAuthorizedOpportunities(t.runtimeAuth, () => listActivities(t.opportunityId));
    } catch (err) {
      console.log(`  COULD NOT READ: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  This says nothing about what is there. We failed to ask.`);
      continue;
    }
    if (items.length === 0) {
      console.log(`  No activities on this opportunity.`);
      continue;
    }
    for (const a of items) {
      const mark = a.fromDealRipe ? "DEALRIPE" : "rep     ";
      if (a.fromDealRipe) ours += 1;
      console.log(`\n  [${mark}] id ${a.id}${a.createdAt ? `  ${a.createdAt.slice(0, 19)}` : ""}${a.isComplete === null ? "" : a.isComplete ? "  complete" : "  open"}`);
      console.log(`    ${a.title}`);
      if (a.notes) console.log(`    notes: ${a.notes}`);
    }
  }

  console.log(`\n${"=".repeat(76)}`);
  console.log(`${ours} activity(ies) carry the DealRipe marker.`);
  console.log("");
  console.log("Nothing is deleted here, deliberately. Before removing anything from a");
  console.log("customer's CRM, two things are worth settling: whether the content is");
  console.log("actually wrong or merely unexplained, and whether Rolldog supports deleting");
  console.log("an activity at all or only marking it complete. Ask Jeff rather than");
  console.log("discovering it against live data.");
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
