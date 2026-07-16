/**
 * Re-run extraction for a deal from its STORED transcript against the deal's
 * current framework, and repopulate field_extractions. Use after a framework
 * change (e.g. the auto-deal Scotsman -> Magaya Rolldog fix) to recover the
 * structured qualification without needing the call again. The transcript body
 * is read from the transcripts table; nothing is re-pulled from Recall.
 *
 *   npx tsx scripts/reextract-deal.ts --deal auto:corelogistics.net
 *   npx tsx scripts/reextract-deal.ts --deal auto:corelogistics.net --recap           # also resend the recap
 *   npx tsx scripts/reextract-deal.ts --deal auto:corelogistics.net --preview-recap   # refresh the recap in the UI WITHOUT sending an email
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { extractAndStore } from "../lib/transcript-ingest";
import { sendPostCallSummary } from "../lib/post-call-notify";
import type { ExtractionMap } from "../lib/briefing-magaya";
import { getDealExtraction } from "../lib/supabase-queries";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ext = arg("--deal");
  const resend = process.argv.includes("--recap");
  const preview = process.argv.includes("--preview-recap");
  if (!ext) {
    console.error("Usage: --deal <external_id> [--recap | --preview-recap]");
    process.exit(1);
  }
  if (resend && preview) {
    console.error("Pass either --recap or --preview-recap, not both.");
    process.exit(1);
  }
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const deal = await db
    .from("deals")
    .select("id, account")
    .eq("tenant_id", tenantId)
    .eq("external_id", ext)
    .maybeSingle();
  if (deal.error || !deal.data) {
    console.error(`Deal '${ext}' not found.`);
    process.exit(1);
  }

  // Most recent call for this deal that has a stored transcript.
  const calls = await db
    .from("calls")
    .select("id, external_id, scheduled_start")
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.data.id)
    .order("scheduled_start", { ascending: false });
  if (calls.error) {
    console.error(calls.error.message);
    process.exit(1);
  }

  let picked: { callExternalId: string; body: string } | null = null;
  for (const c of calls.data ?? []) {
    const t = await db.from("transcripts").select("body").eq("call_id", c.id).maybeSingle();
    if (t.data?.body && c.external_id) {
      picked = { callExternalId: c.external_id, body: t.data.body };
      break;
    }
  }
  if (!picked) {
    console.error(`No stored transcript found for '${ext}'. Nothing to re-extract from.`);
    process.exit(1);
  }

  console.log(`Re-extracting ${deal.data.account} from stored transcript (${picked.body.length} chars)...`);
  await extractAndStore({
    transcript: picked.body,
    dealExternalId: ext,
    callExternalId: picked.callExternalId,
  });

  const rolled = await getDealExtraction(deal.data.id);
  const answered = Object.values(rolled as Record<string, { status?: string }>).filter(
    (v) => v && v.status === "Yes",
  ).length;
  console.log(`Done. Extraction repopulated against the deal's current framework. Confirmed fields: ${answered}.`);

  if (resend || preview) {
    const res = await sendPostCallSummary({
      tenantId,
      dealExternalId: ext,
      extraction: rolled as unknown as ExtractionMap,
      transcript: picked.body,
      dryRun: preview,
    });
    if (preview) {
      console.log(
        res.reason
          ? `Recap archived (no email sent) for ${res.to ?? "(no recipient)"}. Reload the deal page.`
          : "Recap archive attempt returned no reason string.",
      );
    } else {
      console.log(res.sent ? `Recap re-sent to ${res.to}.` : `Recap not sent: ${res.reason}`);
    }
  } else {
    console.log("Run again with --recap to resend, or --preview-recap to refresh the UI without emailing.");
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
