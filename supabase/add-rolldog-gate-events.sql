-- The rep's Rolldog checklist, as a trajectory instead of a screenshot.
--
-- WHY THIS EXISTS, 2026-09-08.
--
-- DealRipe has read /opportunities/{id}/opportunity-stages-requirement since
-- the pilot began and has never stored a single row of it. lib/deal-context.ts
-- fetches the checklist to build a briefing prompt and throws it away, so the
-- one question the checklist can answer that nothing else can is unanswerable:
-- WHEN did the rep tick "Validate Who Negotiate and Signs", and what happened
-- on the call before they did.
--
-- Rolldog exposes current state only. There is no history endpoint, so unlike
-- mail (which Graph retains for months) every tick that happens today is
-- unrecoverable tomorrow. That is why this ships before the email work even
-- though the email work is worth more: priority ordering optimises for value,
-- and loss rate argues for whichever thing is bleeding.
--
-- TWO TABLES, AND THE SECOND ONE IS NOT OPTIONAL.
--
-- rolldog_gate_events records only what someone deliberately did. An event log
-- cannot say "we tried to read this opportunity and were refused", and storing
-- a failed read as an absence of ticks is precisely the bug lib/stage-gates.ts
-- was written to fix: it once told a paying customer in onboarding that Magaya
-- was not their selected vendor. rolldog_checklist_reads carries the read
-- status beside the events so "no ticks" and "no answer" stay distinguishable.
--
-- WHY AN EVENT LOG AND NOT A DAILY SNAPSHOT. A false on this checklist means
-- UNSET, not "no": there is one boolean and no third state, and only a positive
-- tick carries information. A snapshot would write ~31 overwhelmingly-false
-- booleans per deal per run and force every future reader to relearn that
-- semantic. deal_signal_snapshots is also the cautionary tale: unique
-- (deal_id, snapshot_date) plus an upsert destroys five of six daily readings
-- and the table has no updated_at to record that it happened.
--
-- NO BACKFILL IS POSSIBLE. Rolldog will not tell us when anything was ticked.
-- The first sweep writes one event per currently-ticked item with from_ticked
-- null, which is the honest floor ("this is the first thing we know") rather
-- than a claim that it flipped on the day this table was created. Same
-- discipline as scripts/backfill-gate-events.ts.
--
-- Apply by hand:
--   psql "$SUPABASE_DB_URL" -f supabase/add-rolldog-gate-events.sql
--
-- Additive and idempotent. Safe to re-run.

begin;

create table if not exists public.rolldog_gate_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  deal_id uuid not null references public.deals (id) on delete cascade,
  opportunity_id text not null,

  rolldog_id integer not null,
  item_name text,
  stage_key text,

  from_ticked boolean,
  to_ticked boolean not null,

  observed_at timestamptz not null default now(),
  source text not null default 'sweep',
  created_at timestamptz not null default now()
);

comment on table public.rolldog_gate_events is
  'One row per observed change to a Rolldog stage-requirement item. Absence of a row means nothing changed OR that we never read it; rolldog_checklist_reads is what separates those.';

comment on column public.rolldog_gate_events.rolldog_id is
  'Rolldog''s stable requirement DEFINITION id, shared across opportunities. THE join key. Never join on item_name: the live payload contains a leading space in " Create Initial Close Plan and Presented" and a typo in "Validate Who Negotiate and Signs".';

comment on column public.rolldog_gate_events.item_name is
  'Denormalised for a human reading this table. NULL means the payload carried no name. Not an identifier and must never be joined on.';

comment on column public.rolldog_gate_events.stage_key is
  'SQL0..SQL5, resolved POSITIONALLY. NULL means the position was unknown. Never parsed from the stage name: Magaya''s second stage is "SQL - Develop Opportunity (Qualify)" and carries no digit.';

comment on column public.rolldog_gate_events.from_ticked is
  'NULL means this is the FIRST time we observed this item, which is different from false. False means we previously saw it unticked. A false is UNSET, never a recorded "no".';

comment on column public.rolldog_gate_events.to_ticked is
  'The value after the change. A true is a positive tick and carries information; a false only means the tick was removed, not that the rep answered no.';

comment on column public.rolldog_gate_events.observed_at is
  'When DealRipe saw the change, NOT when the rep made it. Rolldog does not expose a tick timestamp, so the real event is somewhere between this and the previous read of the same opportunity.';

comment on column public.rolldog_gate_events.source is
  '''sweep'' for the periodic reader, ''seed'' for the first observation of an already-ticked item.';

-- The trajectory read: one deal, in order.
create index if not exists rolldog_gate_events_deal_idx
  on public.rolldog_gate_events (deal_id, observed_at);

-- The last-known state per item, which is what the differ reads before writing.
create index if not exists rolldog_gate_events_item_idx
  on public.rolldog_gate_events (deal_id, rolldog_id, observed_at desc);

-- The learning read: one requirement across every deal.
create index if not exists rolldog_gate_events_field_idx
  on public.rolldog_gate_events (tenant_id, rolldog_id, observed_at);

-- Every attempt to read a checklist, including the ones that failed.
create table if not exists public.rolldog_checklist_reads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  deal_id uuid not null references public.deals (id) on delete cascade,
  opportunity_id text,

  read_at timestamptz not null default now(),
  status text not null,

  ticked_count integer,
  total_count integer,
  current_stage_position integer,
  error text
);

comment on table public.rolldog_checklist_reads is
  'One row per attempted checklist read. Exists so that an absence of gate events can be told apart from an absence of answers.';

comment on column public.rolldog_checklist_reads.status is
  'EXACTLY the four spellings lib/deal-context.ts already uses: present, no_opportunity, no_checklist, unavailable. Do not invent a fifth. present = we read it. no_opportunity = the deal has no Rolldog opportunity. no_checklist = Rolldog returned 404 for the sub-resource. unavailable = we could not ask, which is NOT the same as an empty checklist.';

comment on column public.rolldog_checklist_reads.ticked_count is
  'NULL unless status = ''present''. This is the column that stops a failed read rendering as "the rep has ticked nothing", which is the failure this whole table exists to prevent.';

comment on column public.rolldog_checklist_reads.total_count is
  'NULL unless status = ''present''. Item count as Rolldog returned it, not our expected count.';

comment on column public.rolldog_checklist_reads.current_stage_position is
  'Rolldog''s current-stage-position. NULL is a real state: opportunity 70908 (TW Customs) returns none, and lib/stage-gates.ts then infers a floor from the highest ticked stage.';

comment on column public.rolldog_checklist_reads.error is
  'Populated only when status = ''unavailable''. NULL elsewhere.';

create index if not exists rolldog_checklist_reads_deal_idx
  on public.rolldog_checklist_reads (deal_id, read_at desc);

-- The rate gate reads this: has this opportunity been swept recently.
create index if not exists rolldog_checklist_reads_recent_idx
  on public.rolldog_checklist_reads (tenant_id, read_at desc);

alter table public.rolldog_gate_events enable row level security;
alter table public.rolldog_checklist_reads enable row level security;

-- Same posture as the other tables here: service role only, no anon access.
drop policy if exists rolldog_gate_events_service on public.rolldog_gate_events;
create policy rolldog_gate_events_service
  on public.rolldog_gate_events
  for all
  to service_role
  using (true)
  with check (true);

drop policy if exists rolldog_checklist_reads_service on public.rolldog_checklist_reads;
create policy rolldog_checklist_reads_service
  on public.rolldog_checklist_reads
  for all
  to service_role
  using (true)
  with check (true);

commit;
