-- =====================================================================
-- Capture diagnostics.
--
-- Why a call was not captured, stored at the moment we decide it, from
-- what Recall actually said.
--
-- The bug this closes: lib/transcript-sync.ts wrote the string "bot done
-- but media unavailable" and nothing else. That is a conclusion, and it
-- was the wrong one. Every one of the fourteen calls carrying it had its
-- real cause sitting in the bot's status_changes array, already fetched,
-- already parsed onto BotResource.raw, and thrown away one line before it
-- was needed: lib/recall.ts read the sub_code off the LAST status entry,
-- which on a bot that died in a waiting room is "done" and carries no
-- sub_code, while the entry immediately before it carries
-- timeout_exceeded_waiting_room.
--
-- Thirteen of the fourteen were bots that were never admitted to the
-- meeting. None of them lost media, because none of them ever recorded
-- any. The distinction matters beyond tidiness: capture rate is reported
-- to the customer's CRO, and an admission problem and a recording problem
-- have nothing in common except that both end with no transcript.
--
-- Apply by hand:
--   psql "$SUPABASE_DB_URL" -f supabase/add-capture-diagnostics.sql
--
-- Idempotent. Safe to re-run.
--
-- RLS: no policy changes needed. New columns on public.calls inherit the
-- table's existing tenant-keyed policies.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. What we saw, and whether we saw anything at all.
--
-- capture_evidence is the whole point of this migration. It is the
-- difference between "Recall told us the bot was kicked out of the
-- waiting room" and "we never asked" and "we asked and Recall no longer
-- has the record". Those three produce identical downstream symptoms and
-- opposite remedies, and folding them together is the failure this
-- codebase exists to avoid.
--
-- Deliberately NOT NULL with a 'not_checked' default. Every existing row
-- gets the honest answer rather than a null that a reader will quietly
-- treat as "fine".
-- ---------------------------------------------------------------------

alter table public.calls
  add column if not exists capture_evidence text not null default 'not_checked';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'calls_capture_evidence_chk'
  ) then
    alter table public.calls
      add constraint calls_capture_evidence_chk
      check (capture_evidence in ('observed', 'unavailable', 'not_checked'));
  end if;
end
$$;

comment on column public.calls.capture_evidence is
  'Whether Recall''s account of this bot was read. observed = we have its status history. unavailable = we asked and could not get it (404 after retention, or an API error), so the cause is now permanently unknown for this call. not_checked = we never asked. Never infer a cause from ''unavailable'' or ''not_checked''.';

-- The observations themselves, verbatim. Stored because a conclusion
-- computed today from a Recall API that will eventually forget cannot be
-- re-checked tomorrow, and because the classifier will change while the
-- evidence will not.
alter table public.calls
  add column if not exists capture_status_changes jsonb;

comment on column public.calls.capture_status_changes is
  'Recall''s status_changes array as returned, one entry per lifecycle transition with its code, sub_code, message and timestamp. The observations that produced capture_class. Null means capture_evidence is not ''observed''.';

alter table public.calls
  add column if not exists capture_checked_at timestamptz;

comment on column public.calls.capture_checked_at is
  'When capture_evidence was last established. A row checked before Recall expired the bot keeps its evidence; re-checking later would only downgrade it to unavailable, so the backfill never overwrites observed with unavailable.';

-- ---------------------------------------------------------------------
-- 2. Recall's own word for the cause.
--
-- Free text on purpose. This is Recall's vocabulary, not ours, and they
-- add to it: timeout_exceeded_waiting_room,
-- call_ended_by_platform_waiting_room_timeout, bot_kicked_from_waiting_room
-- and meeting_not_accessible are the four seen in the Magaya pilot, and a
-- check constraint would turn the arrival of a fifth into an outage.
--
-- Null means Recall did not give one. It does not mean there was no cause.
-- ---------------------------------------------------------------------

alter table public.calls
  add column if not exists capture_sub_code text;

comment on column public.calls.capture_sub_code is
  'Recall''s sub_code for the terminal transition, verbatim. Read from the entry that carries one, NOT from the last entry: a bot that dies in a waiting room ends on a bare "done" and the cause is on the "call_ended" before it. Null means Recall gave no sub_code, which is different from there being no cause.';

-- ---------------------------------------------------------------------
-- 3. Our classification of it.
--
-- Text plus a check rather than an enum, so adding a category later is
-- one migration rather than an ALTER TYPE coordinated across sessions.
--
-- lobby_timeout is its own category and is deliberately NOT a failure.
-- A bot that sat in a waiting room and was never admitted looks identical
-- whether the meeting ran without it or never happened at all. Recall
-- cannot see through a lobby door and neither can we. Counting those as
-- failures overstates the loss; counting them as no-shows understates it.
-- They are counted as themselves.
-- ---------------------------------------------------------------------

alter table public.calls
  add column if not exists capture_class text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'calls_capture_class_chk'
  ) then
    alter table public.calls
      add constraint calls_capture_class_chk
      check (capture_class is null or capture_class in (
        'captured',
        'no_show',
        'lobby_timeout',
        'lobby_refused',
        'never_joined',
        'media_lost',
        'unknown'
      ));
  end if;
end
$$;

comment on column public.calls.capture_class is
  'Why capture did or did not yield a conversation. See lib/capture-classify.ts, which is the single source of this decision; anything that needs it imports classifyCapture rather than restating the rules. lobby_timeout is undecidable between a refused bot and a meeting that never happened and is never folded into either. unknown always carries a reason in capture_detail.';

alter table public.calls
  add column if not exists capture_detail text;

comment on column public.calls.capture_detail is
  'One human-readable line for capture_class, including the reason whenever the class is unknown. An unknown with no reason is a bug.';

create index if not exists calls_capture_class_idx
  on public.calls (tenant_id, capture_class)
  where capture_class is not null;

-- ---------------------------------------------------------------------
-- 4. Ingest retry accounting, out of the ingest_error string.
--
-- Retries were counted by regexing "[retry N/3]" out of ingest_error, a
-- free-text column that the follow-up draft path also rewrites. Two
-- writers sharing one string is why a deliberate draft hold consumed an
-- extraction retry.
--
-- Two budgets, because two things are being counted and only one of them
-- is the call's fault:
--
--   content  the transcript itself could not be extracted. Three attempts
--            and then a human looks. Unchanged.
--   infra    a provider outage, an expired key, a rate limit, a billing
--            stop. Nothing about the call caused it and nothing about the
--            call will fix it. These back off instead of spending the
--            content budget, which is what abandoned a day of calls in
--            fifteen minutes during the 2026-08-16 Anthropic credit stop.
--
-- ingest_retry_after is the backoff. Null means eligible now.
-- ---------------------------------------------------------------------

alter table public.calls
  add column if not exists ingest_failure_class text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'calls_ingest_failure_class_chk'
  ) then
    alter table public.calls
      add constraint calls_ingest_failure_class_chk
      check (ingest_failure_class is null or ingest_failure_class in (
        'provider', 'auth', 'rate_limit', 'billing', 'content', 'unknown'
      ));
  end if;
end
$$;

comment on column public.calls.ingest_failure_class is
  'Why the last extraction attempt failed. Only ''content'' spends the content retry budget. See classifyIngestFailure in lib/ingest-failure-class.ts. ''unknown'' is never silently treated as content: it spends the infra budget and is reported as unknown.';

alter table public.calls
  add column if not exists ingest_content_attempts integer not null default 0,
  add column if not exists ingest_infra_attempts   integer not null default 0,
  add column if not exists ingest_retry_after      timestamptz;

comment on column public.calls.ingest_content_attempts is
  'Extraction attempts that failed on the transcript itself. Capped at MAX_CONTENT_ATTEMPTS in lib/transcript-sync.ts, after which a human looks.';
comment on column public.calls.ingest_infra_attempts is
  'Extraction attempts that failed for a reason outside this call: provider, auth, rate limit, billing, or an unclassified error. Backed off rather than counted against the content budget, and capped separately so a permanently broken key does not retry forever.';
comment on column public.calls.ingest_retry_after is
  'Earliest time the next extraction attempt may run. Null means eligible now. Set by the backoff on infra failures.';

create index if not exists calls_ingest_retry_idx
  on public.calls (tenant_id, ingest_retry_after)
  where ingest_error is not null;

-- ---------------------------------------------------------------------
-- 5. Follow-up draft state, also out of the ingest_error string.
--
-- "rep already emailed the customer after this call, so no draft was
-- written" is the product working. It was being written into ingest_error,
-- which made three healthy calls look broken in every view that reads
-- that column, and incremented a retry counter that lives in the same
-- string.
--
-- held is not failed. unavailable is neither: "could not read the mailbox
-- to check whether the rep already followed up" is a did-not-check, and
-- treating it as "the rep did not follow up" would write a duplicate
-- draft on top of the rep's own email.
-- ---------------------------------------------------------------------

alter table public.calls
  add column if not exists followup_draft_state text not null default 'not_attempted';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'calls_followup_draft_state_chk'
  ) then
    alter table public.calls
      add constraint calls_followup_draft_state_chk
      check (followup_draft_state in (
        'not_attempted', 'drafted', 'held', 'failed', 'unavailable'
      ));
  end if;
end
$$;

comment on column public.calls.followup_draft_state is
  'drafted = a draft is in the rep''s Outlook. held = we deliberately did not write one and that is correct (the rep already emailed, a draft already exists, the meeting was not an opportunity call, nobody external was on it). failed = we tried and could not. unavailable = we could not establish whether a draft was warranted, typically a Graph read failure, which is not the same as deciding against one. not_attempted = we have not reached that step.';

alter table public.calls
  add column if not exists followup_draft_reason text,
  add column if not exists followup_draft_attempts integer not null default 0;

comment on column public.calls.followup_draft_attempts is
  'Failed draft attempts only. A hold does not increment it, which is the defect this replaces: a rep who followed up on their own burned two of three attempts on three calls.';

create index if not exists calls_followup_draft_retry_idx
  on public.calls (tenant_id, followup_draft_state)
  where followup_draft_state in ('failed', 'unavailable');

-- ---------------------------------------------------------------------
-- 6. Carry the existing markers across, then stop writing them.
--
-- The [retry N/3] and [draft N/3] prefixes are parsed out of ingest_error
-- into the new columns so no call silently regains a budget it already
-- spent, and the prefixes are stripped so ingest_error goes back to being
-- one readable sentence.
--
-- Draft holds are recognised by their text and land on 'held' with a zero
-- attempt count, which is the whole point: those three calls are healthy
-- and have been reported as broken since 2026-08-14.
-- ---------------------------------------------------------------------

update public.calls
   set ingest_content_attempts = coalesce(
         nullif(substring(ingest_error from '\[retry (\d+)/\d+\]'), '')::integer,
         case when ingest_error like '%gave up%' then 3 else 0 end)
 where ingest_error is not null
   and ingest_content_attempts = 0
   and (ingest_error ~ '\[retry \d+/\d+\]' or ingest_error like '%gave up%');

update public.calls
   set followup_draft_state   = 'held',
       followup_draft_reason  = regexp_replace(
         substring(ingest_error from '\[draft\](.*)$'), '^\s+', ''),
       followup_draft_attempts = 0
 where ingest_error like '%[draft]%'
   and (ingest_error like '%already emailed%'
     or ingest_error like '%already drafted%'
     or ingest_error like '%is not an opportunity call%'
     or ingest_error like '%no customer-side attendee%'
     or ingest_error like '%not on GRAPH_MAIL_ALLOWED_MAILBOXES%'
     or ingest_error like '%no rep email on the deal%');

update public.calls
   set followup_draft_state    = 'failed',
       followup_draft_reason   = regexp_replace(
         substring(ingest_error from '\[draft\](.*)$'), '^\s+', ''),
       followup_draft_attempts = coalesce(
         nullif(substring(ingest_error from '\[draft (\d+)/\d+\]'), '')::integer, 1)
 where ingest_error like '%[draft]%'
   and followup_draft_state = 'not_attempted';

-- Strip both markers. Anything left that is only whitespace becomes null.
update public.calls
   set ingest_error = nullif(
         btrim(regexp_replace(
           regexp_replace(ingest_error, '\[draft \d+/\d+\][^\n]*\n?', '', 'g'),
           '\[(?:retry \d+/\d+|gave up[^\]]*)\]\s*', '', 'g')),
         '')
 where ingest_error is not null
   and (ingest_error ~ '\[draft \d+/\d+\]'
     or ingest_error ~ '\[retry \d+/\d+\]'
     or ingest_error like '%gave up%');

commit;
