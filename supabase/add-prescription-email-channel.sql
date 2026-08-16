-- =====================================================================
-- The email channel for end commitments.
--
-- Apply AFTER supabase/add-prescription-ledger.sql:
--   psql "$SUPABASE_DB_URL" -f supabase/add-prescription-email-channel.sql
--
-- WHY. The first run of the scorer found 21 end commitments and exactly
-- ONE secured out loud on the call. Of the other twenty, seven were
-- followed by mail from the rep to the customer. Reps settle next steps
-- in writing, and scoring the commitment from the transcript alone
-- recorded every one of them as a rep who did nothing.
--
-- That is this codebase's own failure mode arriving from the inside: we
-- checked one channel and reported the other as absent. The fix is to
-- check the channel, and to record whether we checked it.
--
-- A question is different and stays transcript-only. The briefing tells
-- the rep to ask it ON THE CALL, so the call is where it did or did not
-- happen. Only a commitment can legitimately land afterwards.
--
-- Idempotent. Safe to re-run.
-- =====================================================================

begin;

alter table public.prescribed_actions
  -- When the rep's post-call mail was searched for this commitment.
  --
  -- Null means the email channel has NOT been checked, which is what
  -- makes a 'no' on an end commitment readable: without this column,
  -- "not secured on the call" and "not secured anywhere we looked" are
  -- the same value, and the second is the only one worth learning from.
  --
  -- Also the once-only marker: the scorer runs the email pass for a row
  -- whose value is null, so a mailbox that could not be read stays null
  -- and is retried, while a mailbox that was read and held nothing is
  -- stamped and never costs another model call.
  add column if not exists email_checked_at timestamptz;

comment on column public.prescribed_actions.email_checked_at is
  'When the rep''s post-call mail to the customer was searched for this prescription. Null means the email channel was not checked, so a followed=''no'' on an end_commitment means only "not on the call". Set once the mailbox has actually been read.';

comment on column public.prescribed_actions.followed_evidence is
  'The quote that proves the rep did it. Prefixed with the channel when it did not come from the transcript, for example "[email] ...". A transcript quote carries no prefix.';

-- The email pass's work queue: end commitments the call did not settle
-- and whose mail we have not searched.
create index if not exists prescribed_actions_email_pending_idx
  on public.prescribed_actions (tenant_id, call_id)
  where email_checked_at is null and kind = 'end_commitment';

commit;
