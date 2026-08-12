/**
 * Why did this deal only write an activity, and did we miss anything?
 *
 * On 2026-08-11 TW Customs and Speed International wrote nothing to Rolldog but
 * a next-step activity, while GHY and Custom Goods wrote situation and
 * competition from the same day's calls. That is either correct (an intro or
 * kickoff call genuinely contains no qualification to record) or a silent
 * failure somewhere between the transcript and the write. Those look identical
 * from the Activity view, and guessing between them is how you end up trusting
 * a CRM that is quietly missing half its data.
 *
 * So this walks the chain in order and says where it stopped:
 *
 *   transcript      did we capture a conversation at all
 *   extraction      did the extractor run over it
 *   answers         what did it confirm, and what did it explicitly reject
 *   destinations    of the confirmed answers, which have a Rolldog target and
 *                   which are briefing-only by design
 *   composition     what syncDealToRolldog would send RIGHT NOW, dry run
 *   audit           what crm_access_log says actually went
 *
 * The composition step is the one that settles it, because it runs the real
 * writer rather than restating its rules. If the dry run composes a situation
 * payload and the audit log has no situation write, something broke. If the dry
 * run composes nothing, there was nothing to send and the deal is fine.
 *
 *   npx tsx scripts/why-no-writeback.ts --deal Twcustomsbrokers
 *   npx tsx scripts/why-no-writeback.ts --deal Speedintlog
 *
 * READ ONLY. The sync is a dry run and sends nothing.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { syncDealToRolldog } from "../lib/crm-writer";
import { getFrameworkForDeal } from "../lib/framework";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const only = arg("--deal")?.toLowerCase();
  if (!only) {
    console.log("\nPass --deal <name>.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);
  const deal = ((dealsRes.data ?? []) as Array<Record<string, unknown>>).find((d) =>
    String(d.account ?? "").toLowerCase().includes(only),
  );
  if (!deal) {
    console.log(`\nNo deal matching "${only}".\n`);
    process.exit(1);
  }
  const dealId = String(deal.id);
  const account = String(deal.account);

  console.log(`\n${account}\n${"=".repeat(70)}`);

  // 1. Transcript
  const callsRes = await db
    .from("calls")
    .select("id, title, scheduled_start, outcome, has_been_extracted, meeting_type, call_subtype")
    .eq("deal_id", dealId)
    .order("scheduled_start", { ascending: false });
  const calls = (callsRes.data ?? []) as Array<Record<string, unknown>>;
  const trs = await db
    .from("transcripts")
    .select("call_id, body")
    .in("call_id", calls.map((c) => String(c.id)));
  const trByCall = new Map(
    ((trs.data ?? []) as Array<{ call_id: string; body: string | null }>).map((t) => [
      t.call_id,
      (t.body ?? "").length,
    ]),
  );

  console.log(`\nCALLS`);
  for (const c of calls.slice(0, 6)) {
    const len = trByCall.get(String(c.id));
    console.log(
      `  ${String(c.scheduled_start ?? "").slice(0, 16).padEnd(18)} ${String(c.title ?? "").slice(0, 34).padEnd(36)}` +
        ` outcome=${String(c.outcome ?? "none").padEnd(12)} type=${String(c.meeting_type ?? "-")}/${String(c.call_subtype ?? "-")}`,
    );
    console.log(
      `      transcript ${len === undefined ? "MISSING" : `${len} chars`}   extracted=${c.has_been_extracted ? "yes" : "NO"}`,
    );
  }
  if (calls.length === 0) console.log("  none");

  // 2 & 3. Extractions
  const fxRes = await db
    .from("field_extractions")
    .select("framework_field_key, status, answer, evidence")
    .eq("deal_id", dealId);
  if (fxRes.error) throw new Error(fxRes.error.message);
  const fx = (fxRes.data ?? []) as Array<{ framework_field_key: string; status: string; answer: string | null }>;
  const byStatus = new Map<string, number>();
  for (const f of fx) byStatus.set(f.status, (byStatus.get(f.status) ?? 0) + 1);

  // A deal whose only meetings are still ahead of it has nothing to extract, and
  // saying "the extractor produced nothing" about it invents a problem. Three
  // deals read that way on 2026-08-11 when their first calls were days away.
  const anyCaptured = calls.some(
    (c) => trByCall.has(String(c.id)) || c.has_been_extracted || c.outcome === "captured",
  );

  console.log(`\nEXTRACTED FIELDS  (${fx.length} rows)`);
  if (fx.length === 0 && !anyCaptured) {
    console.log(`  None, and none expected: no call on this deal has been captured yet.`);
    console.log(`  Nothing here is wrong. Come back after the first call.`);
  } else if (fx.length === 0) {
    console.log(`  NONE, despite a captured call. The extractor produced nothing, which is a`);
    console.log(`  different problem from "the call had no qualification in it".`);
    console.log(`  Check meeting_type: extraction is gated on new_opportunity (transcript-sync`);
    console.log(`  step 5), so an internal or post-signing call is skipped on purpose.`);
  } else {
    for (const [s, n] of [...byStatus.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${s.padEnd(10)} ${n}`);
    }
  }

  // 4. Destinations
  const framework = await getFrameworkForDeal(dealId).catch(() => null);
  const targetByKey = new Map(
    (framework?.fields ?? []).map((f) => [f.fieldKey, f.writeTarget] as const),
  );
  const yes = fx.filter((f) => f.status === "Yes");
  const writable = yes.filter((f) => targetByKey.get(f.framework_field_key)?.system === "rolldog");
  const briefingOnly = yes.filter((f) => !targetByKey.get(f.framework_field_key));

  console.log(`\nCONFIRMED ANSWERS AND WHERE THEY GO  (${yes.length} confirmed)`);
  for (const f of yes) {
    const t = targetByKey.get(f.framework_field_key);
    const dest = !t ? "briefing only, by design" : t.system === "rolldog" ? `rolldog ${String(t.method ?? "?")}` : String(t.system);
    console.log(`  ${f.framework_field_key.padEnd(30)} -> ${dest}`);
  }
  if (yes.length === 0) console.log(`  none confirmed, so there is nothing any writer could send`);
  if (briefingOnly.length > 0) {
    console.log(`\n  ${briefingOnly.length} confirmed field(s) are briefing-only and never reach a CRM.`);
    console.log(`  That is intentional (see the header of lib/crm-writer.ts), not a gap.`);
  }

  // 5. Composition, via the real writer.
  const target = resolveWriteTarget(deal as never);
  console.log(`\nWHAT THE WRITER WOULD SEND NOW  (dry run)`);
  if (!target.authorized) {
    console.log(`  cannot write: ${target.reason}`);
  } else {
    // No nextAction. Passing a fake one made writeNextStep report a composable
    // activity on deals that have never had a call, which is the diagnostic
    // inventing the thing it was asked to look for.
    const results = await syncDealToRolldog({
      tenantSlug: "magaya",
      dealId,
      rolldogOpportunityId: target.opportunityId,
      dryRun: true,
    });
    for (const r of results) {
      const detail =
        r.status === "preview"
          ? `${r.fieldsWritten.join(", ") || "no fields"}  [${(r.payload ?? "").length} chars]`
          : r.fieldsWritten.join(", ") || "nothing contributed";
      console.log(`  ${r.method.padEnd(22)} ${r.status.padEnd(9)} ${detail}`);
    }
  }

  // 6. What actually went.
  if (target.authorized) {
    const logRes = await db
      .from("crm_access_log")
      .select("fields, created_at, field_values, violation_reason")
      .eq("tenant_id", tenantId)
      .eq("operation", "write")
      .eq("allowed", true)
      .eq("opportunity_external_id", target.opportunityId)
      .order("created_at", { ascending: false })
      .limit(12);
    // field_values arrives via a hand-applied migration, so the generated types
    // do not know it yet. Cast at the boundary rather than widening them.
    const rows = (logRes.data ?? []) as unknown as Array<Record<string, unknown>>;
    console.log(`\nWHAT ACTUALLY WENT TO OPPORTUNITY ${target.opportunityId}`);
    if (rows.length === 0) console.log(`  no writes recorded`);
    for (const r of rows) {
      const flds = Array.isArray(r.fields) ? (r.fields as string[]).join(", ") : "?";
      const vals = Array.isArray(r.field_values) ? `${(r.field_values as unknown[]).length} value(s) recorded` : "values not recorded";
      const bad = r.violation_reason ? `  DID NOT LAND: ${r.violation_reason}` : "";
      console.log(`  ${String(r.created_at).slice(0, 19)}  ${flds.padEnd(14)} ${vals}${bad}`);
    }
  }

  console.log(`\nREADING THIS`);
  console.log(`  dry run composes a payload + audit has no matching write  -> a real gap, investigate`);
  console.log(`  dry run says "skipped" everywhere                         -> nothing to send, deal is fine`);
  console.log(`  no confirmed answers at all                               -> the call had no qualification,`);
  console.log(`                                                               or the extractor missed it`);
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
