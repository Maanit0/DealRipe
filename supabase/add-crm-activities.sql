-- What the reps did that DealRipe never saw.
--
-- WHY, 2026-09-08.
--
-- DealRipe watches two channels: meetings a bot joined, and mail in the six
-- reps' Outlook mailboxes. Everything else a rep does is invisible, and the
-- reps log a lot of it by hand:
--
--   Salesforce Task     a logged call, an email sent from another client, a
--                       BDR's outreach. Carries Subject AND Description.
--   Salesforce Event    a meeting the rep booked in Salesforce rather than
--                       Outlook, so no bot was ever dispatched to it.
--   Rolldog activity    the interactions tab, carrying a title and free-text
--                       notes the rep wrote themselves.
--
-- All three are already READ by this codebase and none is kept. Salesforce Task
-- is queried in several places, but only ever `SELECT Id` for write dedupe;
-- Rolldog listActivities returns title and notes in full and its callers use
-- them once. Same shape as OpportunityFieldHistory was this morning: the read
-- path exists, the result is discarded, and the question "what did the rep
-- actually do" stays unanswerable.
--
-- WHY IT MATTERS MORE THAN IT LOOKS. Eduardo's account-matching ladder already
-- rests on this: "there is always an activity on the account when a BDR books a
-- discovery call." That is a fact about Magaya's process which DealRipe uses at
-- match time and then forgets. It is also the only record of rep effort on the
-- 36 deals holding no email at all, 22 of which are free-mail-only customers
-- that the mail ingest deliberately skips.
--
-- ONE TABLE, THREE SOURCES, because they answer one question. source_system and
-- source_object keep them separable; a table that silently means Salesforce is
-- a trap for whoever adds the second one.
--
-- DEALRIPE'S OWN WRITES ARE MARKED, NOT EXCLUDED. logCallToSalesforce writes a
-- Task and createActivity writes a Rolldog activity, so a naive ingest would
-- read our own output back as the rep's work. That is exactly how deal_messages
-- came to hold 31 of our own drafts as rep outbound. is_ours is computed at
-- ingest and every consumer must filter on it.
--
-- Apply by hand:
--   psql "$SUPABASE_DB_URL" -f supabase/add-crm-activities.sql
--
-- Additive and idempotent. Safe to re-run.

begin;

create table if not exists public.crm_activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  -- Null when the record is on an account or opportunity we hold no deal for.
  -- The row is still stored: it is the pre-pilot and out-of-scope baseline.
  deal_id uuid references public.deals (id) on delete set null,

  source_system text not null,
  source_object text not null,
  external_id text not null,

  account_id text,
  opportunity_id text,

  subject text,
  body text,
  activity_type text,
  status text,

  actor text,
  occurred_at timestamptz,
  created_at_source timestamptz,
  observed_at timestamptz not null default now(),

  is_ours boolean not null default false
);

comment on table public.crm_activities is
  'Rep-logged activity from the CRMs: Salesforce Task and Event, Rolldog activities. The record of what a rep did OUTSIDE the two channels DealRipe watches.';

comment on column public.crm_activities.deal_id is
  'NULL means the record sits on an account or opportunity with no DealRipe deal. The row is kept: that is the baseline. Never read NULL as "this did not happen".';

comment on column public.crm_activities.source_object is
  'Task, Event or activity. Kept separate because a Task is something that happened and an Event is a meeting, and averaging them would count a booked meeting as completed outreach.';

comment on column public.crm_activities.body is
  'Task.Description, Event.Description or the Rolldog notes field. Free text the rep wrote. NULL means the source carried none, not that the activity was empty.';

comment on column public.crm_activities.occurred_at is
  'When the activity happened: ActivityDate for Task, StartDateTime for Event. NULL where the source records only a creation time, and created_at_source is then the only date available.';

comment on column public.crm_activities.actor is
  'Owner.Name as the CRM reports it, deliberately not mapped to a DealRipe rep. Same rule as crm_field_events.changed_by.';

comment on column public.crm_activities.is_ours is
  'TRUE when DealRipe wrote this record itself. logCallToSalesforce writes Tasks and createActivity writes Rolldog activities, so without this the tool reads its own output back as the rep''s work, which is precisely how deal_messages came to hold 31 of our own drafts as rep outbound. Every consumer must filter on it.';

create index if not exists crm_activities_deal_idx
  on public.crm_activities (deal_id, occurred_at);

create index if not exists crm_activities_account_idx
  on public.crm_activities (source_system, account_id, occurred_at);

create index if not exists crm_activities_actor_idx
  on public.crm_activities (tenant_id, actor, occurred_at);

-- Idempotency. These are records the CRM already owns, so re-reading one is the
-- same row and a re-run must write nothing.
create unique index if not exists crm_activities_once
  on public.crm_activities (source_system, source_object, external_id);

alter table public.crm_activities enable row level security;

drop policy if exists crm_activities_service on public.crm_activities;
create policy crm_activities_service
  on public.crm_activities
  for all
  to service_role
  using (true)
  with check (true);

commit;
