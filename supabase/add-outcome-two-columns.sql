-- =====================================================================
-- Two outcome columns, because there are two instruments and merging them
-- destroys both.
--
-- THE PROBLEM THIS FIXES, measured 2026-08-18:
--
-- outcome_stage_moved is 'unknown' on 243 of 283 rows. That is not a bug.
-- readStageMoved reads signals.rolldog and nothing else, deliberately, and
-- its own docstring says a Salesforce-only deal "reports unknown,
-- permanently". Of 111 Magaya deals, 37 carry a Rolldog opportunity, 59
-- are Salesforce-only and 15 carry no link, so 74 of 111 can never report
-- movement no matter how long the pilot runs. Kiddom is Salesforce-only
-- throughout, which would make its outcome column 100% unknown on day one.
--
-- The instinct behind that refusal is correct and is preserved here.
-- Measuring our own extraction and calling it CRM movement would be
-- circular, and a deal that moved in a CRM we did not read is not a deal
-- that did not move. The error was concluding that only one column may
-- exist. There are two questions and they want two answers:
--
--   outcome_stage_moved           PROOF. The customer's CRM said so.
--                                 Lagging, coarse, unimpeachable. This is
--                                 what goes in front of a CRO, precisely
--                                 because it does not depend on anything
--                                 DealRipe reports about itself.
--
--   outcome_qualification_advanced  LEARNING. Our own evidence said so:
--                                 signals.stage and the answered-field set
--                                 across the call. High resolution, and
--                                 self-referential by construction, so it
--                                 trains the loop and is NEVER quoted as
--                                 proof.
--
-- Anything that reports these to a customer uses the first. Anything that
-- learns uses the second. A caller that wants "did this deal move" without
-- saying which kind of evidence it means has not finished thinking.
--
-- Apply by hand:
--   psql "$SUPABASE_DB_URL" -f supabase/add-outcome-two-columns.sql
--
-- Additive and idempotent. Safe to re-run. No policy changes:
-- prescribed_actions already has select/insert/update policies keyed on
-- tenant_id and new columns inherit them.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. The learning column.
--
-- Same three-state enum as every other outcome. 'unknown' is "we could not
-- look", never "nothing happened", and nothing defaults to false.
-- ---------------------------------------------------------------------

alter table public.prescribed_actions
  add column if not exists outcome_qualification_advanced
    public.prescription_tristate not null default 'unknown';

comment on column public.prescribed_actions.outcome_qualification_advanced is
  'Whether DealRipe''s OWN read of the deal advanced across this call: signals.stage moved, or the answered-field set grew, in deal_signal_snapshots. Self-referential by construction and therefore a learning signal only. Never quote it to a customer as evidence the deal moved; that is what outcome_stage_moved is for. ''unknown'' means no snapshot on one side of the call, not that nothing advanced.';

-- ---------------------------------------------------------------------
-- 2. Why each answer is what it is, persisted.
--
-- OutcomeRead has carried a reason string since it was written, and the
-- reason has only ever reached a console line. So the table can say a row
-- is unknown and cannot say why, and answering "why" means re-running the
-- read against a CRM whose state has since changed.
--
-- That is the same shape as the bug this whole file exists to fix: the
-- system did the work of distinguishing "no" from "did not check", and
-- then failed to record which one it found. jsonb rather than four text
-- columns because nothing queries inside it: it is for a human reading a
-- row and for a diagnostic printing WHY without reimplementing the rule.
-- ---------------------------------------------------------------------

alter table public.prescribed_actions
  add column if not exists outcome_reasons jsonb;

comment on column public.prescribed_actions.outcome_reasons is
  'The reason string behind each outcome value, keyed by column name: next_meeting, draft_sent, stage_moved, qualification_advanced. Written by the same read that sets the values. Exists so an ''unknown'' explains itself in the row rather than only in a log line that has since rotated.';

-- ---------------------------------------------------------------------
-- 3. outcome_stage_moved now reads both CRMs.
--
-- The old comment was accurate and is no longer true: the reader falls
-- back to the Salesforce opportunity stage when a deal has no Rolldog
-- opportunity. What has NOT changed is the refusal to substitute our own
-- extraction for a CRM read, or to report an unreadable CRM as 'no'.
-- ---------------------------------------------------------------------

comment on column public.prescribed_actions.outcome_stage_moved is
  'CRM stage movement across the call, as the CUSTOMER''S system recorded it. Read from deal_signal_snapshots.signals.rolldog, falling back to the Salesforce opportunity stage for a deal with no Rolldog opportunity. ''unknown'' means neither CRM could be read on one side of the call, which is never the same as the stage not moving. This is the proof column: it is deliberately independent of DealRipe''s own extraction, so it can be shown to a customer. For the high-resolution view, see outcome_qualification_advanced.';

commit;
