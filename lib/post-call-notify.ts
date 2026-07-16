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
import { repEmailForDeal, rolldogOppIdForDeal } from "./pilot-config";
import { generatePostCallSummary } from "./post-call-summary";
import { getRolldogSummary, stageKeyFromSummary } from "./rolldog-summary";
import { recordSentMessage } from "./sent-messages";
import { getDealExtraction } from "./supabase-queries";
import { supabaseAdmin } from "./supabase";

export type NotifyResult = { sent: boolean; to?: string; reason?: string };

export async function sendPostCallSummary(args: {
  tenantId: string;
  dealExternalId: string;
  extraction: ExtractionMap;
  transcript: string;
  /** When true, render and archive the recap into sent_messages so the deal
   *  page can display the new-framework format, but do NOT actually send an
   *  email. Used to refresh the recap after a framework repoint without
   *  re-notifying the rep. */
  dryRun?: boolean;
}): Promise<NotifyResult> {
  const db = supabaseAdmin();
  const dealRow = await db
    .from("deals")
    .select("id, account, stage_key, framework_id, rep_forecast_close_date, rep_email")
    .eq("tenant_id", args.tenantId)
    .eq("external_id", args.dealExternalId)
    .maybeSingle();
  if (dealRow.error) {
    return { sent: false, reason: `deal lookup failed: ${dealRow.error.message}` };
  }
  if (!dealRow.data) {
    return { sent: false, reason: `deal '${args.dealExternalId}' not found` };
  }

  // Route to the mapped pilot rep, or fall back to the deal's rep_email (set
  // on auto-created deals). No recipient means nothing to send.
  const to = repEmailForDeal(args.dealExternalId) ?? dealRow.data.rep_email ?? undefined;
  if (!to) {
    return { sent: false, reason: `no rep email for deal '${args.dealExternalId}'` };
  }

  if (!dealRow.data.framework_id) {
    return { sent: false, to, reason: `deal '${args.dealExternalId}' has no framework` };
  }

  const framework = await loadFramework(args.tenantId, dealRow.data.framework_id);
  if (!framework) {
    return { sent: false, to, reason: "framework load returned null" };
  }

  // "Still open" reflects the deal's cumulative call-verified state (the
  // field_extractions roll-up, which already includes this call by the time
  // this runs), not just what this one call covered, and never a stale CRM
  // entry. Rolldog is read (light) only for the current stage. Best-effort.
  let gapExtraction = args.extraction;
  try {
    gapExtraction = (await getDealExtraction(dealRow.data.id)) as unknown as ExtractionMap;
  } catch (err) {
    console.warn(
      `[post-call] extraction roll-up read failed for deal ${args.dealExternalId}: ${
        err instanceof Error ? err.message : String(err)
      }; using this call's extraction`,
    );
  }
  let stageKey = dealRow.data.stage_key;
  const opp = rolldogOppIdForDeal(args.dealExternalId);
  if (opp) {
    try {
      stageKey = stageKeyFromSummary(await getRolldogSummary(opp)) ?? dealRow.data.stage_key;
    } catch (err) {
      console.warn(
        `[post-call] rolldog stage read failed for opp ${opp}: ${
          err instanceof Error ? err.message : String(err)
        }; using deal stage`,
      );
    }
  }

  const summary = await generatePostCallSummary({
    account: dealRow.data.account,
    stageKey,
    closeDate: dealRow.data.rep_forecast_close_date ?? undefined,
    framework,
    extraction: args.extraction,
    gapExtraction,
    transcript: args.transcript,
  });

  const email = renderPostCallSummaryEmail(summary);

  if (args.dryRun) {
    // Archive the freshly-rendered recap without sending. The deal page reads
    // from sent_messages, so this refreshes the visible recap to the current
    // framework's format while leaving the rep's inbox untouched.
    await recordSentMessage({
      tenantId: args.tenantId,
      dealId: dealRow.data.id,
      kind: "recap",
      toEmail: to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      providerId: null,
    });
    return { sent: false, to, reason: "dry-run: recap archived, email skipped" };
  }

  try {
    const res = await sendEmail({
      to,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    // Archive the exact recap that was sent (best-effort, never blocks).
    await recordSentMessage({
      tenantId: args.tenantId,
      dealId: dealRow.data.id,
      kind: "recap",
      toEmail: to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      providerId: res.id || null,
    });
    return { sent: true, to, reason: `resend id ${res.id}` };
  } catch (err) {
    if (err instanceof MailerConfigError) {
      return { sent: false, to, reason: `mailer not configured: ${err.message}` };
    }
    return { sent: false, to, reason: err instanceof Error ? err.message : String(err) };
  }
}
