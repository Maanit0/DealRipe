/**
 * Backfills the already-captured pilot deals with the new stakeholder-attribution
 * phrasing. For each matched deal it re-extracts the latest call transcript with
 * the current extraction prompt (which now names who said what), refreshes the
 * stored extraction, and writes the composed fields to Rolldog.
 *
 * Two gates:
 *   - Default (no flag): re-extracts + refreshes the STORED extraction (deal page,
 *     digest, review all update), then PREVIEWS the exact Rolldog payloads without
 *     writing to Rolldog.
 *   - --commit: also writes the composed fields to Rolldog.
 *
 * Re-extraction only changes phrasing, not the Yes/No adjudication rules, so field
 * statuses should be stable. Runs on your Mac (Supabase + Rolldog + Anthropic).
 * Scoped to pilot opportunities by the writer's own guard.
 *
 *   npx tsx scripts/rolldog-reattribute-backfill.ts --account "Core Logistics"
 *   npx tsx scripts/rolldog-reattribute-backfill.ts --rep juan
 *   npx tsx scripts/rolldog-reattribute-backfill.ts --rep juan --commit
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { syncDealToRolldog } from "../lib/crm-writer";
import { repName } from "../lib/display-names";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { extractAndStore } from "../lib/transcript-ingest";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const account = arg("--account");
  const rep = (arg("--rep") ?? "").toLowerCase();
  const commit = has("--commit");
  if (!account && !rep) {
    console.log(`\nPass --account "<name>" or --rep <name>. Add --commit to write to Rolldog.\n`);
    return;
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const { data } = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rep_email")
    .eq("tenant_id", tenantId);
  let deals = (data ?? []) as Array<{
    id: string; account: string; external_id: string | null; rolldog_opportunity_id: string | null; rep_email: string | null;
  }>;
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (account) {
    const target = norm(account);
    deals = deals.filter((d) => norm(d.account).includes(target));
  }
  if (rep) {
    deals = deals.filter((d) => (d.rep_email ?? "").toLowerCase().includes(rep) || repName(d.rep_email).toLowerCase().includes(rep));
  }
  if (deals.length === 0) {
    console.log(`\nNo matching deals.\n`);
    return;
  }

  console.log(`\nMode: ${commit ? "COMMIT (writes to Rolldog)" : "preview (refreshes stored extraction, no Rolldog write)"}\n`);

  for (const d of deals) {
    const opp = (d.external_id ? rolldogOppIdForDeal(d.external_id) : null) ?? d.rolldog_opportunity_id;
    console.log(`=== ${d.account} ===`);
    if (!d.external_id) { console.log("  no deal external_id; skipping.\n"); continue; }
    if (!opp) { console.log("  not linked to a Rolldog opportunity; skipping.\n"); continue; }

    // Latest call + its transcript + external id.
    const call = await db
      .from("calls")
      .select("id, external_id, call_date")
      .eq("deal_id", d.id)
      .order("call_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!call.data?.external_id) { console.log("  no call with an external_id; skipping.\n"); continue; }
    const tr = await db.from("transcripts").select("body").eq("call_id", call.data.id).maybeSingle();
    if (!tr.data?.body) { console.log("  no transcript stored for the latest call; skipping.\n"); continue; }

    // Re-extract + persist the refreshed extraction (new attribution phrasing).
    try {
      await extractAndStore({ transcript: tr.data.body, dealExternalId: d.external_id, callExternalId: call.data.external_id });
      console.log("  re-extracted + refreshed stored extraction.");
    } catch (e) {
      console.log(`  extraction failed: ${e instanceof Error ? e.message : String(e)}\n`);
      continue;
    }

    // Compose the Rolldog writes; preview unless --commit.
    const results = await syncDealToRolldog({
      tenantSlug: "magaya",
      dealId: d.id,
      rolldogOpportunityId: String(opp),
      dryRun: !commit,
    });
    for (const r of results) {
      if (r.status === "skipped") continue;
      if (r.status === "preview") {
        console.log(`  [would write] ${r.method} (${r.fieldsWritten.join(", ")})`);
        if (r.payload) console.log(r.payload.split("\n").map((l) => `      ${l}`).join("\n"));
      } else {
        console.log(`  [${r.status}] ${r.method} (${r.fieldsWritten.join(", ")})${r.error ? `: ${r.error}` : ""}`);
      }
    }
    console.log("");
  }
  console.log(commit ? "Done. Rolldog updated.\n" : "Preview complete. Re-run with --commit to write to Rolldog.\n");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
