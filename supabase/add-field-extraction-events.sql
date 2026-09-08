-- Gate transitions: WHEN a qualification field changed, and what changed it.
--
-- WHY THIS EXISTS.
--
-- field_extractions is keyed (deal_id, framework_field_key) and upserted, so
-- every answer is a tombstone over its own history. Dunavant's budget_fit was
-- created 2026-08-12 and updated 2026-09-02: we know it moved and we cannot
-- know what it said before, or which call moved it.
--
-- That makes the central question of the learning loop unanswerable no matter
-- how much data arrives. "Which questions actually led to a requisition" needs
-- to know that a gate flipped, on which call, and after which prescription.
-- The current schema can only say what is true now.
--
-- Deliberately ADDITIVE. field_extractions has more than ten readers that all
-- assume one row per (deal, field), so making that table append-only would
-- break every one of them. This table is written beside it and read by nothing
-- yet, which is the honest state to ship in.
--
-- mergeExtraction holds a Yes-is-immutable rule, so in practice gates move
-- Unknown/No -> Yes and do not revert. The valuable event is therefore the
-- FIRST flip and the call that produced it, which is precisely what
-- last_updated_from_call_id destroys: it is refreshed on every later call that
-- touches the field even when the payload is unchanged.

create table if not exists public.field_extraction_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  deal_id uuid not null references public.deals (id) on delete cascade,
  framework_field_key text not null,
  framework_id uuid references public.qualification_frameworks (id) on delete set null,

  -- The transition. from_status is null on the first observation of a field,
  -- which is different from a field going No -> Yes and needs to stay
  -- distinguishable: one is learning something, the other is a change of fact.
  from_status text,
  to_status text not null,
  from_answer text,
  to_answer text,

  -- What established it. evidence is the customer's own words at the moment of
  -- the flip, which the current row loses as soon as the next call touches it.
  evidence text,
  confidence numeric,

  -- WHICH CALL DID IT. The whole point.
  source_call_id uuid references public.calls (id) on delete set null,

  -- When DealRipe observed the change. Separate from the call date, because a
  -- transcript can be ingested days late and the trajectory should be readable
  -- either way.
  observed_at timestamptz not null default now(),
  -- The call's own date, denormalised so a trajectory query needs no join.
  occurred_at timestamptz,

  created_at timestamptz not null default now()
);

-- The trajectory read: one deal, in order.
create index if not exists field_extraction_events_deal_idx
  on public.field_extraction_events (deal_id, occurred_at);

-- The learning read: one gate across every deal, to ask what tends to move it.
create index if not exists field_extraction_events_field_idx
  on public.field_extraction_events (tenant_id, framework_field_key, occurred_at);

-- Attribution: every gate a single call moved.
create index if not exists field_extraction_events_call_idx
  on public.field_extraction_events (source_call_id);

-- Idempotency. transcript-sync can re-ingest a call, and a re-run must not
-- write the same flip twice. A given call may move a given field exactly once.
create unique index if not exists field_extraction_events_once
  on public.field_extraction_events (deal_id, framework_field_key, source_call_id)
  where source_call_id is not null;

alter table public.field_extraction_events enable row level security;

-- Same posture as the other tables here: service role writes, no anon access.
drop policy if exists field_extraction_events_service on public.field_extraction_events;
create policy field_extraction_events_service
  on public.field_extraction_events
  for all
  to service_role
  using (true)
  with check (true);
