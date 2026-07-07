/**
 * Preview the pre-call briefing DealRipe would send, built from the deal's LIVE
 * Rolldog state and gaps (not the empty extraction). Reads the opportunity from
 * Rolldog, derives which fields are filled vs blank, generates the briefing,
 * renders the exact email, and writes an HTML preview. Sends nothing.
 *
 *   npx tsx scripts/preview-rolldog-briefing.ts                 # martinbrower
 *   npx tsx scripts/preview-rolldog-briefing.ts --deal omniva
 *   npx tsx scripts/preview-rolldog-briefing.ts --deal martinbrower --attendees "Cleet (Martin Brower)"
 *
 * Requires Rolldog read (the deal's opp id must be in PILOT_OPPORTUNITY_IDS),
 * ANTHROPIC_API_KEY, and Supabase. No writes, no email sent.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ExtractionMap } from "../lib/briefing-magaya";
import { renderPreCallBriefingEmail } from "../lib/emails/pre-call-briefing";
import { loadFramework } from "../lib/framework";
import { generateBriefingFromState } from "../lib/generate-briefing";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { getDealRoom } from "../lib/rolldog";
import {
  buildExtractionFromRolldog,
  mergeRolldogAndCalls,
  stageFromRolldog,
} from "../lib/rolldog-briefing-context";
import { getDealForTenant } from "../lib/supabase-queries";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SLUG = "magaya";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dealIdx = argv.indexOf("--deal");
  const attIdx = argv.indexOf("--attendees");
  const outIdx = argv.indexOf("--out");
  const slug = dealIdx !== -1 ? argv[dealIdx + 1] : "martinbrower";
  const attendeesArg = attIdx !== -1 ? argv[attIdx + 1] : null;

  const tenantId = await resolveTenantId(SLUG);
  const db = supabaseAdmin();
  const dealRow = await db
    .from("deals")
    .select("id, account, framework_id, stage_key, rep_forecast_close_date")
    .eq("tenant_id", tenantId)
    .eq("external_id", slug)
    .maybeSingle();
  if (dealRow.error || !dealRow.data) {
    console.error(`Deal '${slug}' not found.`);
    process.exit(1);
  }
  if (!dealRow.data.framework_id) {
    console.error(`Deal '${slug}' has no framework.`);
    process.exit(1);
  }
  const opp = rolldogOppIdForDeal(slug);
  if (!opp) {
    console.error(`No Rolldog opportunity id mapped for '${slug}'.`);
    process.exit(1);
  }

  const framework = await loadFramework(tenantId, dealRow.data.framework_id);
  if (!framework) {
    console.error("loadFramework returned null.");
    process.exit(1);
  }

  const account = dealRow.data.account;
  console.log("");
  console.log(`Deal:        ${account} (${slug})`);
  console.log(`Rolldog opp: ${opp}`);
  console.log(`Reading live Rolldog context...`);

  const room = await getDealRoom(opp);
  // Faithfully mirror briefing-sync: Rolldog baseline merged with any
  // captured-call extractions (calls win). For a deal with no calls yet, this
  // is just the Rolldog context.
  const deal = await getDealForTenant(tenantId, dealRow.data.id);
  const callExtraction = (deal?.extraction ?? {}) as unknown as ExtractionMap;
  const extraction = mergeRolldogAndCalls(
    buildExtractionFromRolldog(framework, room),
    callExtraction,
  );
  const stage = stageFromRolldog(room) ?? dealRow.data.stage_key;
  const closeRaw = (room.core as Record<string, unknown>)["close-date"];
  const closeDate =
    typeof closeRaw === "string" ? closeRaw : dealRow.data.rep_forecast_close_date ?? undefined;
  const attendees = attendeesArg ?? `the ${account} team`;

  const filled = framework.fields.filter((f) => extraction[f.fieldKey]?.status === "Yes");
  const gaps = framework.fields.filter((f) => extraction[f.fieldKey]?.status !== "Yes");

  console.log("");
  console.log(`Rolldog stage:    ${stage}`);
  console.log(`Rolldog close:    ${closeDate ?? "(none)"}`);
  console.log(`Fields Rolldog already has: ${filled.length} of ${framework.fields.length}`);
  for (const f of filled) console.log(`   filled: ${f.label}`);
  console.log(`Blindspots / gaps: ${gaps.length}`);
  console.log("");
  console.log("Generating briefing from that state...");

  const briefing = await generateBriefingFromState({
    account,
    stageKey: stage,
    closeDate,
    attendees,
    framework,
    extraction,
  });
  if (!briefing) {
    console.error("Briefing generation returned null.");
    process.exit(1);
  }

  const email = renderPreCallBriefingEmail(briefing, {
    account,
    stageKey: stage,
    attendees,
  });

  const out =
    outIdx !== -1 ? argv[outIdx + 1] : path.join(process.cwd(), ".previews", `rolldog-briefing-${slug}.html`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, email.html, "utf8");

  console.log("");
  console.log("================= BRIEFING (what would be sent) =================");
  console.log(`Subject: ${email.subject}`);
  console.log("");
  console.log(email.text);
  console.log("================================================================");
  console.log("");
  console.log(`HTML preview written to: ${out}`);
  console.log("Nothing was sent. This is a dry preview built from live Rolldog context.");
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
