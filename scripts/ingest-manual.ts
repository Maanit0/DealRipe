/**
 * Manually run the FULL DealRipe digest on a transcript the bot failed to
 * capture (e.g. a Recall fatal-credit failure), recovering the call from a
 * transcript file. Does everything the live pipeline does after a call:
 *   1. persist the transcript on the call, recover it to outcome=captured
 *   2. extract qualification gates against the deal's framework
 *   3. extract + upsert contacts
 *   4. classify meeting type + sub-type
 *   5. record a deal snapshot
 *   6. render the post-call recap (archived; emailed with --send)
 *   7. write back to Rolldog (with --writeback)
 *
 * Safe by default: prints the target call and does nothing without --apply.
 *
 *   npx tsx scripts/ingest-manual.ts --deal iff --file .previews/iff-2026-07-22.txt
 *   npx tsx scripts/ingest-manual.ts --deal iff --file .previews/iff-2026-07-22.txt \
 *       --title "BI Demo - Customs - IFF & Magaya" --duration 45 --apply
 *   ... add --send to email the rep, --writeback to write Rolldog.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { readFileSync } from "node:fs";

import { extractContactsFromTranscript, upsertDealContacts } from "../lib/contacts-extract";
import type { ExtractionMap } from "../lib/briefing-magaya";
import { getFrameworkForDeal } from "../lib/framework";
import { classifyCallSubtype, classifyMeetingType, type MeetingType } from "../lib/meeting-classify";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { sendPostCallSummary } from "../lib/post-call-notify";
import { recordDealSnapshot } from "../lib/snapshot";
import { supabaseAdmin } from "../lib/supabase";
import { getDealForTenant, getDealExtraction } from "../lib/supabase-queries";
import { ingestTranscript, persistTranscriptBody } from "../lib/transcript-ingest";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { writeBackDealToRolldog } from "../lib/rolldog-writeback";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ext = arg("--deal");
  const file = arg("--file");
  const callOverride = arg("--call");
  const title = arg("--title");
  const durationStr = arg("--duration");
  const apply = process.argv.includes("--apply");
  const send = process.argv.includes("--send");
  const writeback = process.argv.includes("--writeback");
  if (!ext || !file) {
    console.error("Usage: --deal <external_id> --file <path> [--call <id>] [--title ..] [--duration N] [--apply] [--send] [--writeback]");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();
  const transcript = readFileSync(file, "utf8");

  const deal = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id")
    .eq("tenant_id", tenantId)
    .eq("external_id", ext)
    .maybeSingle();
  if (deal.error || !deal.data) {
    console.error(`Deal '${ext}' not found.`);
    process.exit(1);
  }

  // Target call: the override, else the most recent past call for the deal
  // (the one the bot failed on).
  const nowIso = new Date().toISOString();
  let callQuery = db
    .from("calls")
    .select("id, external_id, scheduled_start, call_date, outcome")
    .eq("tenant_id", tenantId)
    .eq("deal_id", deal.data.id);
  if (callOverride) callQuery = callQuery.eq("id", callOverride);
  else callQuery = callQuery.lte("scheduled_start", nowIso).order("scheduled_start", { ascending: false });
  const callRes = await callQuery.limit(1).maybeSingle();
  if (callRes.error || !callRes.data?.external_id) {
    console.error(`No target call found for '${ext}'.`);
    process.exit(1);
  }
  const call = callRes.data;
  const externalCallId = call.external_id;
  if (!externalCallId) {
    console.error("Target call has no external id.");
    process.exit(1);
  }

  console.log(`\nDeal:        ${deal.data.account} (${ext})`);
  console.log(`Target call: ${call.id}  ${call.scheduled_start}  (current outcome: ${call.outcome})`);
  console.log(`Transcript:  ${transcript.length} chars`);
  console.log(`Mode:        ${apply ? "APPLY" : "DRY (nothing written)"}${send ? " +send" : ""}${writeback ? " +writeback" : ""}`);
  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to recover this call and run the full digest.`);
    return;
  }

  // 1. Persist transcript + recover the call.
  await persistTranscriptBody({ tenantId, callId: call.id, body: transcript });
  const recover: {
    outcome: string;
    has_been_extracted: boolean;
    title?: string;
    duration_minutes?: number;
  } = { outcome: "captured", has_been_extracted: true };
  if (title) recover.title = title;
  if (durationStr && Number.isFinite(Number(durationStr))) recover.duration_minutes = Number(durationStr);
  await db.from("calls").update(recover).eq("id", call.id);
  console.log("\n[1/6] Transcript persisted, call recovered to captured.");

  // 2. Extract qualification gates.
  const ingest = await ingestTranscript({
    source: "manual_paste",
    externalCallId,
    transcript,
  });
  const rolled = await getDealExtraction(deal.data.id);
  const answered = Object.values(rolled as Record<string, { status?: string }>).filter(
    (v) => v && v.status === "Yes",
  ).length;
  console.log(`[2/6] Gates extracted. Confirmed fields: ${answered}.`);

  // 3. Contacts.
  const contacts = await extractContactsFromTranscript({ transcript, account: deal.data.account });
  const cres = await upsertDealContacts({
    tenantId,
    dealId: deal.data.id,
    contacts,
    callDate: call.scheduled_start ?? call.call_date ?? null,
  });
  console.log(`[3/6] Contacts: ${cres.inserted} added, ${cres.skipped} skipped.`);

  // 4. Classify meeting type + sub-type. Overridable, since a transcript-only
  //    classifier can misread a sales demo to an existing-tool customer as an
  //    existing-customer meeting; the deal's own stage is the tiebreaker.
  const mtOverride = arg("--meeting-type") as MeetingType | undefined;
  const stOverride = arg("--subtype");
  const trackedOpportunity =
    !!rolldogOppIdForDeal(ext) || !!deal.data.rolldog_opportunity_id;
  const meetingType = mtOverride ?? (await classifyMeetingType(transcript, { trackedOpportunity }));
  const subtype = stOverride ?? (await classifyCallSubtype({ transcript, meetingType }));
  await db.from("calls").update({ meeting_type: meetingType, call_subtype: subtype }).eq("id", call.id);
  console.log(`[4/6] Meeting: ${meetingType} / ${subtype}${mtOverride || stOverride ? " (override)" : ""}.`);

  // 5. Snapshot.
  try {
    const fullDeal = await getDealForTenant(tenantId, deal.data.id);
    const framework = await getFrameworkForDeal(deal.data.id);
    if (fullDeal && framework) {
      await recordDealSnapshot(tenantId, fullDeal, framework);
      console.log("[5/6] Snapshot recorded.");
    } else {
      console.log("[5/6] Snapshot skipped (no deal/framework).");
    }
  } catch (err) {
    console.log(`[5/6] Snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 6. Recap (+ optional Rolldog write-back).
  const notify = await sendPostCallSummary({
    tenantId,
    dealExternalId: ingest.dealExternalId,
    extraction: rolled as unknown as ExtractionMap,
    transcript,
    meetingType,
    dryRun: !send,
    callId: call.id,
    force: true, // manual recovery is deliberate; bypass the send-idempotency guard
  });
  console.log(`[6/6] Recap ${send ? (notify.sent ? `sent to ${notify.to}` : `not sent: ${notify.reason}`) : "archived (no email)"}.`);

  if (writeback) {
    const wb = await writeBackDealToRolldog("magaya", ingest.dealExternalId, {
      nextAction: notify.nextAction,
      callId: call.id,
      force: true, // manual recovery is deliberate; bypass the write idempotency guard
    });
    console.log(`Rolldog write-back: ${wb.written ? `wrote to opp ${wb.opportunityId}` : `skipped (${wb.reason})`}`);
  } else {
    console.log("Rolldog write-back: skipped (pass --writeback to enable).");
  }

  console.log("\nDone. Reload the IFF deal and the Meetings tab.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
