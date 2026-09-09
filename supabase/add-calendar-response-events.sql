-- Who accepted, who declined, and who was quietly taken off the invite.
--
-- WHY THIS EXISTS, 2026-09-08.
--
-- The RSVP is already in the building. Microsoft Graph returns responseStatus
-- per attendee, calendar-sync stores it inside calls.participants, and
-- lib/attendee-context.ts reads it at render time to say who has accepted. Then
-- calendar-sync's no-change branch overwrites calls.participants with the
-- current roster on every pass, so an attendee who declined and later accepted
-- leaves no trace of having declined, and one who was removed from the invite
-- leaves no trace at all.
--
-- That makes this the one gap where DealRipe is not failing to collect
-- something, it is collecting it and then deleting it. "The economic buyer
-- declined the demo" should be a fact with a date, not a thing somebody
-- notices in a subject line.
--
-- ON TIMESTAMPS, AND WHY THERE IS NO occurred_at.
--
-- Graph exposes no RSVP timestamp. We know a response CHANGED between our
-- previous read of this meeting and this one, and we cannot know where in that
-- window. Rather than an occurred_at that is null on every row and gets
-- misread later as missing data, the honest form is observed_at plus
-- previous_observed_at: the change happened inside that interval. calendar-sync
-- runs every 5 minutes, so the interval is usually tight.
--
-- REMOVAL IS A RESPONSE. to_response carries 'removed' when someone who was on
-- the invite is no longer on it. An economic buyer dropped from a demo invite
-- is a stronger signal than most declines, and it is invisible in every other
-- table.
--
-- Apply by hand:
--   psql "$SUPABASE_DB_URL" -f supabase/add-calendar-response-events.sql
--
-- Additive and idempotent. Safe to re-run.

begin;

create table if not exists public.calendar_response_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  deal_id uuid not null references public.deals (id) on delete cascade,
  call_id uuid references public.calls (id) on delete cascade,

  email text not null,
  display_name text,
  customer_side boolean,

  from_response text,
  to_response text not null,

  meeting_start timestamptz,
  observed_at timestamptz not null default now(),
  previous_observed_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table public.calendar_response_events is
  'One row per observed change to an attendee''s RSVP on a meeting, including being added to or removed from the invite. Written by calendar-sync at the point it would otherwise overwrite calls.participants.';

comment on column public.calendar_response_events.email is
  'Lowercased invite address, the join key. NULL is impossible: an attendee without an address cannot be identified across reads and is skipped rather than guessed at by display name.';

comment on column public.calendar_response_events.customer_side is
  'False for the seller domain, true otherwise. NULL means the address carried no parseable domain. Derived from the address only, never from who organised the meeting.';

comment on column public.calendar_response_events.from_response is
  'NULL means the FIRST time we saw this person on this meeting, which is different from them having previously responded ''none''. ''none'' is Graph''s value for invited-and-not-yet-answered.';

comment on column public.calendar_response_events.to_response is
  'Graph''s responseStatus: accepted, declined, tentativelyAccepted, none, organizer. Plus ''removed'', which is ours and means the person is no longer on the invite at all.';

comment on column public.calendar_response_events.meeting_start is
  'The meeting this response is about, denormalised so a reader does not need calls to ask "declined what". NULL when the call row carried no scheduled_start.';

comment on column public.calendar_response_events.observed_at is
  'When DealRipe saw the change. NOT when the person clicked. Graph exposes no RSVP timestamp.';

comment on column public.calendar_response_events.previous_observed_at is
  'Our previous observation of this person on this meeting. The change happened inside (previous_observed_at, observed_at]. NULL on a first observation, where no lower bound exists.';

-- The per-deal timeline read.
create index if not exists calendar_response_events_deal_idx
  on public.calendar_response_events (deal_id, observed_at);

-- The differ reads last-known state per person per call.
create index if not exists calendar_response_events_call_person_idx
  on public.calendar_response_events (call_id, email, observed_at desc);

-- The person-across-deals read, which is what stakeholder trajectory needs.
create index if not exists calendar_response_events_person_idx
  on public.calendar_response_events (tenant_id, email, observed_at);

alter table public.calendar_response_events enable row level security;

drop policy if exists calendar_response_events_service on public.calendar_response_events;
create policy calendar_response_events_service
  on public.calendar_response_events
  for all
  to service_role
  using (true)
  with check (true);

commit;
