/**
 * Write the EXACT email a rep would receive to a local file. Sends nothing.
 *
 * scripts/preview-recap.ts shows the recap's content. This shows the artifact:
 * the same subject, the same html, the same plain-text arm that the mailer
 * would hand to Resend. Those are different things, and until this existed the
 * seam between the renderer and the mailer had never been exercised once.
 *
 * It calls renderRecapEmail, the same function sendPostCallSummary calls, so it
 * cannot pick a different renderer than production would. It stops one step
 * before the send.
 *
 * Output lands in .previews/, which is gitignored because these files contain
 * customer-derived content and Magaya is under NDA. Do not move it elsewhere
 * and do not commit it.
 *
 *   npx tsx scripts/preview-recap-email.ts --call <id>
 *   npx tsx scripts/preview-recap-email.ts --deal dunavant
 *   npx tsx scripts/preview-recap-email.ts --deal dunavant --text
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtractionMap } from "../lib/briefing-magaya";
import { loadFramework } from "../lib/framework";
import { formatMeetingTime } from "../lib/graph-time";
import type { MeetingType } from "../lib/meeting-classify";
import { renderRecapEmail } from "../lib/post-call-notify";
import { buildRecap } from "../lib/recap-build";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SLUG = "magaya";
const OUT_DIR = ".previews";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const callArg = arg("call");
  const dealArg = arg("deal");
  const showText = process.argv.includes("--text");
  if (!callArg && !dealArg) {
    console.error("Pass --call <id> or --deal <name fragment>.");
    process.exit(1);
  }

  const tenantId = await resolveTenantId(SLUG);
  const db = supabaseAdmin();

  let callId = callArg;
  if (!callId) {
    const deals = await db.from("deals").select("id, account, external_id").eq("tenant_id", tenantId);
    const needle = (dealArg ?? "").toLowerCase();
    const matches = (deals.data ?? []).filter((d) =>
      `${d.account} ${d.external_id ?? ""}`.toLowerCase().includes(needle),
    );
    if (matches.length !== 1) {
      console.error(
        matches.length === 0
          ? `No deal matching "${dealArg}".`
          : `"${dealArg}" matches ${matches.length} deals. Narrow it or pass --call.`,
      );
      process.exit(1);
    }
    const calls = await db
      .from("calls")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("deal_id", matches[0].id)
      .eq("has_been_extracted", true)
      .order("scheduled_start", { ascending: false })
      .limit(1);
    if ((calls.data ?? []).length === 0) {
      console.error(`${matches[0].account} has no extracted call.`);
      process.exit(1);
    }
    callId = calls.data![0].id;
  }

  const call = await db
    .from("calls")
    .select("id, deal_id, title, scheduled_start, meeting_type")
    .eq("tenant_id", tenantId)
    .eq("id", callId)
    .maybeSingle();
  if (call.error || !call.data) {
    console.error(`call ${callId} not found: ${call.error?.message ?? "no row"}`);
    process.exit(1);
  }

  const deal = await db
    .from("deals")
    .select("id, account, stage_key, framework_id, rep_forecast_close_date")
    .eq("id", call.data.deal_id)
    .maybeSingle();
  if (!deal.data?.framework_id) {
    console.error("deal has no framework");
    process.exit(1);
  }
  const framework = await loadFramework(tenantId, deal.data.framework_id);
  if (!framework) {
    console.error("framework load returned null");
    process.exit(1);
  }

  const tr = await db.from("transcripts").select("body").eq("call_id", call.data.id).maybeSingle();
  const transcript = tr.data?.body ?? "";
  if (transcript.trim().length < 50) {
    console.error(`no usable transcript stored for call ${call.data.id}`);
    process.exit(1);
  }

  const fx = await db
    .from("field_extractions")
    .select("framework_field_key, status, answer, evidence, confidence")
    .eq("deal_id", deal.data.id)
    .eq("last_updated_from_call_id", call.data.id);
  const extraction = Object.fromEntries(
    (fx.data ?? []).map((x) => [
      String((x as { framework_field_key: string }).framework_field_key),
      x,
    ]),
  ) as unknown as ExtractionMap;

  console.log(`\nBuilding the recap for ${deal.data.account}. Live Anthropic calls, no writes, no send.`);

  const built = await buildRecap({
    tenantId,
    dealId: deal.data.id,
    account: deal.data.account,
    framework,
    fallbackStageKey: deal.data.stage_key,
    closeDate: deal.data.rep_forecast_close_date,
    extraction,
    transcript,
    callId: call.data.id,
    callAt: call.data.scheduled_start,
    meetingType: (call.data.meeting_type as MeetingType | null) ?? undefined,
  });

  const email = renderRecapEmail(built);
  if (!email) {
    // The same answer production gives: nothing to send, and why.
    console.error(
      `\nNo email would be sent. Neither the readout nor the fallback recap produced anything for this ${built.meetingType} call.`,
    );
    process.exit(1);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const slug = deal.data.account.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const htmlPath = join(OUT_DIR, `recap-${slug}.html`);
  writeFileSync(htmlPath, email.html, "utf8");

  console.log(`\nroute      ${built.kind} (${built.meetingType})`);
  console.log(`subject    ${email.subject}`);
  console.log(`call       ${call.data.title ?? "(no subject)"}`);
  console.log(`when       ${formatMeetingTime(call.data.scheduled_start ?? undefined)}`);

  // The rule Mark cares about, checked on the real artifact rather than on the
  // prose that fed it. Reported, not fixed: fixing it belongs in the lint.
  const dashes = (email.html.match(/[—–]/g) ?? []).length;
  console.log(`dashes     ${dashes}${dashes > 0 ? "  <-- em/en dashes present, Mark reads these as machine-written" : ""}`);
  console.log(`html       ${email.html.length} chars -> ${htmlPath}`);

  if (showText) {
    console.log(`\n${"=".repeat(78)}\nPLAIN TEXT ARM\n${"=".repeat(78)}`);
    console.log(email.text);
  }

  console.log(`\nOpen it:  open ${htmlPath}`);
  console.log(`.previews/ is gitignored. This file contains customer content; do not commit or share it.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
