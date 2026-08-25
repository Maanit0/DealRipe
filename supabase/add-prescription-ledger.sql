-- =====================================================================
-- The prescription ledger.
--
-- DealRipe tells a rep what to do before a call. This is the record of
-- what it told them, whether they did it, and what happened next. It is
-- the substrate for the learning loop: won/lost gives one row per deal
-- per quarter, prescriptions give several rows per call.
--
-- This EXTENDS prescribed_actions rather than adding a table next to it.
-- That table already existed, already carried this meaning, and was dead:
-- lib/closed-loop.ts wrote it and nothing called the writer, while
-- lib/briefing-history.ts has been reading it since it was written, so
-- the "still not answered" block in every briefing has never once fired,
-- and lib/outcome-sync.ts has been backfilling outcome_label onto rows
-- that do not exist. Two tables meaning the same thing is how the next
-- session writes to the wrong one.
--
-- Apply by hand:
--   psql "$SUPABASE_DB_URL" -f supabase/add-prescription-ledger.sql
--o
-- Idempotent. Safe to re-run.
--
-- RLS: no policy changes needed. prescribed_actions already has select /
-- insert / update policies keyed on tenant_id (supabase/rls.sql:391) and
-- new columns inherit them.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Three-state enums.
--
-- 'unknown' is not a convenience value and nothing defaults to false. A
-- call with no transcript means we did not check, which is a different
-- fact from the rep not asking. Folding those together is the failure
-- this codebase exists to avoid, so the type system refuses to let a
-- caller write one when it means the other.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'prescription_tristate') then
    create type public.prescription_tristate as enum ('yes', 'no', 'unknown');
  end if;
  if not exists (select 1 from pg_type where typname = 'prescription_kind') then
    create type public.prescription_kind as enum
      ('question', 'end_commitment', 'next_step', 'avoid');
  end if;
  if not exists (select 1 from pg_type where typname = 'prescription_source') then
    create type public.prescription_source as enum ('briefing', 'recap');
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 2. New columns.
-- ---------------------------------------------------------------------

alter table public.prescribed_actions
  -- The call this was issued FOR. Uuid, not the Graph event id the old
  -- call_external_id held: everything downstream joins calls.id, and a
  -- prescription with no call has nothing to score against, so this is
  -- not null and a caller that cannot resolve a call fails loudly rather
  -- than writing an orphan.
  add column if not exists call_id uuid references public.calls(id) on delete cascade,

  -- When the rep was told. Distinct from created_at, which is when the
  -- row was written: a backfilled row is created today and was issued
  -- three weeks ago, and the learning loop cares about the second.
  add column if not exists issued_at timestamptz not null default now(),

  add column if not exists kind   public.prescription_kind,
  add column if not exists source public.prescription_source,

  -- Did the rep do it. Never a boolean.
  add column if not exists followed public.prescription_tristate not null default 'unknown',
  -- The transcript quote that proves it. No quote means no.
  add column if not exists followed_evidence text,
  -- Null while the row is unscored, which is how the scorer finds its
  -- work and how a no-transcript call stays retryable.
  add column if not exists scored_at timestamptz,

  add column if not exists outcome_next_meeting public.prescription_tristate not null default 'unknown',
  add column if not exists outcome_draft_sent   public.prescription_tristate not null default 'unknown',
  add column if not exists outcome_stage_moved  public.prescription_tristate not null default 'unknown',

  -- The framework fields this prescription was aimed at, from the
  -- briefing's own targetFields. Worth more than a join: with it the
  -- question stops being "did the rep ask" and becomes "did asking
  -- produce the answer". A question asked with its target field still
  -- empty after the call is a different and more useful row than a
  -- question skipped.
  --
  -- Null, not empty, on rows recovered by parsing a sent email: the
  -- rendered briefing carries targetLabel and never targetFields, so the
  -- keys are genuinely unrecoverable there rather than absent.
  add column if not exists framework_field_keys text[];

-- outcome_draft_sent is named for what we can actually observe.
comment on column public.prescribed_actions.outcome_draft_sent is
  'Whether the rep emailed the customer after this call, which is not the same as whether they sent OUR draft. We hold Mail.ReadWrite and deliberately not Mail.Send, and we do not persist the Graph draft message id, so the two cannot be joined yet. Persisting that id belongs with the follow-up recipients change.';

comment on column public.prescribed_actions.outcome_stage_moved is
  'Rolldog stage movement across the call, read from deal_signal_snapshots.signals.rolldog. ''unknown'' whenever either side of the comparison has no rolldog block, which includes every Salesforce-only deal: we do not read a Salesforce stage on this path and must not report its absence as ''no''.';

-- ---------------------------------------------------------------------
-- 3. Reshape the columns that already existed.
--
-- prescription -> text and framework_field_key -> framework_field_keys.
-- The old singular key was NOT NULL, which cannot hold an end commitment
-- (it targets no field), so keeping it would have forced a sentinel.
-- ---------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'prescribed_actions'
      and column_name = 'prescription'
  ) then
    alter table public.prescribed_actions rename column prescription to text;
  end if;
end
$$;

-- Carry any singular key across before dropping it. The table is empty in
-- production; this exists so the migration is honest on any environment
-- where it is not.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'prescribed_actions'
      and column_name = 'framework_field_key'
  ) then
    update public.prescribed_actions
       set framework_field_keys = array[framework_field_key]
     where framework_field_keys is null
       and framework_field_key is not null;
    alter table public.prescribed_actions drop column framework_field_key;
  end if;
end
$$;

-- call_external_id held the Graph event id and was never written. call_id
-- replaces it. Dropping rather than keeping both, for the same reason
-- this migration extends a table instead of adding one.
drop index if exists public.prescribed_actions_call_idx;
alter table public.prescribed_actions drop column if exists call_external_id;

-- Existing rows (none in production) need a call before call_id can be
-- required, so the constraint is only applied when it can be satisfied.
do $$
begin
  if not exists (select 1 from public.prescribed_actions where call_id is null) then
    alter table public.prescribed_actions alter column call_id set not null;
    alter table public.prescribed_actions alter column kind   set not null;
    alter table public.prescribed_actions alter column source set not null;
  else
    raise warning 'prescribed_actions has rows with a null call_id; leaving call_id/kind/source nullable. Backfill them and re-run.';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 4. asked_on_next_call is superseded by followed, and is NOT dropped
--    today.
--
-- followed carries the same meaning with the third state it always
-- needed, so this column is dead. It stays only because
-- lib/briefing-history.ts still selects it, and repointing that reader
-- changes what six reps receive in the morning: it starts firing the
-- moment followed='no' rows exist, which the backfill creates. Turn that
-- on deliberately, then run the line below in the same change.
--
--   alter table public.prescribed_actions drop column asked_on_next_call;
--
-- Nothing writes it as of this migration.
-- ---------------------------------------------------------------------

comment on column public.prescribed_actions.asked_on_next_call is
  'DEPRECATED, superseded by followed. Nothing writes it. Read only by lib/briefing-history.ts; drop it when that reader is repointed at followed.';

-- ---------------------------------------------------------------------
-- 5. Indexes.
--
-- text_hash exists so the natural key fits a btree entry regardless of
-- how long a prescription runs.
-- ---------------------------------------------------------------------

alter table public.prescribed_actions
  add column if not exists text_hash text generated always as (md5(text)) stored;

-- Never overwrite an existing row for a call. A regenerated briefing
-- supersedes rather than mutates, so this key deliberately does NOT
-- include issued_at: re-issuing the same instruction for the same call is
-- the same instruction, and re-running the backfill must not double it.
-- A genuinely different instruction is a new row.
create unique index if not exists prescribed_actions_call_kind_text_key
  on public.prescribed_actions (call_id, kind, text_hash);

-- The scorer's work queue: unscored rows whose call may now have a
-- transcript.
create index if not exists prescribed_actions_unscored_idx
  on public.prescribed_actions (tenant_id, call_id)
  where scored_at is null;

create index if not exists prescribed_actions_issued_idx
  on public.prescribed_actions (tenant_id, issued_at desc);

-- ---------------------------------------------------------------------
-- 6. Tenant alignment on the new FK, matching every other table that
--    points at calls.
-- ---------------------------------------------------------------------

drop trigger if exists prescribed_actions_enforce_call_tenant on public.prescribed_actions;
create trigger prescribed_actions_enforce_call_tenant
  before insert or update on public.prescribed_actions
  for each row
  execute function public.enforce_tenant_alignment('calls', 'call_id');

commit;
