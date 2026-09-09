-- The CRM's own history, persisted instead of re-queried and thrown away.
--
-- WHY THIS EXISTS, 2026-09-08.
--
-- Salesforce already holds the trajectory this product is trying to build.
-- Measured 2026-08-20 and unchanged: OpportunityFieldHistory has 147,777
-- readable rows, 15,459 StageName transitions oldest 2025-02-19, 21,320 Amount,
-- 15,206 CloseDate, 13,112 ForecastCategoryName. Field history tracking was
-- already on and readable with the access we hold.
--
-- Three modules read it LIVE and none of them keeps a row:
-- lib/forecast-why.ts, lib/forecast-calibration.ts, lib/salesforce-stage-history.ts.
-- So every question about what the deal did is a fresh API call, and:
--
--   1. Salesforce field history AGES OUT. Retention is finite and org
--      configurable. The pre-pilot baseline that makes 26 closed deals
--      interpretable is the first thing to disappear, and when it does there is
--      no getting it back from anywhere.
--   2. It cannot be JOINED. The whole point of the action-outcome dataset is
--      "what did DealRipe tell the rep, did they do it, what did the buyer do
--      next, how did it end". The fourth term lives in Salesforce and the first
--      three live here, and a cross-system join at query time is why nothing
--      has ever actually asked the question.
--   3. A whole-run failure is invisible. loadCloseDateHistoryForAccounts is one
--      call covering every account, correctly fail-closed, so a transient
--      failure removes the dimension for EVERYONE at once. Two runs minutes
--      apart produced 11 deals flagged as repeatedly pushed and then 0.
--
-- THIS IS A CACHE OF SOMEONE ELSE'S LEDGER, and that shapes the schema. The
-- rows are immutable facts Salesforce already decided, so the unique key is
-- (opportunity_id, field, changed_at) and re-running the backfill is a no-op
-- rather than a duplicate. source_system is carried because Rolldog will
-- eventually have an equivalent and a table called crm_field_events that only
-- ever means Salesforce is a trap for whoever adds the second one.
--
-- WHAT IS DELIBERATELY NOT INFERRED. changed_by is stored as the Salesforce
-- user name Salesforce reports, not mapped to a DealRipe rep. detectLossBatches
-- in lib/forecast-why.ts already groups closes per actor inside a 15-minute
-- window to find a hygiene sweep (the 2026-08-07 Mitch Nemmers event, four
-- deals in 90 seconds), and that works off the raw name. Mapping to reps here
-- would invent an identity join that nothing has verified.
--
-- Apply by hand:
--   psql "$SUPABASE_DB_URL" -f supabase/add-crm-field-events.sql
--
-- Additive and idempotent. Safe to re-run.

begin;

create table if not exists public.crm_field_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Null when the opportunity is not linked to a DealRipe deal. Still stored.
  deal_id uuid references public.deals (id) on delete set null,

  source_system text not null default 'salesforce',
  opportunity_id text not null,
  account_id text,

  field text not null,
  old_value text,
  new_value text,
  -- Only for CloseDate. Positive when the date moved later.
  days_moved integer,

  changed_by text,
  changed_at timestamptz not null,
  observed_at timestamptz not null default now()
);

comment on table public.crm_field_events is
  'A local copy of the CRM''s own field history. Immutable facts the CRM already decided, cached here because Salesforce retention is finite and because the action-outcome dataset cannot be joined across two systems at query time.';

comment on column public.crm_field_events.deal_id is
  'NULL means this opportunity is not linked to a DealRipe deal. The row is still stored: Magaya''s history predates the pilot and the pre-pilot baseline is what makes the pilot''s 26 closes interpretable. Never read NULL as "this did not happen on a deal".';

comment on column public.crm_field_events.source_system is
  'salesforce today. Rolldog has an equivalent and a table that silently means one CRM is a trap for whoever adds the second.';

comment on column public.crm_field_events.old_value is
  'NULL is genuinely ambiguous here and Salesforce is the reason: it records no previous value on create, and it also stores a real null when a field was cleared. Both arrive as null and CANNOT be told apart. Do not read it as "the field was empty before".';

comment on column public.crm_field_events.days_moved is
  'CloseDate only. NULL on every other field, and also NULL when either date failed to parse. Positive = pushed out, negative = pulled in.';

comment on column public.crm_field_events.changed_by is
  'The Salesforce user name as Salesforce reports it, deliberately NOT mapped to a DealRipe rep. detectLossBatches groups closes per actor in a 15-minute window to tell a hygiene sweep from real losses, and it works off this raw name.';

comment on column public.crm_field_events.changed_at is
  'Salesforce''s CreatedDate for the change: when it happened. observed_at is when we copied it. A backfill run months later still sorts correctly.';

-- The per-deal trajectory read.
create index if not exists crm_field_events_deal_idx
  on public.crm_field_events (deal_id, changed_at);

-- The per-opportunity read, which works for unlinked history too.
create index if not exists crm_field_events_opp_idx
  on public.crm_field_events (opportunity_id, field, changed_at);

-- "Who moved the number", and the sweep detector.
create index if not exists crm_field_events_actor_idx
  on public.crm_field_events (tenant_id, changed_by, changed_at);

-- IDEMPOTENCY. These are facts Salesforce already recorded, so the same change
-- read twice is the same row. A re-run of the backfill must be a no-op.
create unique index if not exists crm_field_events_once
  on public.crm_field_events (source_system, opportunity_id, field, changed_at);

alter table public.crm_field_events enable row level security;

drop policy if exists crm_field_events_service on public.crm_field_events;
create policy crm_field_events_service
  on public.crm_field_events
  for all
  to service_role
  using (true)
  with check (true);

commit;
