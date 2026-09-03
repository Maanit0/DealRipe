-- Mark a piece of rep feedback as having been looked at.
--
-- The loop in lib/feedback-watch.ts reads votes nobody has diagnosed yet, works
-- out what the rep was actually reacting to, and reports. Without a marker it
-- would re-diagnose the same three votes every five minutes and mail the same
-- verdict forever.
--
-- reviewed_at is set whatever the outcome, including "no signal here". A vote
-- we looked at and could not learn from is a DIFFERENT state from one we never
-- read, and collapsing them is how this codebase's recurring bug works.
--
-- Safe to re-run.

alter table public.sent_messages
  add column if not exists feedback_reviewed_at timestamptz;

alter table public.sent_messages
  add column if not exists feedback_verdict text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sent_messages_feedback_verdict_chk'
  ) then
    alter table public.sent_messages
      add constraint sent_messages_feedback_verdict_chk
      check (feedback_verdict is null or feedback_verdict in (
        -- A specific, fixable defect in what we generated.
        'actionable',
        -- Real, but it needs a person to decide. Product judgement, pricing,
        -- a rep disagreeing with how we frame something.
        'needs_you',
        -- The rep was reacting to something other than the writing: a
        -- duplicate, a no-show, a call we never captured.
        'not_the_artifact',
        -- Looked at, nothing learnable. Usually a bare thumbs up.
        'no_signal'
      ));
  end if;
end $$;

create index if not exists sent_messages_feedback_unreviewed_idx
  on public.sent_messages (tenant_id, feedback_at)
  where feedback is not null and feedback_reviewed_at is null;

comment on column public.sent_messages.feedback_reviewed_at is
  'When lib/feedback-watch.ts diagnosed this vote. Null means never looked at, which is not the same as nothing to learn: that is feedback_verdict = no_signal.';
