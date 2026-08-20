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
import { renderPostCallSummaryEmail, renderReadoutOnlyEmail } from "./emails/post-call-summary";
import { loadFramework } from "./framework";
import { type MeetingType } from "./meeting-classify";
import { buildRecap, type RecapBuild } from "./recap-build";
import { formatMeetingTime } from "./graph-time";
import { renderRecapEmailBody, renderRecapNote } from "./recap-render";
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
  /**
   * The commitments the narrative pass verified, for the follow-up draft.
   *
   * Handed over rather than re-derived. The draft used to work the transcript
   * out for itself and promised Juan's customer a proposal he was not sending,
   * because the call discussed one. Every line here has a transcript quote
   * behind it.
   */
  agreed?: { weOwe: string[]; customerOwes: string[] };
  /**
   * The recap rendered as a Salesforce Note body.
   *
   * Handed back rather than re-derived, because the caller has neither the
   * narrative nor the demo strategy: those live inside the RecapBuild that
   * never leaves this function. renderRecapNote needs both, so the choice is
   * to return the body or to build the whole recap a second time.
   *
   * Set only for qualification recaps. A renewal or support call gets a
   * readout and no qualification record, per docs/recap-target-eduardo.md, so
   * there is no Note to write.
   */
  noteBody?: string;
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
  /**
   * When the call happened.
   *
   * Bounds prior-call history and the stage the audit measures against. Without
   * it buildRecap falls back to "now", which is how Mohawk Global's first intro
   * call was audited for Signature and Legal Terms: the deal carries a Rolldog
   * stage of SQL3 and nothing scoped the audit back to the call.
   */
  callAt?: string | null;
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
  let noteBody: string | undefined;
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
    callAt: args.callAt ?? null,
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
  let agreed: { weOwe: string[]; customerOwes: string[] } | undefined;
  let genTasks: GeneratedTask[] = [];

  email = renderRecapEmail(built);
  if (built.kind === "qualification") {
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

    nextAction = built.summary.nextStepCommitment ?? built.summary.suggestedNextStep;
    qualSummary = built.summary;
    // The Note body, for recap-sync to post to Salesforce. Eduardo pasted one
    // in by hand the day after a call and then shared it with the solution
    // engineer to prep the demo, so the Note is the artifact a second person
    // actually reads. Rendered here because this is the only place the
    // narrative and demo strategy exist.
    noteBody = renderRecapNote({
      account: built.account,
      callTitle: null,
      callAt: args.callAt ? formatMeetingTime(args.callAt) : null,
      stageKey: built.stageKey,
      narrative: built.narrative,
      demoStrategy: built.demoStrategy,
      captured: built.summary.captured,
      stillOpen: built.summary.stillOpen,
      history: built.history,
    });
    if (built.narrative.status === "present") {
      agreed = {
        weOwe: built.narrative.value.nextSteps.weOwe.map((f) => f.statement),
        customerOwes: built.narrative.value.nextSteps.customerOwes.map((f) => f.statement),
      };
    }
  }

  // Both passes produced nothing. Say so rather than sending an empty shell:
  // no recap beats a recap that asserts a call had no content.
  if (!email) {
    return {
      sent: false,
      to,
      reason:
        built.kind === "general"
          ? `no readout could be generated for this ${built.meetingType} call, and the fallback recap also returned nothing`
          : "no recap could be rendered",
    };
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
    return { sent: false, to, reason: "dry-run: recap archived, email skipped", nextAction, summary: qualSummary, agreed };
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
    return { sent: true, to, reason: `resend id ${res.id}`, nextAction, summary: qualSummary, agreed, noteBody };
  } catch (err) {
    if (err instanceof MailerConfigError) {
      return { sent: false, to, reason: `mailer not configured: ${err.message}` };
    }
    return { sent: false, to, reason: err instanceof Error ? err.message : String(err) };
  }
}


/** Minimal escaping for the plain-text readout rendered into an HTML mail. */
function escapeHtmlBasic(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}


/**
 * Which email a built recap becomes.
 *
 * Extracted from sendPostCallSummary so scripts/preview-recap-email.ts can show
 * the EXACT html that would be sent. A preview that re-picks the renderer
 * itself would drift from production and then reassure you about an email
 * nobody is going to receive, which is the specific failure this codebase keeps
 * paying for.
 *
 * Pure: no writes, no sends. Returns null when neither pass produced anything,
 * which the caller reports rather than papering over.
 */
export function renderRecapEmail(built: RecapBuild): ReturnType<typeof renderPostCallSummaryEmail> | null {
  if (built.kind === "general") {
    // The readout is the artifact. renderGeneralRecapEmail is the fallback
    // shape and only fires when the narrative produced nothing at all.
    if (built.narrative.status === "present") {
      // The same card shell as the qualification recap, minus the audit. A <pre>
      // block was making existing-customer recaps look like a log dump next to
      // every discovery recap.
      return renderReadoutOnlyEmail({
        account: built.account,
        narrative: built.narrative,
        demoStrategy: {
          status: "absent",
          reason: "not a new-opportunity call, so no demo strategy was planned",
        },
        meetingTypeLabel:
          built.meetingType === "existing_customer" ? "Existing customer" : "Internal",
      });
    }
    return built.recap
      ? renderGeneralRecapEmail({
          account: built.account,
          recap: built.recap,
          meetingType: built.meetingType,
        })
      : null;
  }

  return renderPostCallSummaryEmail(built.summary, built.tasks, {
    narrative: built.narrative,
    demoStrategy: built.demoStrategy,
    crmStageKey: built.crmStageKey,
  });
}
