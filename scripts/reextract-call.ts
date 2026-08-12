/**
 * Re-run extraction for one call, now, from its stored transcript.
 *
 * transcript-sync's retryFailedExtractions does this on a Vercel cron, which is
 * no use when you are sitting at a terminal wanting an answer. Same production
 * path: ingestTranscript over the stored body, so the merge, the recap and the
 * write-back all behave exactly as they would in the cron.
 *
 * Built for Speed International on 2026-08-11: a 54,860 character conversation
 * that produced a single extracted field and reached Rolldog opportunity 81537
 * with nothing but an activity.
 *
 *   npx tsx scripts/reextract-call.ts --deal Speedintlog
 *   npx tsx scripts/reextract-call.ts --deal Speedintlog --apply
 *
 * Prints the before and after row counts, so a re-run that changes nothing is
 * visible as such rather than looking like success.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { ingestTranscript } from "../lib/transcript-ingest";
import { formatMeetingTime } from "../lib/graph-time";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const only = arg("--deal")?.toLowerCase();
  const apply = process.argv.includes("--apply");
  if (!only) {
    console.log("\nPass --deal <name>.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const deals = await db.from("deals").select("id, account, external_id").eq("tenant_id", tenantId);
  const deal = ((deals.data ?? []) as Array<{ id: string; account: string; external_id: string | null }>).find(
    (d) => (d.account ?? "").toLowerCase().includes(only),
  );
  if (!deal) {
    console.log(`\nNo deal matching "${only}".\n`);
    process.exit(1);
  }

  const callsRes = await db
    .from("calls")
    .select("id, external_id, title, scheduled_start, outcome, has_been_extracted")
    .eq("deal_id", deal.id)
    .order("scheduled_start", { ascending: false });
  const calls = (callsRes.data ?? []).filter(
    (c) => c.outcome !== "duplicate" && (c.has_been_extracted === true || c.outcome === "captured"),
  );
  if (calls.length === 0) {
    console.log(`\n${deal.account}: no captured call.\n`);
    return;
  }

  const before = await db
    .from("field_extractions")
    .select("framework_field_key", { count: "exact", head: true })
    .eq("deal_id", deal.id);
  const beforeCount = before.count ?? 0;

  console.log(`\n${deal.account}   ${beforeCount} extraction row(s) before`);

  for (const c of calls) {
    const tr = await db.from("transcripts").select("body").eq("call_id", String(c.id)).maybeSingle();
    const body = tr.data?.body ?? "";
    console.log(`\n  ${formatMeetingTime(c.scheduled_start)}  ${String(c.title ?? "").slice(0, 44)}`);
    console.log(`    transcript ${body.length} chars, external_id ${c.external_id ?? "(none)"}`);
    if (body.trim().length < 50) {
      console.log(`    nothing to re-extract from`);
      continue;
    }
    if (!c.external_id) {
      console.log(`    no external_id, ingestTranscript resolves the deal from it. Skipping.`);
      continue;
    }
    if (!apply) continue;

    try {
      const res = await ingestTranscript({
        source: "recall_ai",
        externalCallId: String(c.external_id),
        transcript: body,
      });
      const fields = Object.keys((res.extraction ?? {}) as Record<string, unknown>).length;
      console.log(`    re-extracted: model returned ${fields} field(s)`);
    } catch (err) {
      console.log(`    FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply.\n`);
    return;
  }

  const after = await db
    .from("field_extractions")
    .select("framework_field_key", { count: "exact", head: true })
    .eq("deal_id", deal.id);
  const afterCount = after.count ?? 0;

  console.log(`\n${beforeCount} row(s) before, ${afterCount} after.`);
  if (afterCount <= beforeCount) {
    console.log("");
    console.log("No change. The model returned the same near-empty result, so this is not a");
    console.log("plumbing failure and re-running again will not help. Look at the raw");
    console.log("response with scripts/diagnose-extraction.ts --raw: either the prompt is");
    console.log("not eliciting per-field statuses on a transcript this long, or the call");
    console.log("genuinely contains no qualification and the row count is honest.");
  } else {
    console.log("");
    console.log("Recovered. Clear the flag so the retry loop stops carrying it:");
    console.log("  the next transcript-sync sets ingest_error to null on success.");
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
