/**
 * The recap and the follow-up draft, on their own cron.
 *
 * WHY THIS IS SEPARATE FROM transcript-sync.
 *
 * Measured on 2026-08-16 against real stored transcripts:
 *
 *   Dunavant   36,635 chars   3m 27s
 *   Yeschb     13,132 chars   1m 38s
 *
 * transcript-sync has a 240 second budget inside a 300 second maxDuration, and
 * it processes every pending call in one invocation. One Dunavant-sized recap
 * consumes 86% of that budget on its own. Worse, the budget is checked at the
 * top of the loop rather than during a call, so a call starting at t=239s runs
 * past the 300s ceiling and the process is killed mid-chain.
 *
 * That is not hypothetical. It is exactly what happened to Ariel on 2026-08-13:
 * Miracle, Mollax and KCarlton each show a recap sent and no follow-up draft,
 * because the draft is the step immediately after the recap and the process
 * died in between. The three-pass recap makes that the common case instead of
 * the edge case.
 *
 * So the split is on DURABILITY, not on tidiness:
 *
 *   transcript-sync   poll, persist the body, extract, mark. Fast, and the
 *                     only part where being killed loses something
 *                     unrecoverable.
 *   recap-sync        everything expensive and re-runnable. Being killed here
 *                     costs a five minute delay and nothing else, because the
 *                     work is rediscovered from the same query next run.
 *
 * The draft moves with the recap deliberately. It consumes the recap's summary,
 * so leaving it behind would either regenerate the summary (a second expensive
 * call) or send a draft built from nothing.
 */

import type { ExtractionMap } from "./briefing-magaya";
import { draftMailboxForCall } from "./call-rep-presence";
import { sendPostCallSummary } from "./post-call-notify";
import type { PostCallSummary } from "./post-call-summary";
import { withModelContext } from "./model-run";
import { supabaseAdmin } from "./supabase";
import type { MeetingType } from "./meeting-classify";

export type RecapSyncCounts = {
  considered: number;
  recapped: number;
  drafted: number;
  skipped: number;
  failed: number;
  /** Left for the next run because there was no time to finish them safely. */
  deferred: number;
};

/**
 * How long one call's recap and draft can take.
 *
 * Set from the measured worst case (3m 27s) plus headroom. The loop refuses to
 * START a call it cannot finish inside maxDuration, which is the guard
 * transcript-sync was missing: checking only elapsed time lets a call begin at
 * t=239s and die at t=300s, halfway through.
 */
const EXPECTED_CALL_MS = 230_000;
/** Vercel kills the function at 300s. Stop well before that. */
const HARD_BUDGET_MS = 270_000;

/** How far back to look for calls that never got a recap. */
const LOOKBACK_DAYS = 7;

/**
 * Outcomes that carry no conversation to recap.
 *
 * A no-show has a transcript: the joining noise, "okay", "I'll be on the line",
 * and then nothing. It passes a length check and it is not a call. The first
 * thing this cron picked up was exactly that, an internal no-show of Ariel's
 * with 1,104 characters of hellos, and without this it would have emailed him a
 * recap of a meeting that never happened.
 *
 * A no-show has its own path (sendNoShowFollowup) and does not belong here.
 */
const NO_CONTENT = new Set([
  "no_conversation",
  "no_show",
  "rescheduled",
  "placeholder",
  "capture_failed",
  "duplicate",
]);

export async function runRecapSync(
  opts: { dryRun?: boolean; limit?: number } = {},
): Promise<RecapSyncCounts> {
  const counts: RecapSyncCounts = {
    considered: 0,
    recapped: 0,
    drafted: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
  };
  const db = supabaseAdmin();
  const startedAt = Date.now();

  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();

  // Calls that have a transcript and have not been recapped.
  //
  // Driven off sent_messages rather than a column on calls, because that is
  // already the idempotency record sendPostCallSummary itself checks. A second
  // marker would be a second thing to keep true.
  const calls = await db
    .from("calls")
    .select("id, tenant_id, deal_id, meeting_type, call_subtype, outcome, scheduled_start, title, deals!inner(external_id)")
    .eq("has_been_extracted", true)
    .gte("scheduled_start", since)
    .order("scheduled_start", { ascending: true });
  if (calls.error) {
    throw new Error(`[recap-sync] could not list calls: ${calls.error.message}`);
  }

  const rows = (calls.data ?? []) as unknown as Array<{
    id: string;
    tenant_id: string;
    deal_id: string;
    meeting_type: string | null;
    call_subtype: string | null;
    outcome: string | null;
    scheduled_start: string | null;
    title: string | null;
    deals: { external_id: string | null };
  }>;

  for (const row of rows) {
    if (opts.limit && counts.recapped >= opts.limit) break;

    // Refuse to start what we cannot finish. This is the guard transcript-sync
    // lacks, and the reason a recap here can be interrupted without loss.
    const elapsed = Date.now() - startedAt;
    if (elapsed + EXPECTED_CALL_MS > HARD_BUDGET_MS) {
      counts.deferred = rows.length - counts.considered;
      console.warn(
        `[recap-sync] stopping after ${Math.round(elapsed / 1000)}s with ${counts.deferred} call(s) ` +
          `left. They are untouched and the next run picks them up.`,
      );
      break;
    }

    counts.considered += 1;

    if (row.outcome && NO_CONTENT.has(row.outcome)) {
      counts.skipped += 1;
      continue;
    }

    // CLAIM THE CALL BEFORE GENERATING.
    //
    // Snatek received two recaps twenty seconds apart on 2026-08-18. The
    // idempotency check below reads sent_messages, and sendPostCallSummary
    // writes that row only AFTER the email goes out. Generation takes minutes,
    // so two overlapping runs both read "no recap yet", both generate, and both
    // send. Checking is not reserving.
    //
    // The claim row closes the window from the length of a generation to the
    // length of one insert. It is written with provider_id null, which the
    // existing guard already treats as "not sent", so it cannot itself be
    // mistaken for a delivered recap.
    const claimed = await db
      .from("sent_messages")
      .select("id")
      .eq("tenant_id", row.tenant_id)
      .eq("call_id", row.id)
      .eq("kind", "recap_claim")
      .limit(1);
    if (claimed.error) {
      counts.failed += 1;
      console.error(`[recap-sync] claim check failed for ${row.id}: ${claimed.error.message}`);
      continue;
    }
    if ((claimed.data ?? []).length > 0) {
      counts.skipped += 1;
      continue;
    }

    const already = await db
      .from("sent_messages")
      .select("id")
      .eq("tenant_id", row.tenant_id)
      .eq("call_id", row.id)
      .eq("kind", "recap")
      .not("provider_id", "is", null)
      .limit(1);
    if (already.error) {
      // Do not guess. An unreadable idempotency check is not permission to send
      // a second recap to a rep who already has one.
      counts.failed += 1;
      console.error(`[recap-sync] idempotency check failed for ${row.id}: ${already.error.message}`);
      continue;
    }
    if ((already.data ?? []).length > 0) {
      counts.skipped += 1;
      continue;
    }

    const externalId = row.deals.external_id;
    if (!externalId) {
      counts.skipped += 1;
      continue;
    }

    const tr = await db.from("transcripts").select("body").eq("call_id", row.id).maybeSingle();
    const transcript = tr.data?.body ?? "";
    if (transcript.trim().length < 50) {
      // No body to recap from. Not a failure of this run and not something a
      // retry fixes, so it is counted as skipped rather than failed.
      counts.skipped += 1;
      continue;
    }

    // WAIT FOR EXTRACTION, do not race it.
    //
    // transcript-sync sets has_been_extracted BEFORE running extraction, on
    // purpose: the transcript body is durable at that point and the flag stops
    // the call being re-polled. But this cron filters on that same flag, so it
    // can pick a call up in the gap between the mark and the rows landing.
    //
    // Mohawk Global is what that looks like. Ten fields were captured and
    // correctly attributed to the call, and the recap still said "Nothing new
    // was captured on this call" because it read field_extractions before they
    // were written. The readout was rich, because it only needs the transcript.
    // The audit was empty, which is the half a rep checks against the CRM.
    //
    // Zero rows is ambiguous: extraction may not have run yet, or it may have
    // run and found nothing. The call's age separates them. Inside the grace
    // window we defer and the next run picks it up; past it we accept that
    // nothing was found and send the recap rather than withholding it forever.
    const fx = await db
      .from("field_extractions")
      .select("framework_field_key, status, answer, evidence, confidence")
      .eq("deal_id", row.deal_id)
      .eq("last_updated_from_call_id", row.id);
    // extraction_completed_at is the explicit signal and is preferred whenever
    // it is present. It is read SEPARATELY and tolerantly rather than joined
    // into the query above, because the column arrives in
    // supabase/add-extraction-completed-at.sql and this cron is live: selecting
    // a column that does not exist yet fails the whole query and stops every
    // recap. A schema change must never be able to take down the thing it is
    // meant to improve.
    //
    // The age check remains as the backstop, both for rows that predate the
    // column and for the window before the migration is applied.
    const stamp = await db
      .from("calls")
      .select("extraction_completed_at")
      .eq("id", row.id)
      .maybeSingle();
    const completedAt = stamp.error ? null : (stamp.data?.extraction_completed_at ?? null);
    const EXTRACTION_GRACE_MS = 20 * 60_000;
    const callAgeMs = row.scheduled_start ? Date.now() - Date.parse(row.scheduled_start) : Infinity;
    const extractionPending =
      completedAt === null && (fx.data ?? []).length === 0 && callAgeMs < EXTRACTION_GRACE_MS;
    if (extractionPending) {
      counts.skipped += 1;
      console.warn(
        `[recap-sync] deferring ${row.id}: extraction has not completed and the call ended ` +
          `${Math.round(callAgeMs / 60000)} min ago. Recapping now would report zero captured fields.`,
      );
      continue;
    }
    const extraction = Object.fromEntries(
      (fx.data ?? []).map((x) => [
        String((x as { framework_field_key: string }).framework_field_key),
        x,
      ]),
    ) as unknown as ExtractionMap;

    if (opts.dryRun) {
      console.log(`[recap-sync] would recap call ${row.id} (${transcript.length} chars)`);
      counts.recapped += 1;
      continue;
    }

    // Written immediately before generation, never after. A crash between here
    // and the send leaves the call unrecapped until someone clears the claim,
    // which is the safe direction: a missing recap is visible in the coverage
    // view, a duplicate one is already in a rep's inbox.
    const claim = await db.from("sent_messages").insert({
      tenant_id: row.tenant_id,
      deal_id: row.deal_id,
      call_id: row.id,
      kind: "recap_claim",
      to_email: "",
      subject: "recap in progress",
      body_html: "",
      body_text: "",
    });
    if (claim.error) {
      counts.failed += 1;
      console.error(`[recap-sync] could not claim ${row.id}, skipping rather than risking a duplicate: ${claim.error.message}`);
      continue;
    }

    try {
      // The recap passes are the two most expensive calls in the system,
      // measured at ~14,000 tokens and 75s for the narrative and ~14,000 and
      // 57s for the demo strategy. Untagged they were the largest
      // unattributable line in the bill.
      // THE FOLLOW-UP DRAFT, WRITTEN BEFORE THE RECAP IS SENT so its card can
      // ride at the top of the recap instead of arriving as a second email a
      // minute later.
      //
      // Measured over 17 days: a rep gets a median of 4 DealRipe emails a day
      // and Ariel Rodriguez had a 13-email day on 2026-08-13. A separate
      // draft-ready email would have made that 18, and it would have landed in
      // the same folder as the recap, since Ariel files DealRipe mail by rule.
      // More volume, no more reach.
      //
      // The bookkeeping stays HERE and only the card goes back: the state
      // column, the counters and the archive row are recap-sync's business and
      // none of them belong in the notifier. The notifier calls this after it
      // has already rendered the recap, so anything that goes wrong below costs
      // the card and never the recap.
      const makeDraft = async (ctx: {
        summary?: PostCallSummary;
        agreed?: { weOwe: string[]; customerOwes: string[] };
      }): Promise<{ html: string; text: string } | null> => {
        const { autoDraftFollowUpForCall } = await import("./followup-draft");
        const callRow = await db
          .from("calls")
          .select("participants, scheduled_start, call_date, title, deals!inner(account, rep_email)")
          .eq("id", row.id)
          .maybeSingle();
        const d = callRow.data as unknown as {
          participants: unknown;
          scheduled_start: string | null;
          call_date: string | null;
          title: string | null;
          deals: { account: string; rep_email: string | null };
        } | null;
        if (!d) return null;

        // The draft goes in the mailbox of whoever RAN the call, which is not
        // always the deal owner. This path is the cron and produces most
        // drafts, so resolving it only in post-call-notify would have fixed the
        // fallback and left the common case alone. Falls back to the owner on
        // anything it cannot establish.
        const box = await draftMailboxForCall({
          callId: row.id,
          owner: d.deals.rep_email ?? "",
        }).catch(() => null);
        if (box?.rerouted) {
          console.log(`[recap-sync] draft rerouted ${d.deals.rep_email} -> ${box.mailbox}: ${box.reason}`);
        }

        const draft = await autoDraftFollowUpForCall({
          tenantId: row.tenant_id,
          callId: row.id,
          dealId: row.deal_id,
          account: d.deals.account,
          repEmail: box?.mailbox ?? d.deals.rep_email,
          meetingType: row.meeting_type,
          // So a proposal call gets a terms email and a discovery call gets a recap.
          callSubtype: row.call_subtype ?? null,
          // The source the email is written from. Everything else is checked detail.
          transcript,
          summary: ctx.summary,
          agreed: ctx.agreed,
          callDate: d.scheduled_start ?? d.call_date,
          participants: d.participants,
          meetingTitle: d.title,
        });

        // RECORD THE OUTCOME, always.
        //
        // followup_draft_state existed and nothing ever wrote it, so every call
        // in the database read 'not_attempted' including the ones that
        // demonstrably got a draft. A rep looking at "never sent" had no way to
        // learn whether we held deliberately, failed, or could not read the
        // mailbox, and those are three different answers.
        if (draft.created) {
          counts.drafted += 1;
          await db
            .from("calls")
            .update({ followup_draft_state: "drafted", followup_draft_reason: null })
            .eq("id", row.id);
          return draft.card ?? null;
        }
        const { classifyDraftOutcome } = await import("./ingest-failure-class");
        const cls = classifyDraftOutcome(draft.reason ?? "no reason given");
        await db
          .from("calls")
          .update({ followup_draft_state: cls.state, followup_draft_reason: cls.reason })
          .eq("id", row.id);
        console.warn(`[recap-sync] draft ${cls.state} for ${row.id}: ${cls.reason}`);
        return null;
      };

      const notify = await withModelContext(
        { tenantId: row.tenant_id, dealId: row.deal_id, callId: row.id },
        () =>
          sendPostCallSummary({
            tenantId: row.tenant_id,
            dealExternalId: externalId,
            extraction,
            transcript,
            meetingType: (row.meeting_type as MeetingType | null) ?? undefined,
            callId: row.id,
            // Without this the audit measures against where the deal stands
            // today rather than where it stood on the call, and history can
            // cite a later conversation than the one being recapped.
            callAt: row.scheduled_start,
            callTitle: row.title ?? null,
            makeDraft,
          }),
      );
      if (notify.sent) counts.recapped += 1;
      else {
        counts.skipped += 1;
        console.warn(`[recap-sync] recap not sent for ${row.id}: ${notify.reason}`);
      }

      // The draft, in the same pass and its own try, so a Graph failure costs
      // the draft and not the recap that already went out.
      //
      // Attempt the draft on every call that produced a recap, qualification
      // or general.
      //
      // This used to gate on notify.summary, which is set only on the
      // qualification path. So an existing-customer call got a general recap,
      // no summary, and the draft block never executed: no draft, no state, no
      // log. It silently defeated the type gate opened in 23ba82e, which was
      // supposed to give every non-internal call a draft. Medovlog,
      // Ardentgloballogistics and Promptus on 2026-08-27 are that bug.
      //
      // Safe now because the draft is written from the transcript and takes an
      // optional summary. A renewal call loses a timezone hint and a next-step
      // line, not the email.
      if (notify.sent) {
        try {
          // The Salesforce call activity and the agreed next step, which carry
          // the recap body and therefore belong with the recap rather than with
          // the field write-back in transcript-sync. Own try: a Salesforce
          // outage costs the activity, not the draft that just succeeded.
          try {
            const { readSalesforceLink } = await import("./salesforce-link");
            const link = await readSalesforceLink(row.tenant_id, row.deal_id);
            // The Salesforce call activity carries the qualification summary
            // into a Task, so it genuinely needs one. A general recap has none,
            // and inventing an empty activity is worse than logging nothing.
            // Guarded here rather than around the draft, which no longer needs it.
            if (link.status === "linked" && notify.summary) {
              const { logCallToSalesforce, logNextStepToSalesforce } = await import(
                "./salesforce-activity"
              );
              const meta = await db
                .from("calls")
                .select("title, participants, deals!inner(account, rep_email)")
                .eq("id", row.id)
                .maybeSingle();
              const mm = meta.data as unknown as {
                title: string | null;
                participants: unknown;
                deals: { account: string; rep_email: string | null };
              } | null;
              const people = Array.isArray(mm?.participants)
                ? (mm?.participants as Array<{ name?: string | null; email?: string | null }>)
                : [];
              const attendees = people
                .map((p) => (p?.name ?? p?.email ?? "").trim())
                .filter(Boolean)
                .join(", ");
              const logged = await logCallToSalesforce({
                tenantSlug: "magaya",
                accountId: link.accountId,
                accountName: mm?.deals.account ?? externalId,
                summary: notify.summary,
                callDate: row.scheduled_start,
                meetingTitle: mm?.title ?? null,
                repEmail: mm?.deals.rep_email ?? null,
                attendees: attendees || null,
                apply: true,
              });
              if (!logged.logged) {
                console.warn(`[recap-sync] salesforce activity skipped for ${row.id}: ${logged.reason}`);
              }
              // nextStepCommitment ONLY. suggestedNextStep is DealRipe's
              // inference and does not belong in a rep's work queue.
              const nextStep = await logNextStepToSalesforce({
                tenantSlug: "magaya",
                accountId: link.accountId,
                accountName: mm?.deals.account ?? externalId,
                commitment: notify.summary.nextStepCommitment ?? null,
                callDate: row.scheduled_start,
                repEmail: mm?.deals.rep_email ?? null,
                apply: true,
              });
              if (!nextStep.created) {
                console.warn(`[recap-sync] salesforce next step skipped for ${row.id}: ${nextStep.reason}`);
              }

              // The recap as a Salesforce Note.
              //
              // lib/salesforce-note.ts has existed and worked for a while and
              // was called by exactly one thing: scripts/preview-recap.ts
              // --post-note. So every Note in Magaya's CRM was posted by hand,
              // one at a time, which is what Eduardo meant on 2026-08-20 by
              // "still missing the notes in some deals".
              //
              // The Note is the artifact a second person reads: he pasted one
              // in by hand the day after a call, then shared it with the
              // solution engineer to prep the demo. The email is for the rep;
              // the Note is for the team.
              //
              // postRecapNote is idempotent on a title carrying the CALL date
              // rather than a run timestamp, so a recap-sync retry cannot leave
              // a second Note on a customer's record. Its own try: a Note
              // failure must not cost the activity that just succeeded.
              if (notify.noteBody) {
                try {
                  const { postRecapNote } = await import("./salesforce-note");
                  const note = await postRecapNote({
                    tenantSlug: "magaya",
                    accountId: link.accountId,
                    account: mm?.deals.account ?? externalId,
                    callAt: row.scheduled_start,
                    body: notify.noteBody,
                    apply: true,
                  });
                  if (!note.posted) {
                    console.warn(`[recap-sync] salesforce note not posted for ${row.id}: ${note.reason}`);
                  }
                } catch (noteErr) {
                  console.error(
                    `[recap-sync] salesforce note threw for ${row.id}:`,
                    noteErr instanceof Error ? noteErr.message : noteErr,
                  );
                }
              }
            }
          } catch (sfErr) {
            console.error(
              `[recap-sync] salesforce activity threw for ${row.id}:`,
              sfErr instanceof Error ? sfErr.message : sfErr,
            );
          }
        } catch (draftErr) {
          // RECORD IT. A throw used to leave followup_draft_state on
          // 'not_attempted', which is the value a call carries when nothing was
          // ever tried, so an exception here was indistinguishable from a call
          // we deliberately skipped. The success and held paths above were
          // fixed for exactly this reason and this one was missed, so the only
          // trace of a crashed draft was a log line nobody reads.
          //
          // Found 2026-08-28: two calls carried a sent recap, a
          // followup_draft_state of 'not_attempted', and no draft. Steven
          // Johnson's whole complaint was a draft that silently never arrived.
          const message = draftErr instanceof Error ? draftErr.message : String(draftErr);
          console.error(`[recap-sync] draft threw for ${row.id}:`, message);
          await db
            .from("calls")
            .update({ followup_draft_state: "failed", followup_draft_reason: `threw: ${message}`.slice(0, 500) })
            .eq("id", row.id)
            .then(
              () => undefined,
              () => undefined,
            );
        }
      }
    } catch (err) {
      counts.failed += 1;
      console.error(
        `[recap-sync] recap threw for ${row.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return counts;
}
