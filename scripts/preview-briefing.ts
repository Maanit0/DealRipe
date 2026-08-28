/**
 * Regenerate a deal's pre-call briefing (the same content the cron emails the
 * rep) so you can read it. Prints the text version and writes the HTML to
 * .previews/briefing-<deal>.html to open in a browser. Read-only.
 *
 *   npx tsx scripts/preview-briefing.ts --deal dutyfreeamericas
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import type { ExtractionMap } from "../lib/briefing-magaya";
import { briefingStateFromContext, getDealContext } from "../lib/deal-context";
import { attendeesFrom, generateBriefingFromState } from "../lib/generate-briefing";
import { loadFramework } from "../lib/framework";
import { renderPreCallBriefingEmail } from "../lib/emails/pre-call-briefing";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { getRolldogSummary, stageKeyFromSummary } from "../lib/rolldog-summary";
import { getDealForTenant } from "../lib/supabase-queries";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const ext = arg("--deal");
  if (!ext) {
    console.error("Usage: --deal <external_id>");
    process.exit(1);
  }
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealRow = await db
    .from("deals")
    .select("id, framework_id")
    .eq("tenant_id", tenantId)
    .eq("external_id", ext)
    .maybeSingle();
  if (dealRow.error || !dealRow.data) {
    console.error(`Deal '${ext}' not found.`);
    process.exit(1);
  }
  if (!dealRow.data.framework_id) {
    console.error("Deal has no framework.");
    process.exit(1);
  }

  const deal = await getDealForTenant(tenantId, dealRow.data.id);
  if (!deal) throw new Error("getDealForTenant returned null");
  const framework = await loadFramework(tenantId, dealRow.data.framework_id);
  if (!framework) throw new Error("loadFramework returned null");

  // THE SAME STATE briefing-sync BUILDS, not a second one assembled here.
  //
  // This script used to construct the state itself from deal.stageKey and
  // deal.repForecastCloseDate, which is a cached column. On 2026-08-23 that
  // made the preview show IFF's close date as August 17, already past, while
  // both Rolldog and Salesforce held September 21. The bug was real and in the
  // cache, but the preview could not have told anyone whether the fix landed,
  // because it never went through the code the fix was in.
  //
  // getDealContext does the live CRM reads, the stage-gate checklist, the BDR
  // record and the prior-call history, none of which this reconstruction had.
  // A preview that can disagree with production will.
  const ctx = await getDealContext(tenantId, dealRow.data.id);
  if (!ctx) throw new Error(`getDealContext returned null for ${ext}`);
  const stageKey = ctx.effectiveStageKey;

  const attendees = deal.contacts.length > 0 ? attendeesFrom(deal) : undefined;

  // The NEXT meeting on this deal, so the preview header matches what the cron
  // renders. Formatted with the production helper, never re-derived here.
  const { cleanMeetingTitle } = await import("../lib/salesforce-activity");
  const { formatMeetingWhen } = await import("../lib/followup-draft");
  const nextCall = await db
    .from("calls")
    .select("title, scheduled_start")
    .eq("deal_id", dealRow.data.id)
    .order("scheduled_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  const meetingTitle = nextCall.data?.title ? cleanMeetingTitle(String(nextCall.data.title)) : null;
  const meetingWhen = nextCall.data?.scheduled_start
    ? formatMeetingWhen(String(nextCall.data.scheduled_start))
    : null;
  const briefing = await generateBriefingFromState({
    ...briefingStateFromContext(ctx),
    attendees: attendees ?? `the ${deal.account} team`,
  });
  if (!briefing) throw new Error("briefing generation returned null");

  const email = renderPreCallBriefingEmail(briefing, {
    account: deal.account,
    stageKey,
    attendees,
    minutesUntil: 30,
    bdrFields: ctx.bdrFields,
    meetingTitle,
    meetingWhen,
  });

  console.log("\n============ SUBJECT ============");
  console.log(email.subject);
  console.log("\n============ BODY (text) ============\n");
  console.log(email.text);

  mkdirSync(".previews", { recursive: true });
  const out = `.previews/briefing-${ext}.html`;
  writeFileSync(out, email.html, "utf8");
  console.log(`\nHTML written to ${out} (open it in a browser to see the formatted version).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
