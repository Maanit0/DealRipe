/**
 * Every deal, both CRMs, and which links are wrong.
 *
 * "Which deals are linked" is the easy half and not the useful half. A deal
 * sitting in Salesforce only is correct if it is an unqualified discovery
 * prospect and broken if it has had a demo and a proposal, and both look
 * identical in a list of link ids. So this classifies by what the deal has
 * actually DONE and reports the mismatches:
 *
 *   ROLLDOG MISSING     the deal has advanced past discovery (a demo, proposal
 *                       or negotiation call, or confirmed SQL2+ qualification)
 *                       and there is no writable Rolldog opportunity. This is
 *                       the case that matters: qualification is being captured
 *                       and is landing in Salesforce Account fields, or nowhere,
 *                       when Rolldog is the system of record for a live deal.
 *   SALESFORCE MISSING  real captured calls and no Salesforce account, so the
 *                       pre-Rolldog history has nowhere to go.
 *   LINKED BUT CLOSED   an id is stored on the deal and the write still fails,
 *                       because link confidence is not confirmed/high. These
 *                       look connected everywhere in the product and are not.
 *   NEITHER, WITH CALLS customer conversations reaching no CRM at all.
 *   OK                  writable where it should be.
 *   DORMANT             no captured calls. Nothing to write yet, not a problem.
 *
 * Authorization comes from resolveWriteTarget and resolveSalesforceWriteTarget,
 * the same functions the writers call, so this cannot drift from what actually
 * happens at write time.
 *
 *   npx tsx scripts/link-audit.ts
 *   npx tsx scripts/link-audit.ts --all      # include the dormant deals
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getFrameworkForDeal } from "../lib/framework";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { resolveSalesforceWriteTarget } from "../lib/salesforce-scope";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

/** Call subtypes that mean the deal is past discovery. */
const ADVANCED_SUBTYPES = new Set(["demo", "proposal", "negotiation", "pricing", "contract"]);
/** Stage keys whose confirmed fields mean the same. */
const ADVANCED_STAGES = new Set(["SQL2", "SQL3", "SQL4", "SQL5"]);
const NO_CONTENT = new Set([
  "duplicate", "placeholder", "capture_failed", "discarded", "rescheduled", "no_show", "no_conversation",
]);

type Row = {
  account: string;
  rolldog: string;
  salesforce: string;
  calls: number;
  advanced: boolean;
  why: string;
};

async function main(): Promise<void> {
  const showAll = process.argv.includes("--all");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select(
      "id, account, external_id, rep_email, rolldog_opportunity_id, rolldog_link_confidence, salesforce_account_id, salesforce_link_confidence",
    )
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);
  const deals = (dealsRes.data ?? []) as Array<Record<string, unknown>>;

  const callsRes = await db
    .from("calls")
    .select("deal_id, outcome, call_subtype, has_been_extracted")
    .eq("tenant_id", tenantId);
  const callsByDeal = new Map<string, Array<Record<string, unknown>>>();
  for (const c of (callsRes.data ?? []) as Array<Record<string, unknown>>) {
    if (!c.deal_id) continue;
    const k = String(c.deal_id);
    callsByDeal.set(k, [...(callsByDeal.get(k) ?? []), c]);
  }

  const fxRes = await db
    .from("field_extractions")
    .select("deal_id, framework_field_key, status")
    .eq("tenant_id", tenantId)
    .eq("status", "Yes");
  const yesByDeal = new Map<string, string[]>();
  for (const f of (fxRes.data ?? []) as Array<{ deal_id: string; framework_field_key: string }>) {
    yesByDeal.set(f.deal_id, [...(yesByDeal.get(f.deal_id) ?? []), f.framework_field_key]);
  }

  // Stage per field key, from the framework, so "advanced" is defined by the
  // customer's own qualification framework rather than a list in this script.
  const anyDeal = deals[0];
  const framework = anyDeal ? await getFrameworkForDeal(String(anyDeal.id)).catch(() => null) : null;
  const stageByField = new Map((framework?.fields ?? []).map((f) => [f.fieldKey, f.stageKey ?? ""] as const));

  const buckets: Record<string, Row[]> = {
    rolldogMissing: [], salesforceMissing: [], linkedButClosed: [], neitherWithCalls: [], ok: [], dormant: [],
  };

  for (const d of deals) {
    const account = String(d.account ?? "?");
    const dealId = String(d.id);
    const rd = resolveWriteTarget(d as never);
    const sf = resolveSalesforceWriteTarget(d as never);

    const calls = (callsByDeal.get(dealId) ?? []).filter(
      (c) => !(c.outcome && NO_CONTENT.has(String(c.outcome))),
    );
    const captured = calls.filter((c) => c.has_been_extracted || c.outcome === "captured").length;

    const yes = yesByDeal.get(dealId) ?? [];
    const advancedByStage = yes.some((k) => ADVANCED_STAGES.has(stageByField.get(k) ?? ""));
    const advancedByCall = calls.some((c) => ADVANCED_SUBTYPES.has(String(c.call_subtype ?? "")));
    const advanced = advancedByStage || advancedByCall;

    const row: Row = {
      account,
      rolldog: rd.authorized ? `opp ${rd.opportunityId}` : (d.rolldog_opportunity_id ? `id ${d.rolldog_opportunity_id}, ${d.rolldog_link_confidence ?? "no"} confidence` : "none"),
      salesforce: sf.authorized ? `acct ${sf.accountId}` : (d.salesforce_account_id ? `id ${d.salesforce_account_id}, ${d.salesforce_link_confidence ?? "no"} confidence` : "none"),
      calls: captured,
      advanced,
      why: advancedByStage ? "confirmed SQL2+ qualification" : advancedByCall ? "a demo/proposal/negotiation call" : "",
    };

    // An id stored that still cannot be written to is the worst state: it looks
    // connected in every view and silently is not.
    const closedRd = !rd.authorized && !!d.rolldog_opportunity_id;
    const closedSf = !sf.authorized && !!d.salesforce_account_id;

    if (captured === 0) buckets.dormant.push(row);
    else if (closedRd || closedSf) buckets.linkedButClosed.push(row);
    else if (!rd.authorized && !sf.authorized) buckets.neitherWithCalls.push(row);
    else if (advanced && !rd.authorized) buckets.rolldogMissing.push(row);
    else if (!sf.authorized && !rd.authorized) buckets.salesforceMissing.push(row);
    else buckets.ok.push(row);
  }

  const show = (title: string, rows: Row[], note: string) => {
    if (rows.length === 0) return;
    console.log(`\n${title}  (${rows.length})`);
    console.log(`  ${note}`);
    console.log("");
    for (const r of rows.sort((a, b) => b.calls - a.calls)) {
      console.log(`  ${r.account.padEnd(24)} calls ${String(r.calls).padStart(2)}   rolldog: ${r.rolldog.padEnd(34)} salesforce: ${r.salesforce}`);
      if (r.why) console.log(`  ${" ".repeat(24)} advanced: ${r.why}`);
    }
  };

  console.log(`\n${deals.length} deal(s) in the pipeline.\n${"=".repeat(78)}`);

  show("ROLLDOG MISSING", buckets.rolldogMissing,
    "Past discovery, no writable Rolldog opportunity. Qualification is landing in Salesforce or nowhere.");
  show("LINKED BUT CLOSED", buckets.linkedButClosed,
    "An id is stored and the write still fails. Looks connected everywhere; is not.");
  show("NEITHER, WITH CALLS", buckets.neitherWithCalls,
    "Real customer conversations reaching no CRM at all.");
  show("SALESFORCE MISSING", buckets.salesforceMissing,
    "Captured calls, no Salesforce account, and not yet in Rolldog.");
  if (showAll) {
    show("OK", buckets.ok, "Writable where it should be.");
    show("DORMANT", buckets.dormant, "No captured calls yet. Nothing to write.");
  }

  console.log("");
  console.log(`${"=".repeat(78)}`);
  console.log(
    `  ok ${buckets.ok.length}   rolldog missing ${buckets.rolldogMissing.length}   linked-but-closed ${buckets.linkedButClosed.length}` +
      `   neither ${buckets.neitherWithCalls.length}   salesforce missing ${buckets.salesforceMissing.length}   dormant ${buckets.dormant.length}`,
  );
  console.log("");
  console.log("To fix: scripts/resolve-upcoming-links.ts searches both CRMs for anything with");
  console.log("an upcoming meeting. For deals with no meeting scheduled, rolldog-opp-detail.ts");
  console.log("--name then link-deal.ts --apply. Ambiguous ones belong to the rep, not to us.");
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
