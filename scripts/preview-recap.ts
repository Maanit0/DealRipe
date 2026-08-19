/**
 * Regenerate a recap from a stored transcript and print it. Writes nothing.
 *
 * This exists so recap quality can be iterated on against real calls without
 * emailing a rep or touching a customer's CRM. It calls buildRecap, the same
 * function sendPostCallSummary calls, so what you read here is what the rep
 * would get. It does not reimplement the assembly, because a preview that can
 * disagree with production will, and it will do so convincingly.
 *
 * Safety is structural, not a flag. buildRecap performs no writes at all: task
 * persistence, the email send, the sent_messages archive and both CRM writes
 * live on the delivery side and are not reachable from here.
 *
 *   npx tsx scripts/preview-recap.ts --deal dunavant
 *   npx tsx scripts/preview-recap.ts --call a98cfc28-c12a-429d-a9ba-535f59d9252c
 *   npx tsx scripts/preview-recap.ts --deal dunavant --json
 *
 * With no --call, the most recent captured call on the deal is used.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { loadFramework } from "../lib/framework";
import { formatMeetingTime } from "../lib/graph-time";
import { buildRecap } from "../lib/recap-build";
import {
  renderDemoStrategyProse,
  renderNarrativeProse,
  renderPassGap,
  renderRecapEmailBody,
  renderRecapNote,
} from "../lib/recap-render";
import { postRecapNote } from "../lib/salesforce-note";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import type { ExtractionMap } from "../lib/briefing-magaya";
import type { MeetingType } from "../lib/meeting-classify";

const SLUG = "magaya";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? null) : null;
}

function rule(title: string): string {
  return `\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`;
}

async function main(): Promise<void> {
  const dealArg = arg("deal");
  const callArg = arg("call");
  const asJson = process.argv.includes("--json");
  // The two real artifacts. --note is what goes in the Salesforce Note and what
  // Eduardo shares with the solution engineer; --email is what the rep opens on
  // a phone. Same generation, different readers.
  const asNote = process.argv.includes("--note");
  const asEmail = process.argv.includes("--email");
  // --post-note is dry run unless --apply is also given, like every other
  // writing script here.
  const postNote = process.argv.includes("--post-note");
  const applyNote = process.argv.includes("--apply");
  if (!dealArg && !callArg) {
    console.error("Pass --deal <name or external id fragment> or --call <call id>.");
    process.exit(1);
  }

  const tenantId = await resolveTenantId(SLUG);
  const db = supabaseAdmin();

  // Resolve the call first, since --call is the more specific selector.
  let callRow: {
    id: string;
    deal_id: string;
    title: string | null;
    scheduled_start: string | null;
    meeting_type: string | null;
    outcome: string | null;
  } | null = null;

  if (callArg) {
    const r = await db
      .from("calls")
      .select("id, deal_id, title, scheduled_start, meeting_type, outcome")
      .eq("tenant_id", tenantId)
      .eq("id", callArg)
      .maybeSingle();
    if (r.error) {
      console.error(`call lookup failed: ${r.error.message}`);
      process.exit(1);
    }
    if (!r.data) {
      console.error(`No call ${callArg} in the ${SLUG} tenant.`);
      process.exit(1);
    }
    callRow = r.data;
  } else {
    const deals = await db
      .from("deals")
      .select("id, account, external_id")
      .eq("tenant_id", tenantId);
    if (deals.error) {
      console.error(`deal lookup failed: ${deals.error.message}`);
      process.exit(1);
    }
    const needle = (dealArg ?? "").toLowerCase();
    const matches = (deals.data ?? []).filter((d) =>
      `${d.account} ${d.external_id ?? ""}`.toLowerCase().includes(needle),
    );
    if (matches.length === 0) {
      console.error(`No deal matching "${dealArg}".`);
      process.exit(1);
    }
    if (matches.length > 1) {
      // Never guess which customer. Same rule the Salesforce resolver follows.
      console.error(`"${dealArg}" matches ${matches.length} deals. Narrow it:`);
      for (const m of matches) console.error(`  ${m.account}  [${m.external_id ?? "no external id"}]`);
      process.exit(1);
    }
    const calls = await db
      .from("calls")
      .select("id, deal_id, title, scheduled_start, meeting_type, outcome")
      .eq("tenant_id", tenantId)
      .eq("deal_id", matches[0].id)
      .eq("has_been_extracted", true)
      .order("scheduled_start", { ascending: false });
    if (calls.error) {
      console.error(`call lookup failed: ${calls.error.message}`);
      process.exit(1);
    }
    const usable = calls.data ?? [];
    if (usable.length === 0) {
      console.error(`${matches[0].account} has no extracted call to preview.`);
      process.exit(1);
    }
    callRow = usable[0];
    if (usable.length > 1) {
      console.log(
        `${matches[0].account} has ${usable.length} extracted calls. Using the most recent. ` +
          `Pass --call to pick another:`,
      );
      for (const c of usable) {
        console.log(`  ${c.id}  ${formatMeetingTime(c.scheduled_start ?? undefined)}  ${c.title ?? ""}`);
      }
    }
  }

  const deal = await db
    .from("deals")
    .select("id, account, external_id, stage_key, framework_id, rep_forecast_close_date, salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", tenantId)
    .eq("id", callRow.deal_id)
    .maybeSingle();
  if (deal.error || !deal.data) {
    console.error(`deal for call ${callRow.id} could not be loaded: ${deal.error?.message ?? "not found"}`);
    process.exit(1);
  }
  if (!deal.data.framework_id) {
    console.error(`${deal.data.account} has no framework, so no qualification recap can be built.`);
    process.exit(1);
  }

  const transcript = await db
    .from("transcripts")
    .select("body")
    .eq("call_id", callRow.id)
    .maybeSingle();
  if (transcript.error) {
    console.error(`transcript read failed: ${transcript.error.message}`);
    process.exit(1);
  }
  const body = transcript.data?.body ?? "";
  if (body.trim().length < 50) {
    // Distinguishable on purpose: no stored transcript is a different problem
    // from a transcript that exists and is too short to work with.
    console.error(
      transcript.data
        ? `The stored transcript for call ${callRow.id} is only ${body.trim().length} characters, too short to recap.`
        : `No transcript is stored for call ${callRow.id}. Nothing to regenerate from.`,
    );
    process.exit(1);
  }

  const framework = await loadFramework(tenantId, deal.data.framework_id);
  if (!framework) {
    console.error("framework load returned null");
    process.exit(1);
  }

  // THIS CALL's extraction, not the deal roll-up.
  //
  // In production sendPostCallSummary receives args.extraction from the ingest
  // of this one transcript, and separately reads the deal-wide roll-up for
  // "still open". Reading the roll-up for both made the preview attribute
  // another call's answers to this one: previewing Dunavant's Aug 12 call
  // showed a $34,400 monthly figure and a booked Thursday demo, neither of
  // which is anywhere in the Aug 12 transcript. Both came from the Aug 14 call.
  //
  // field_extractions is one row per (deal, field), so "what this call
  // established" is the rows whose current value was last written by it.
  const fx = await db
    .from("field_extractions")
    .select("framework_field_key, status, answer, evidence, confidence")
    .eq("deal_id", deal.data.id)
    .eq("last_updated_from_call_id", callRow.id);
  if (fx.error) {
    console.error(`extraction read failed: ${fx.error.message}`);
    process.exit(1);
  }
  const extraction = Object.fromEntries(
    (fx.data ?? []).map((x) => [String((x as { framework_field_key: string }).framework_field_key), x]),
  ) as unknown as ExtractionMap;

  console.log(rule(`PREVIEW  ${deal.data.account}`));
  console.log(`call         ${callRow.id}`);
  console.log(`subject      ${callRow.title ?? "(none)"}`);
  console.log(`when         ${formatMeetingTime(callRow.scheduled_start ?? undefined)}`);
  console.log(`stored type  ${callRow.meeting_type ?? "(none recorded)"}`);
  console.log(`transcript   ${body.length} characters`);
  console.log(`\nGenerating. This makes live Anthropic calls and writes nothing.`);

  const built = await buildRecap({
    tenantId,
    dealId: deal.data.id,
    account: deal.data.account,
    framework,
    fallbackStageKey: deal.data.stage_key,
    closeDate: deal.data.rep_forecast_close_date,
    extraction,
    transcript: body,
    callId: callRow.id,
    callAt: callRow.scheduled_start,
    // Reuse the stored classification when there is one, exactly as
    // transcript-sync does, so the preview routes the way production routed.
    meetingType: (callRow.meeting_type as MeetingType | null) ?? undefined,
  });

  if (asJson) {
    console.log(JSON.stringify(built, null, 2));
    return;
  }

  if ((asNote || asEmail || postNote) && built.kind === "qualification") {
    const noteBody = renderRecapNote({
      account: built.account,
      callTitle: callRow.title,
      callAt: formatMeetingTime(callRow.scheduled_start ?? undefined),
      stageKey: built.stageKey,
      narrative: built.narrative,
      demoStrategy: built.demoStrategy,
      captured: built.summary.captured,
      stillOpen: built.summary.stillOpen,
      history: built.history,
    });

    if (postNote) {
      const acct = deal.data.salesforce_account_id;
      const conf = deal.data.salesforce_link_confidence;
      if (!acct || conf !== "confirmed") {
        // Same fail-closed rule as every other Salesforce write: a link below
        // confirmed may be an entirely different company's record.
        console.error(
          `refusing to post: deal ${built.account} has salesforce_account_id=${acct ?? "null"} ` +
            `confidence=${conf ?? "null"}, and a note only writes on a confirmed link`,
        );
        process.exit(1);
      }
      const res = await postRecapNote({
        tenantSlug: "magaya",
        accountId: acct,
        account: built.account,
        callAt: callRow.scheduled_start,
        body: noteBody,
        apply: applyNote,
      });
      console.log(
        res.posted
          ? `posted ContentNote ${res.contentNoteId} linked to ${res.linkedTo}`
          : `not posted: ${res.reason}${res.alreadyThere ? ` (existing ${res.alreadyThere})` : ""}`,
      );
      if (!applyNote) console.log("Dry run. Nothing was written. Add --apply to post.");
      return;
    }

    if (asNote) {
      console.log(noteBody);
    }
    if (asEmail) {
      if (asNote) console.log(`\n${"=".repeat(78)}\nEMAIL BODY\n${"=".repeat(78)}`);
      console.log(renderRecapEmailBody({ narrative: built.narrative, demoStrategy: built.demoStrategy }));
    }
    return;
  }

  console.log(rule(`ROUTE`));
  console.log(`kind         ${built.kind}`);
  console.log(`meetingType  ${built.meetingType}`);
  console.log(`why          ${built.reason}`);

  if (built.kind === "general") {
    console.log(rule(`NARRATIVE  (no audit: ${built.meetingType})`));
    if (built.narrative.status === "present") {
      console.log(renderNarrativeProse(built.narrative.value));
      return;
    }
    console.log((renderPassGap("", built.narrative) ?? "").trim());
    if (!built.recap) return;
    console.log(rule(`FALLBACK GENERAL RECAP`));
    console.log(built.recap.summary);
    console.log(`\nTakeaways`);
    for (const t of built.recap.takeaways) console.log(`  - ${t}`);
    console.log(`\nNext steps`);
    for (const n of built.recap.nextSteps) console.log(`  - ${n}`);
    return;
  }

  const s = built.summary;

  // Pass 1, first, because it is the readout. The audit follows it, unchanged
  // and unmoved, exactly as docs/recap-target-eduardo.md asks.
  console.log(rule(`PASS 1  NARRATIVE`));
  if (built.narrative.status !== "present") {
    console.log((renderPassGap("", built.narrative) ?? "").trim());
  } else {
    // The prose renderer, not a bespoke one. The Salesforce Note, the email and
    // this preview must show the same words, or iterating here improves
    // something the rep never sees.
    console.log(renderNarrativeProse(built.narrative.value));
  }

  const g = built.narrativeGrounding;
  if (g.droppedFacts + g.droppedNumbers > 0) {
    console.log(`\n  GROUNDING removed ${g.droppedNumbers} number(s) and ${g.droppedFacts} claim(s):`);
    for (const e of g.examples) console.log(`    - ${e}`);
  }

  console.log(rule(`PASS 2  GAP AUDIT  (unchanged, stage ${built.stageKey})`));
  console.log(s.recap);

  console.log(rule(`CAPTURED ON THIS CALL  (${s.captured.length})`));
  if (s.captured.length === 0) console.log("  none");
  for (const c of s.captured) console.log(`  ${c.label}: ${c.answer}`);

  console.log(rule(`STILL OPEN  (${s.stillOpen.length})`));
  if (s.stillOpen.length === 0) console.log("  none");
  for (const o of s.stillOpen) console.log(`  [${o.stageKey ?? "?"}] ${o.label}. ${o.question}`);

  console.log(rule(`NEXT STEP`));
  console.log(`suggested    ${s.suggestedNextStep}`);
  console.log(`commitment   ${s.nextStepCommitment ?? "(none)"}`);
  console.log(`meeting expected      ${s.followUpMeetingExpected}`);
  console.log(`should book a meeting ${s.shouldBookNextMeeting}`);
  console.log(`customer timezone     ${s.customerTimezone ?? "(not stated on the call)"}`);
  if (s.nda) {
    console.log(
      `nda          demoIsNext=${s.nda.demoIsNext} ndaInPlace=${s.nda.ndaInPlace} customerResisted=${s.nda.customerResisted}`,
    );
  }
  if (s.coaching) console.log(`coaching     ${s.coaching}`);

  console.log(rule(`PRIOR CALLS AND CRM STATE`));
  console.log(built.history ? built.history : "  No prior calls on this deal. This is a first conversation.");
  console.log("");
  console.log(
    built.crmContext
      ? `Salesforce BDR context (${built.crmContextStatus}):\n${built.crmContext}`
      : `Salesforce BDR context: none carried (${built.crmContextStatus})`,
  );

  console.log(rule(`PASS 3  DEMO STRATEGY`));
  if (built.demoStrategy.status !== "present") {
    console.log((renderPassGap("", built.demoStrategy) ?? "").trim());
  } else {
    console.log(renderDemoStrategyProse(built.demoStrategy.value));
  }

  console.log(rule(`TASKS  (${built.tasks.length}, generated, not saved)`));
  if (built.tasks.length === 0) console.log("  none");
  for (const t of built.tasks) console.log(`  ${JSON.stringify(t)}`);

  console.log(`\n${"=".repeat(78)}`);
  console.log("Nothing was written. No email, no tasks, no CRM.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
