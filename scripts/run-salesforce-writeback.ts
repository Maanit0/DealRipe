/**
 * Write a deal's qualification into its Salesforce account, now.
 *
 * Write-back fires from transcript-sync straight after a call. A deal linked
 * AFTER its call therefore has extracted qualification and an empty CRM record,
 * with nothing scheduled to reconcile the two. Black Gold Logistics on
 * 2026-08-12 is the case: the call ran at 11:30, the Salesforce account was
 * confirmed by the rep at 13:30, and nothing between those two moments would
 * ever have pushed the answers across.
 *
 *   npx tsx scripts/run-salesforce-writeback.ts --deal Blackgoldlogistics
 *   npx tsx scripts/run-salesforce-writeback.ts --deal Blackgoldlogistics --apply
 *   npx tsx scripts/run-salesforce-writeback.ts --all
 *
 * Dry run by default, and --apply still has to satisfy
 * resolveSalesforceWriteTarget and assertScopedAccountWrite, which are
 * fail-closed. Rolldog precedence is respected: a deal whose Rolldog
 * opportunity can take the write is skipped, because Rolldog is the system of
 * record wherever an opportunity exists.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { writeBackDealToSalesforce } from "../lib/salesforce-writeback-run";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const only = arg("--deal")?.toLowerCase() ?? null;
  const all = process.argv.includes("--all");
  const apply = process.argv.includes("--apply");
  if (!only && !all) {
    console.log("\nPass --deal <name> or --all.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, salesforce_account_id")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);
  let deals = ((dealsRes.data ?? []) as Array<Record<string, unknown>>).filter((d) => d.salesforce_account_id);
  if (only) deals = deals.filter((d) => String(d.account ?? "").toLowerCase().includes(only));

  if (deals.length === 0) {
    console.log(only ? `\nNo Salesforce-linked deal matching "${only}".\n` : "\nNo Salesforce-linked deals.\n");
    return;
  }

  // The most recent captured call, so the write is attributed to it rather than
  // appearing to come from nowhere.
  const callsRes = await db
    .from("calls")
    .select("id, deal_id, scheduled_start, outcome, has_been_extracted")
    .eq("tenant_id", tenantId)
    .order("scheduled_start", { ascending: false });
  const lastCall = new Map<string, { id: string; at: string | null }>();
  for (const c of (callsRes.data ?? []) as Array<Record<string, unknown>>) {
    if (!c.deal_id || lastCall.has(String(c.deal_id))) continue;
    if (!(c.has_been_extracted === true || c.outcome === "captured")) continue;
    lastCall.set(String(c.deal_id), { id: String(c.id), at: (c.scheduled_start as string | null) ?? null });
  }

  console.log("");
  console.log(apply ? "APPLYING." : "Dry run. Nothing will be written.");

  for (const d of deals) {
    const account = String(d.account ?? "?");
    const call = lastCall.get(String(d.id)) ?? null;
    const res = await writeBackDealToSalesforce("magaya", String(d.external_id ?? ""), {
      callId: call?.id ?? null,
      callDate: call?.at ?? null,
      apply,
    });

    // Report the plan and the outcome separately. Collapsing them printed
    // "nothing to write: dry run", which conflates "we did not send because you
    // did not ask us to" with "there was nothing to send", and those are the two
    // things you actually want to tell apart.
    const writes = res.plan?.writes ?? [];
    const skips = res.plan?.skips ?? [];
    console.log(`\n${account}   account ${res.accountId ?? "(unresolved)"}`);
    console.log(`  plan: ${writes.length} field(s) to write, ${skips.length} skipped`);
    for (const w of writes) console.log(`    WRITE  ${w.label}: ${String(w.display).slice(0, 90)}`);
    for (const s of skips) console.log(`    skip   ${s.label}: ${s.reason}`);
    if (res.written) console.log(`  SENT`);
    else console.log(`  not sent: ${res.reason ?? "no reason given"}`);
    // Only explain an empty plan when a plan was actually attempted. When the
    // deal never got that far, printing the extraction explanation sends you
    // looking at the framework for a problem that lives in write precedence.
    if (writes.length === 0 && res.plan) {
      console.log(`  An empty plan means no confirmed extraction maps to one of the eight`);
      console.log(`  Account fields in FIELD_SOURCES. Check with why-no-writeback.ts: the`);
      console.log(`  call may have confirmed plenty that only Rolldog has a home for.`);
    }
  }

  console.log("");
  if (!apply) console.log("Re-run with --apply to send.\n");
  else console.log("Values are recorded, so Activity shows the exact fields and text.\n");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
