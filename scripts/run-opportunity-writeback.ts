/**
 * Write the two Salesforce Opportunity fields DealRipe can answer.
 *
 *   Intro Call Outcome        from the deal's FIRST captured call's outcome
 *   Agreement on Next Steps   from next_step_confirmed on that deal
 *
 * Runs against every Salesforce-linked deal, including ones with a Rolldog
 * opportunity. That is deliberate and it is a departure. Deal-level precedence
 * says Rolldog owns those deals, but these two fields exist only in Salesforce,
 * so skipping them there writes the fact nowhere at all. Precedence is a
 * per-field question, not a per-deal one.
 *
 * Dry run by default.
 *
 *   npx tsx scripts/run-opportunity-writeback.ts
 *   npx tsx scripts/run-opportunity-writeback.ts --deal Miraclegroups
 *   npx tsx scripts/run-opportunity-writeback.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { writeOpportunityFromCall } from "../lib/salesforce-opportunity";
import { resolveSalesforceWriteTarget } from "../lib/salesforce-scope";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const NO_CONTENT = new Set([
  "capture_failed", "placeholder", "duplicate", "discarded", "rescheduled",
]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const only = arg("--deal")?.toLowerCase() ?? null;
  const apply = process.argv.includes("--apply");

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", tenantId)
    .not("salesforce_account_id", "is", null);
  if (dealsRes.error) throw new Error(dealsRes.error.message);

  let deals = (dealsRes.data ?? []) as Array<{
    id: string; account: string;
    salesforce_account_id: string | null; salesforce_link_confidence: string | null;
  }>;
  if (only) deals = deals.filter((d) => d.account.toLowerCase().includes(only));

  console.log(`\n${apply ? "APPLYING." : "Dry run. Nothing will be written."}`);
  console.log(`${deals.length} Salesforce-linked deal(s).\n`);

  let wrote = 0;
  for (const d of deals) {
    const target = resolveSalesforceWriteTarget(d);
    if (!target.authorized) continue;

    // The FIRST call that produced a conversation, which is what "intro call"
    // means. Ordered oldest first for exactly that reason.
    const callsRes = await db
      .from("calls")
      .select("id, outcome, scheduled_start, call_date")
      .eq("deal_id", d.id)
      .order("scheduled_start", { ascending: true });
    // A meeting that has not happened yet is not the intro call. Aquagulf's
    // only surviving call is five days in the future, and without this it was
    // treated as the first one. A null outcome is the same story: the call has
    // not been processed, so nothing is known about it, which is not the same
    // as knowing nobody attended.
    const nowIso = new Date().toISOString();
    const calls = (callsRes.data ?? []).filter((c) => {
      if (NO_CONTENT.has(String(c.outcome ?? ""))) return false;
      if (!c.outcome) return false;
      const at = c.scheduled_start ?? c.call_date;
      return at !== null && at <= nowIso;
    });
    if (calls.length === 0) continue;
    const first = calls[0];

    const fx = await db
      .from("field_extractions")
      .select("status")
      .eq("deal_id", d.id)
      .eq("framework_field_key", "next_step_confirmed")
      .maybeSingle();

    const res = await writeOpportunityFromCall({
      tenantSlug: "magaya",
      accountId: target.accountId,
      callOutcome: first.outcome,
      isFirstCall: true,
      nextStepConfirmed: (fx.data as { status?: string } | null)?.status ?? null,
      apply,
    });

    const nothing = res.written.length === 0;
    if (nothing && res.skipped.every((s) => s.field === "*")) {
      // No opportunity, or unreadable. Worth one line, not four.
      console.log(`${d.account.padEnd(26)} ${res.skipped[0]?.reason ?? "nothing to do"}`);
      continue;
    }
    console.log(`${d.account}   opportunity ${res.opportunityId ?? "-"}`);
    for (const w of res.written) {
      wrote++;
      console.log(`   WROTE  ${w}`);
    }
    for (const s of res.skipped) console.log(`   skip   ${s.field}: ${s.reason}`);
  }

  console.log(`\n${wrote} field write(s)${apply ? "" : " would be made"}.`);
  console.log(apply ? "" : "Re-run with --apply.\n");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
