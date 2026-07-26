/**
 * Ingests a transcript file for a deal's call through the full closed loop:
 * persists the transcript, runs extraction (field_extractions), and writes the
 * captured qualification back to Rolldog. Use it when a call's transcript never
 * ingested (e.g. Recall failed) and you obtained the transcript separately.
 *
 * Resolves the target call by --call <externalId>, or the deal's most recent
 * call if omitted. Runs on your Mac (Supabase + Anthropic + Rolldog).
 *
 *   # preview which deal/call it will target (no writes):
 *   npx tsx scripts/ingest-transcript.ts --account "IFF" --file iff-transcript.txt
 *   # run it:
 *   npx tsx scripts/ingest-transcript.ts --account "IFF" --file iff-transcript.txt --commit
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";

import { writeBackDealToRolldog } from "../lib/rolldog-writeback";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { ingestTranscript } from "../lib/transcript-ingest";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function main(): Promise<void> {
  const account = arg("--account");
  const file = arg("--file");
  const callExt = arg("--call");
  const commit = process.argv.includes("--commit");
  if (!account || !file) { console.log(`\nPass --account "<name>" --file <transcript.txt> [--call <externalId>] [--commit].\n`); return; }

  const transcript = readFileSync(file, "utf8").trim();
  if (transcript.length < 200) { console.log(`\nTranscript file looks too short (${transcript.length} chars). Aborting.\n`); return; }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const { data } = await db.from("deals").select("id, account, external_id").eq("tenant_id", tenantId);
  const target = norm(account);
  const deal = ((data ?? []) as Array<{ id: string; account: string; external_id: string | null }>).find((d) => norm(d.account).includes(target));
  if (!deal) { console.log(`\nNo deal matches "${account}".\n`); return; }
  if (!deal.external_id) { console.log(`\nDeal "${deal.account}" has no external_id.\n`); return; }

  // Resolve the target call: explicit --call, else most recent call for the deal.
  let externalCallId = callExt;
  if (!externalCallId) {
    const c = await db.from("calls").select("id, external_id, call_date").eq("tenant_id", tenantId).eq("deal_id", deal.id).order("call_date", { ascending: false }).limit(1).maybeSingle();
    externalCallId = c.data?.external_id ?? undefined;
  }
  if (!externalCallId) { console.log(`\nCould not resolve a call external_id for "${deal.account}". Pass --call <externalId>.\n`); return; }

  console.log(`\nDeal: ${deal.account}  (external_id=${deal.external_id})`);
  console.log(`Call external_id: ${externalCallId}`);
  console.log(`Transcript: ${transcript.length} chars from ${file}`);

  if (!commit) {
    console.log(`\nPreview only. Add --commit to ingest + extract + write back to Rolldog.\n`);
    return;
  }

  console.log(`\nIngesting (persist transcript + extract)...`);
  const res = await ingestTranscript({ source: "manual_paste", externalCallId, transcript });
  const yes = Object.values(res.extraction ?? {}).filter((v) => (v as { status?: string })?.status === "Yes").length;
  console.log(`  extraction complete. Yes fields: ${yes}`);

  console.log(`Writing back to Rolldog...`);
  const wb = await writeBackDealToRolldog("magaya", deal.external_id, { force: true });
  if (wb.written) {
    const fields = wb.results?.filter((r) => r.status === "ok").flatMap((r) => r.fieldsWritten) ?? [];
    console.log(`  wrote to opp ${wb.opportunityId}: ${fields.join(", ") || "(no fields)"}`);
  } else {
    console.log(`  write-back skipped: ${wb.reason}`);
  }
  console.log(`\nDone. Reload the IFF deal page and its meeting to confirm the transcript and gates show.\n`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
