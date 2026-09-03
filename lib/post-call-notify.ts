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
import { formatMeetingWhen } from "./followup-draft";
import { MailerConfigError, sendEmail } from "./mailer";
import { getDealContext } from "./deal-context";
import { recipientsForCall } from "./call-recipients";
import { feedbackFooterHtml, feedbackFooterText, newFeedbackToken } from "./artifact-feedback";
import { draftMailboxForCall } from "./call-rep-presence";
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
  /** The calendar subject, for the recap header. */
  callTitle?: string | null;
  /** Bypass the idempotency guard and re-send even if a recap was already
   *  emailed for this call. Manual recovery scripts set this; the automatic
   *  pipeline never does, so a re-ingest can't double-send. */
  force?: boolean;
  /**
   * The caller already holds this call's recap_claim, so do not take it again.
   *
   * recap-sync claims before it generates, and without this it would be
   * rejected by its own claim and never send anything. Every other caller
   * (transcript-sync, reextract, ingest-manual) reaches this function
   * unclaimed, which is why 80 of 153 recapped calls have no claim row at all
   * and why 9 calls were recapped twice inside five minutes.
   */
  claimHeld?: boolean;
  /**
   * Write the follow-up draft, and hand back the card to sit at the top of this
   * recap.
   *
   * A HOOK rather than a call, so recap-sync keeps ownership of the draft: the
   * state column, the retry accounting and the sent_messages archive all live
   * there and none of it belongs in the notifier. This only needs the card.
   *
   * Called AFTER the recap has been built and rendered, so a draft that throws
   * cannot cost the rep their recap. Returning null is normal and means no draft
   * was written: an internal meeting, a rep with no mailbox, a call with no
   * customer to write to.
   */
  makeDraft?: (ctx: {
    summary?: PostCallSummary;
    agreed?: { weOwe: string[]; customerOwes: string[] };
  }) => Promise<{ html: string; text: string } | null>;
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

  // WHOSE OUTLOOK THE DRAFT GOES IN, which is not always the deal owner.
  //
  // The recap goes to everyone who was on the call; a draft can only go to one
  // mailbox, because only the person holding it can send it. Steven Johnson,
  // 2026-09-02: a Great Way meeting he was invited to and did not attend put a
  // draft in his Outlook while Alexandra Suntrup, who ran the call, had nothing
  // to send. Measured over the last 40 captured calls this moves 3 of them.
  //
  // Falls back to the owner on anything it cannot establish, including a
  // transcript that matched no pilot rep at all: that is evidence the name
  // matching failed, not evidence the owner was absent.
  const draftBox = args.callId
    ? await draftMailboxForCall({ callId: args.callId, owner: to }).catch(() => null)
    : null;
  const draftMailbox = draftBox?.mailbox ?? to;
  if (draftBox?.rerouted) {
    console.log(`[post-call] draft rerouted ${to} -> ${draftMailbox}: ${draftBox.reason}`);
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

  email = renderRecapEmail(built, {
    meetingTitle: args.callTitle ?? null,
    meetingWhen: args.callAt ? formatMeetingWhen(args.callAt) : null,
  });
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

  // THE FOLLOW-UP DRAFT, FOLDED INTO THIS RECAP RATHER THAN SENT SEPARATELY.
  //
  // It used to be its own email, one minute after this one, about the same call.
  // Measured over 17 days: a rep gets a median of 4 DealRipe emails a day and
  // Ariel Rodriguez had a 13-email day on 2026-08-13; a second post-call email
  // would have made that 18. Two emails a minute apart is how a rep starts
  // filtering the whole channel.
  //
  // Everything here is contained. The recap is already rendered by this point,
  // so a draft that throws, times out or returns nothing leaves the recap
  // exactly as it was. That ordering is deliberate and is the reason the hook
  // sits here rather than before the render.
  if (email) {
    try {
      // THE HOOK IS OPTIONAL AND THE DRAFT IS NOT.
      //
      // makeDraft was a parameter every caller had to remember, and three of the
      // five did not: transcript-sync calls this in two places and
      // reextract/ingest-manual in one each. Landstar was recapped through
      // transcript-sync's general path on 2026-08-31 and got no draft at all,
      // with followup_draft_state left at not_attempted and no reason recorded,
      // which reads as "we never tried" because we never did.
      //
      // A caller may still pass makeDraft to own the bookkeeping, which
      // recap-sync does. Without one, the draft still runs. Whether a rep gets a
      // follow-up cannot depend on which code path happened to send the recap.
      const card = args.makeDraft
        ? await args.makeDraft({ summary: qualSummary, agreed })
        : await defaultDraft({
            tenantId: args.tenantId,
            dealId: dealRow.data.id,
            callId: args.callId ?? null,
            account: dealRow.data.account,
            repEmail: draftMailbox,
            transcript: args.transcript,
            meetingType: meetingType ?? null,
            summary: qualSummary,
            agreed,
          });
      if (card) email = prependDraftCard(email, card);
    } catch (err) {
      console.warn(
        `[post-call] draft card skipped, recap unaffected: ${err instanceof Error ? err.message : String(err)}`,
      );
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

  // ASK WHETHER THIS WAS USEFUL, at the foot of the thing itself.
  //
  // Alexandra Suntrup asked for this on 2026-09-02 and reacted to it more
  // strongly than to anything else on that call. The token is minted here
  // because the link must be inside the HTML before the row that stores it
  // exists.
  //
  // The recap only. Every artifact could carry one and a rep who is already
  // getting a median of five DealRipe emails a day would start ignoring all of
  // them. This is the artifact she rates highest and reads most, so it is the
  // one worth asking about.
  const feedbackToken = newFeedbackToken();
  email = {
    ...email,
    html: `${email.html}${feedbackFooterHtml(feedbackToken, "Was this recap useful?")}`,
    text: `${email.text}\n\n${feedbackFooterText(feedbackToken, "Was this recap useful?")}`,
  };

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
      feedbackToken,
    });
    return { sent: false, to, reason: "dry-run: recap archived, email skipped", nextAction, summary: qualSummary, agreed };
  }

  // RESERVE THE SEND, immediately before it and with nothing in between.
  //
  // The idempotency check above is a read taken minutes earlier, before a
  // three-pass recap that takes over three minutes to generate. Two runs that
  // both pass it both generate and both send, which is how Steven got two
  // Folguerascb recaps 27 seconds apart on 2026-09-02 and thumbed the first
  // one down.
  //
  // Deliberately placed here rather than before generation. Claiming early
  // would save the duplicated model work, but every early return between there
  // and here would strand the claim and block the call from ever being
  // recapped. Here there is nothing between the claim and the send except the
  // send, so the only failure to handle is the send itself. Duplicated
  // generation costs tokens; a duplicated email costs a rep's trust, and a
  // stranded claim costs the recap entirely.
  let claimedRecapRow: string | null = null;
  if (!args.claimHeld && args.callId) {
    const { claimSentMessageSlot } = await import("./sent-messages");
    const claim = await claimSentMessageSlot({
      tenantId: args.tenantId,
      dealId: dealRow.data.id,
      callId: args.callId,
      kind: "recap_claim",
      toEmail: to,
    });
    if (claim.status === "raced") {
      return { sent: false, to, reason: "another run is already sending this recap" };
    }
    if (claim.status === "error") {
      // Fail closed. Not being able to reserve is not permission to send a
      // second recap to a rep.
      return { sent: false, to, reason: `could not establish whether this recap is already being sent: ${claim.message}` };
    }
    claimedRecapRow = claim.rowId;
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
      feedbackToken,
    });
    return { sent: true, to, reason: `resend id ${res.id}`, nextAction, summary: qualSummary, agreed, noteBody };
  } catch (err) {
    // Nothing was sent, so give the claim back or the retry that would have
    // worked reads as "another run is already sending this".
    if (claimedRecapRow) {
      const { releaseSentMessageSlot } = await import("./sent-messages");
      await releaseSentMessageSlot(claimedRecapRow);
    }
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
/**
 * Put the draft card at the very top of the recap body.
 *
 * Inserted after the opening <body> tag rather than rebuilt into each recap
 * renderer. There are four of them (qualification, readout-only, general
 * fallback, and the legacy summary email) and threading a card parameter through
 * all four would put the same block in four places to drift apart. The <body>
 * tag is a seam every one of them shares.
 *
 * At the TOP because the draft is the thing the rep acts on. The recap is what
 * they read; the draft is what they send.
 */
export function prependDraftCard<T extends { html: string; text: string }>(
  email: T,
  card: { html: string; text: string },
): T {
  const shell = `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:18px;line-height:24px;color:#0F172A;font-weight:700;margin:0 0 9px 2px;">Follow up on this meeting</div><div style="background:#FFFFFF;border:1px solid #E7EBF0;border-radius:10px;padding:18px 20px;margin:0 0 22px 0;">${card.html}</div>`;

  // THE SLOT FIRST, the <body> tag only as a fallback.
  //
  // Prepending after <body> put the card above the DealRipe wordmark, outside
  // the 600px layout, so it read as a separate email stapled to the top of a
  // recap rather than the first section of one. The recap template carries an
  // explicit slot inside the layout, under the header and above the RECAP
  // label, which is where it belongs: same page, named section, in the order the
  // rep acts.
  const SLOT = "<!--DEALRIPE_CARD_SLOT-->";
  let html: string;
  let placed: "slot" | "body" | "prepended";
  if (email.html.includes(SLOT)) {
    html = email.html.replace(SLOT, shell);
    placed = "slot";
  } else {
    const afterBody = email.html.replace(/(<body[^>]*>)/i, (m) => `${m}${shell}`);
    if (afterBody !== email.html) {
      html = afterBody;
      placed = "body";
    } else {
      // Never lose the card because a renderer changed shape. Say so: a section
      // that vanishes quietly is exactly the failure this codebase keeps paying
      // for.
      html = `${shell}${email.html}`;
      placed = "prepended";
    }
  }
  if (placed !== "slot") {
    console.warn(`[post-call] recap html had no card slot, follow-up card ${placed} instead`);
  }

  return {
    ...email,
    html,
    text: `FOLLOW UP ON THIS MEETING\n\n${card.text}\n\n${"-".repeat(40)}\n\n${email.text}`,
  };
}

/**
 * Write the follow-up draft when the caller did not bring its own hook.
 *
 * Does the same work recap-sync's makeDraft does, including the state column, so
 * a draft written through transcript-sync is recorded exactly like one written
 * through recap-sync. Best effort throughout: the recap is already rendered when
 * this runs, and nothing here may cost it.
 */
async function defaultDraft(a: {
  tenantId: string;
  dealId: string;
  callId: string | null;
  account: string;
  repEmail: string;
  transcript: string;
  meetingType: string | null;
  summary?: PostCallSummary;
  agreed?: { weOwe: string[]; customerOwes: string[] };
}): Promise<{ html: string; text: string } | null> {
  if (!a.callId) return null;
  const { supabaseAdmin } = await import("./supabase");
  const { autoDraftFollowUpForCall } = await import("./followup-draft");
  const db = supabaseAdmin();

  const callRow = await db
    .from("calls")
    .select("participants, scheduled_start, call_date, title, call_subtype")
    .eq("id", a.callId)
    .maybeSingle();
  const c = callRow.data as unknown as {
    participants: unknown;
    scheduled_start: string | null;
    call_date: string | null;
    title: string | null;
    call_subtype: string | null;
  } | null;
  if (!c) return null;

  const draft = await autoDraftFollowUpForCall({
    tenantId: a.tenantId,
    callId: a.callId,
    dealId: a.dealId,
    account: a.account,
    repEmail: a.repEmail,
    meetingType: a.meetingType,
    callSubtype: c.call_subtype,
    transcript: a.transcript,
    summary: a.summary,
    agreed: a.agreed,
    callDate: c.scheduled_start ?? c.call_date,
    participants: c.participants,
    meetingTitle: c.title,
  });

  if (draft.created) {
    await db
      .from("calls")
      .update({ followup_draft_state: "drafted", followup_draft_reason: null })
      .eq("id", a.callId);
    return draft.card ?? null;
  }
  const { classifyDraftOutcome } = await import("./ingest-failure-class");
  const cls = classifyDraftOutcome(draft.reason ?? "no reason given");
  await db
    .from("calls")
    .update({ followup_draft_state: cls.state, followup_draft_reason: cls.reason })
    .eq("id", a.callId);
  console.warn(`[post-call] draft ${cls.state} for ${a.callId}: ${cls.reason}`);
  return null;
}

export function renderRecapEmail(
  built: RecapBuild,
  meeting?: { meetingTitle?: string | null; meetingWhen?: string | null },
): ReturnType<typeof renderPostCallSummaryEmail> | null {
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
    // The header was accepting these and nothing was handing them over, so the
    // recap printed the account and went straight into the sections while the
    // briefing showed the meeting and the time. A parameter added at one end of
    // a call and not the other fails silently and looks like the feature was
    // never built.
    meetingTitle: meeting?.meetingTitle ?? null,
    meetingWhen: meeting?.meetingWhen ?? null,
  });
}
