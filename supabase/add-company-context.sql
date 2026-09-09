-- The company's own context, kept as a series rather than a current reading.
--
-- WHY, 2026-09-09.
--
-- lib/company-context.ts computes what DealRipe knows about how a COMPANY
-- sells: what we can see per channel and from when, the shape of the book, the
-- motion between call types, how each gate is actually answered, what documents
-- move, what we told reps and whether they did it. Facts only, no verdicts.
--
-- Computing it is not enough. The interesting questions are about CHANGE:
-- is the capture rate improving, is the discovery-to-demo step getting faster,
-- is a gate that never moved starting to move. A context object regenerated on
-- demand answers none of those, and this codebase has already paid twice for
-- keeping only the current reading: field_extractions is a tombstone over its
-- own history, and deal_signal_snapshots destroys five of six daily readings
-- through unique (deal_id, snapshot_date) plus an upsert.
--
-- SO THIS IS APPEND ONLY AND HAS NO UNIQUE KEY ON THE DATE. Every run is a row.
-- Two runs in one day are two rows, and that is correct: the second one is not
-- a correction of the first, it is a later observation. A reader that wants
-- "today's" takes the most recent; nothing is ever overwritten.
--
-- THE PAYLOAD IS THE WHOLE OBJECT, as jsonb. Deliberately not normalised into
-- columns: the shape of a company's context will change as more is captured,
-- and a schema migration per new section is how a memory bank stops being
-- maintained. The typed shape lives in lib/company-context.ts, which is where a
-- reader should look.
--
-- NDA. The payload holds counts, spans and distributions only. No transcript
-- text, no email bodies, no contact names. That is what makes this the one
-- derived object safe to hand to a model as context without moving call
-- content around, and it must stay true: anything added to CompanyContext that
-- carries customer prose breaks that property silently.
--
-- Apply by hand:
--   psql "$SUPABASE_DB_URL" -f supabase/add-company-context.sql
--
-- Additive and idempotent. Safe to re-run.

begin;

create table if not exists public.company_context_snapshots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,

  generated_at timestamptz not null default now(),
  -- Denormalised so a trajectory query needs no date arithmetic on the payload.
  generated_on date not null default (now() at time zone 'utc')::date,

  payload jsonb not null,

  -- Cheap top-line numbers, lifted out so "has capture improved" is a query
  -- rather than a jsonb walk. Everything else stays in the payload.
  deals integer,
  captured_conversations integer,
  uncaptured_meetings integer,
  deals_observed integer
);

comment on table public.company_context_snapshots is
  'One row per computation of lib/company-context.ts. APPEND ONLY, no unique key on the date: two runs in one day are two observations, not a correction. Nothing here is ever overwritten.';

comment on column public.company_context_snapshots.payload is
  'The whole CompanyContext object. Counts, spans and distributions only, never customer prose: that property is what makes this safe to hand to a model as context, and anything added to the type that carries transcript or email text breaks it silently.';

comment on column public.company_context_snapshots.uncaptured_meetings is
  'Meeting rows with no conversation over 2000 characters. NOT a failure count: a lobby timeout cannot distinguish "the meeting ran without us" from "it never happened", and a refused bot in our own meeting is a rep keeping a conversation private.';

create index if not exists company_context_snapshots_tenant_idx
  on public.company_context_snapshots (tenant_id, generated_at desc);

alter table public.company_context_snapshots enable row level security;

drop policy if exists company_context_snapshots_service on public.company_context_snapshots;
create policy company_context_snapshots_service
  on public.company_context_snapshots
  for all
  to service_role
  using (true)
  with check (true);

commit;
