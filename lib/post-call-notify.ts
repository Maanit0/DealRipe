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
import { renderGeneralRecapEmail } from "./emails/general-recap";
import { renderPostCallSummaryEmail } from "./emails/post-call-summary";
import { loadFramework } from "./framework";
import { type MeetingType } from "./meeting-classify";
import { buildRecap } from "./recap-build";
import { MailerConfigError, sendEmail } from "./mailer";
import { getDealContext } from "./deal-context";
import { recipientsForCall } from "./call-recipients";
import { repEmailForDeal } from "./pilot-config";
import { generatePostCallSummary, type PostCallSummary } from "./post-call-summary";
import { recordSentMessage } from "./sent-messages";
import { getDealExtraction, getUpcomingCallForDeal } from "./supabase-queries";
import { supabaseAdmin } from "./supabase";
import { createTasksForCall, generateTasksFromCall, type GeneratedTask } from "./tasks";

export type NotifyResult = {
  sent: boolean;
  to?: string;
  reason?: string;
  /** The recap's recommended next action, for Rolldog next-step write-back.
   *  Set only for new-opportunity (qualification) recaps. */
  nextAction?: string;
  /** The generated summary, so callers can reuse it instead of paying for a
   *  second generation (the follow-up draft needs exactly this). */
  summary?: PostCallSummary;
};

export async function sendPostCallSummary(args: {
  tenantId: string;
  dealExternalId: string;
  extraction: ExtractionMap;
  transcript: string;
  /** Pre-computed meeting type (from transcript-sync, which persists it). When
   *  omitted, this classifies from the transcript. */
  meetingType?: MeetingType;
  /** When true, render and archive the recap into sent_messages so the deal
   *  page can display the new-framework format, but do NOT actually send an
   *  email. Used to refresh the recap after a framework repoint without
   *  re-notifying the rep. */
  dryRun?: boolean;
  /** The call this recap is for. Stored on the archived recap (hard link) and
   *  used to attach generated tasks to the call. */
  callId?: string;
  /** Bypass the idempotency guard and re-send even if a recap was already
   *  emailed for this call. Manual recovery scripts set this; the automatic
   *  pipeline never does, so a re-ingest can't double-send. */
  force?: boolean;
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
  // Everyone who was actually on the call, not just whoever owns the deal row.
  // A co-sold meeting has one bot and one deal, so the second rep used to sit
  // through the call and hear nothing afterwards.
  const owner = repEmailForDeal(args.dealExternalId) ?? dealRow.data.rep_email ?? null;
  const recipients = await recipientsForCall(args.tenantId, args.callId ?? null, owner);
  // `to` stays the single owner for reporting and idempotency, so callers and
  // logs read as before. `recipients.all` is who the mail actually goes to.
  const to = recipients.all[0];
  if (!to) {
    return { sent: false, reason: `no rep email for deal '${args.dealExternalId}'` };
  }

  // Idempotency: if a recap was already EMAILED for this call, don't send a
  // second one on a re-ingest. Dry-run refreshes (provider_id null) don't count
  // and don't trigger the guard, so archiving a refreshed recap still works.
  if (!args.dryRun && !args.force && args.callId) {
    const existing = await db
      .from("sent_messages")
      .select("id")
      .eq("tenant_id", args.tenantId)
      .eq("call_id", args.callId)
      .eq("kind", "recap")
      .not("provider_id", "is", null)
      .limit(1);
    if ((existing.data ?? []).length > 0) {
      return { sent: false, to, reason: "recap already sent for this call (idempotent skip)" };
    }
  }

  if (!dealRow.data.framework_id) {
    return { sent: false, to, reason: `deal '${args.dealExternalId}' has no framework` };
  }

  const framework = await loadFramework(args.tenantId, dealRow.data.framework_id);
  if (!framework) {
    return { sent: false, to, reason: "framework load returned null" };
  }

  // Classify the meeting. DealRipe auto-joins every invited meeting, so not
  // every call is a new-opportunity sales call. A customer or internal meeting
  // gets a plain takeaways + next-steps recap instead of the qualification one
  // (which would be the wrong shape and read as noise, per Eduardo's feedback).
  const built = await buildRecap({
    tenantId: args.tenantId,
    dealId: dealRow.data.id,
    account: dealRow.data.account,
    framework,
    fallbackStageKey: dealRow.data.stage_key,
    closeDate: dealRow.data.rep_forecast_close_date,
    extraction: args.extraction,
    transcript: args.transcript,
    callId: args.callId ?? null,
    meetingType: args.meetingType,
  });
  const meetingType = built.meetingType;
  let email: ReturnType<typeof renderPostCallSummaryEmail> | null = null;
  // The recommended next action, surfaced for Rolldog next-step write-back. Only
  // set on the qualification recap (new opportunity), never a general recap.
  let nextAction: string | undefined;
  // Handed back so the follow-up draft can reuse it. Regenerating would be a
  // second Anthropic call on every ingest for identical output.
  let qualSummary: PostCallSummary | undefined;
  let genTasks: GeneratedTask[] = [];

  if (built.kind === "general") {
    email = renderGeneralRecapEmail({ account: built.account, recap: built.recap, meetingType });
  } else {
    const summary = built.summary;
    genTasks = built.tasks;

    // buildRecap generates the tasks and deliberately does not persist them, so
    // the write stays on the delivery side where it belongs. This is the only
    // place that turns a generated task into a row.
    if (args.callId && genTasks.length > 0) {
      await createTasksForCall({
        tenantId: args.tenantId,
        dealId: dealRow.data.id,
        callId: args.callId,
        repEmail: to,
        tasks: genTasks,
      }).catch((err) =>
        console.warn(`[post-call] task create failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }

    email = renderPostCallSummaryEmail(summary, genTasks);
    nextAction = summary.nextStepCommitment ?? summary.suggestedNextStep;
    qualSummary = summary;
  }

  if (args.dryRun) {
    // Archive the freshly-rendered recap without sending. The deal page reads
    // from sent_messages, so this refreshes the visible recap to the current
    // framework's format while leaving the rep's inbox untouched.
    await recordSentMessage({
      tenantId: args.tenantId,
      dealId: dealRow.data.id,
      callId: args.callId ?? null,
      kind: "recap",
      toEmail: to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      providerId: null,
    });
    return { sent: false, to, reason: "dry-run: recap archived, email skipped", nextAction, summary: qualSummary };
  }

  try {
    const res = await sendEmail({
      to: recipients.all,
      subject: email.subject,
      html: email.html,
      text: email.text,
    });
    // Archive the exact recap that was sent (best-effort, never blocks).
    await recordSentMessage({
      tenantId: args.tenantId,
      dealId: dealRow.data.id,
      callId: args.callId ?? null,
      kind: "recap",
      toEmail: to,
      subject: email.subject,
      html: email.html,
      text: email.text,
      providerId: res.id || null,
    });
    return { sent: true, to, reason: `resend id ${res.id}`, nextAction, summary: qualSummary };
  } catch (err) {
    if (err instanceof MailerConfigError) {
      return { sent: false, to, reason: `mailer not configured: ${err.message}` };
    }
    return { sent: false, to, reason: err instanceof Error ? err.message : String(err) };
  }
}
