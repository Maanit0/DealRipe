/**
 * Post-call summary delivery.
 *
 * Given a freshly-extracted call (deal + extraction + transcript), generate
 * the rep-facing recap and email it to the deal's rep. Best-effort by design:
 * every failure path returns a NotifyResult with a reason instead of throwing,
 * so the caller (transcript-sync) can log and move on without ever affecting
 * the ingest pipeline.
 *
 * The rep-to-deal mapping lives in pilot-config (PILOT_REP_EMAILS).
 */

import type { ExtractionMap } from "./briefing-magaya";
import { renderPostCallSummaryEmail } from "./emails/post-call-summary";
import { loadFramework } from "./framework";
import { MailerConfigError, sendEmail } from "./mailer";
import { repEmailForDeal } from "./pilot-config";
import { generatePostCallSummary } from "./post-call-summary";
import { supabaseAdmin } from "./supabase";

export type NotifyResult = { sent: boolean; to?: string; reason?: string };

export async function sendPostCallSummary(args: {
  tenantId: string;
  dealExternalId: string;
  extraction: ExtractionMap;
  transcript: string;
}): Promise<NotifyResult> {
  const to = repEmailForDeal(args.dealExternalId);
  if (!to) {
    return { sent: false, reason: `no rep email mapped for deal '${args.dealExternalId}'` };
  }

  const db = supabaseAdmin();
  const dealRow = await db
    .from("deals")
    .select("account, stage_key, framework_id, rep_forecast_close_date")
    .eq("tenant_id", args.tenantId)
    .eq("external_id", args.dealExternalId)
    .maybeSingle();
  if (dealRow.error) {
    return { sent: false, to, reason: `deal lookup failed: ${dealRow.error.message}` };
  }
  if (!dealRow.data) {
    return { sent: false, to, reason: `deal '${args.dealExternalId}' not found` };
  }
  if (!dealRow.data.framework_id) {
    return { sent: false, to, reason: `deal '${args.dealExternalId}' has no framework` };
  }

  const framework = await loadFramework(args.tenantId, dealRow.data.framework_id);
  if (!framework) {
    return { sent: false, to, reason: "framework load returned null" };
  }

  const summary = await generatePostCallSummary({
    account: dealRow.data.account,
    stageKey: dealRow.data.stage_key,
    closeDate: dealRow.data.rep_forecast_close_date ?? undefined,
    framework,
    extraction: args.extraction,
    transcript: args.transcript,
  });

  const email = renderPostCallSummaryEmail(summary);

  try {
    const res = await sendEmail({
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    return { sent: true, to, reason: `resend id ${res.id}` };
  } catch (err) {
    if (err instanceof MailerConfigError) {
      return { sent: false, to, reason: `mailer not configured: ${err.message}` };
    }
    return { sent: false, to, reason: err instanceof Error ? err.message : String(err) };
  }
}
