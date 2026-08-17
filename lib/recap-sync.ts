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
import { sendPostCallSummary } from "./post-call-notify";
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
    .select("id, tenant_id, deal_id, meeting_type, outcome, scheduled_start, deals!inner(external_id)")
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
    outcome: string | null;
    scheduled_start: string | null;
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

    const fx = await db
      .from("field_extractions")
      .select("framework_field_key, status, answer, evidence, confidence")
      .eq("deal_id", row.deal_id)
      .eq("last_updated_from_call_id", row.id);
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

    try {
      const notify = await sendPostCallSummary({
        tenantId: row.tenant_id,
        dealExternalId: externalId,
        extraction,
        transcript,
        meetingType: (row.meeting_type as MeetingType | null) ?? undefined,
        callId: row.id,
      });
      if (notify.sent) counts.recapped += 1;
      else {
        counts.skipped += 1;
        console.warn(`[recap-sync] recap not sent for ${row.id}: ${notify.reason}`);
      }

      // The draft, in the same pass and its own try, so a Graph failure costs
      // the draft and not the recap that already went out.
      if (notify.summary) {
        try {
          const { autoDraftFollowUpForCall } = await import("./followup-draft");
          const callRow = await db
            .from("calls")
            .select("participants, scheduled_start, call_date, deals!inner(account, rep_email)")
            .eq("id", row.id)
            .maybeSingle();
          const d = callRow.data as unknown as {
            participants: unknown;
            scheduled_start: string | null;
            call_date: string | null;
            deals: { account: string; rep_email: string | null };
          } | null;
          if (d) {
            const draft = await autoDraftFollowUpForCall({
              tenantId: row.tenant_id,
              callId: row.id,
              dealId: row.deal_id,
              account: d.deals.account,
              repEmail: d.deals.rep_email,
              meetingType: row.meeting_type,
              summary: notify.summary,
              agreed: notify.agreed,
              callDate: d.scheduled_start ?? d.call_date,
              participants: d.participants,
            });
            if (draft.created) counts.drafted += 1;
            else console.warn(`[recap-sync] draft skipped for ${row.id}: ${draft.reason}`);
          }
          // The Salesforce call activity and the agreed next step, which carry
          // the recap body and therefore belong with the recap rather than with
          // the field write-back in transcript-sync. Own try: a Salesforce
          // outage costs the activity, not the draft that just succeeded.
          try {
            const { readSalesforceLink } = await import("./salesforce-link");
            const link = await readSalesforceLink(row.tenant_id, row.deal_id);
            if (link.status === "linked") {
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
            }
          } catch (sfErr) {
            console.error(
              `[recap-sync] salesforce activity threw for ${row.id}:`,
              sfErr instanceof Error ? sfErr.message : sfErr,
            );
          }
        } catch (draftErr) {
          console.error(
            `[recap-sync] draft threw for ${row.id}:`,
            draftErr instanceof Error ? draftErr.message : draftErr,
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
