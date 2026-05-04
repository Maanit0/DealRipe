-- =====================================================================
-- DealRipe schema. Multi-tenant. Audit-ready.
-- Postgres / Supabase. RLS is added in a separate file (rls.sql).
--
-- Run this in the Supabase SQL editor as a single transaction.
-- See SETUP.md for step-by-step instructions and verification queries.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------
create table public.tenants (
  id          uuid        primary key default gen_random_uuid(),
  slug        text        not null unique,
  name        text        not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- deals
-- ---------------------------------------------------------------------
create table public.deals (
  id                          uuid          primary key default gen_random_uuid(),
  tenant_id                   uuid          not null references public.tenants(id) on delete cascade,
  external_id                 text,
  account                     text          not null,
  industry                    text,
  arr                         numeric(12,2),
  stage_key                   text          not null,
  days_in_stage               integer,
  rep_forecast_probability    numeric(4,3)  check (rep_forecast_probability >= 0 and rep_forecast_probability <= 1),
  rep_forecast_close_date     date,
  rep_notes                   text,
  created_at                  timestamptz   not null default now(),
  updated_at                  timestamptz   not null default now(),
  unique (tenant_id, external_id)
);

create index deals_tenant_id_idx on public.deals (tenant_id);

-- ---------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------
create table public.contacts (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  deal_id             uuid        not null references public.deals(id)  on delete cascade,
  external_id         text,
  name                text        not null,
  role                text,
  relationship        text        not null check (relationship in
                                  ('champion','influencer','economic_buyer','user','unknown')),
  last_contacted_at   date,
  created_at          timestamptz not null default now(),
  unique (deal_id, external_id)
);

create index contacts_deal_id_idx   on public.contacts (deal_id);
create index contacts_tenant_id_idx on public.contacts (tenant_id);

-- ---------------------------------------------------------------------
-- calls
-- ---------------------------------------------------------------------
create table public.calls (
  id                    uuid        primary key default gen_random_uuid(),
  tenant_id             uuid        not null references public.tenants(id) on delete cascade,
  deal_id               uuid        not null references public.deals(id)  on delete cascade,
  external_id           text,
  call_date             date,
  duration_minutes      integer,
  participants          jsonb,
  source                text        check (source in ('gong','manual_paste')),
  transcript_id         text,                       -- pre-import reference (e.g. 'lumora-discovery-2'); not a FK
  has_been_extracted    boolean     not null default false,
  created_at            timestamptz not null default now(),
  unique (deal_id, external_id)
);

create index calls_deal_id_date_idx on public.calls (deal_id, call_date desc);
create index calls_tenant_id_idx    on public.calls (tenant_id);

-- ---------------------------------------------------------------------
-- transcripts (canonical link via call_id)
-- ---------------------------------------------------------------------
create table public.transcripts (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  call_id     uuid        not null unique references public.calls(id) on delete cascade,
  body        text        not null,
  created_at  timestamptz not null default now()
);

create index transcripts_tenant_id_idx on public.transcripts (tenant_id);

-- ---------------------------------------------------------------------
-- field_extractions (one row per (deal, scotsman_field))
-- ---------------------------------------------------------------------
create table public.field_extractions (
  id                          uuid          primary key default gen_random_uuid(),
  tenant_id                   uuid          not null references public.tenants(id) on delete cascade,
  deal_id                     uuid          not null references public.deals(id)  on delete cascade,
  scotsman_field_id           text          not null,
  status                      text          not null check (status in ('Yes','No','Unknown')),
  answer                      text,
  evidence                    text,
  confidence                  numeric(4,3)  check (confidence is null or (confidence >= 0 and confidence <= 1)),
  last_updated_from_call_id   uuid          references public.calls(id) on delete set null,
  created_at                  timestamptz   not null default now(),
  updated_at                  timestamptz   not null default now(),
  unique (deal_id, scotsman_field_id)
);

create index field_extractions_tenant_id_idx                on public.field_extractions (tenant_id);
create index field_extractions_last_updated_from_call_idx   on public.field_extractions (last_updated_from_call_id);

-- Yes rows must have answer + evidence (confidence optional).
-- No/Unknown rows must have answer, evidence, and confidence all null.
alter table public.field_extractions
  add constraint field_extractions_yes_payload_chk
  check (
    (status = 'Yes'
       and answer is not null
       and evidence is not null)
    or
    (status in ('No','Unknown')
       and answer is null
       and evidence is null
       and confidence is null)
  );

-- ---------------------------------------------------------------------
-- extraction_runs (immutable audit trail; one row per LLM call)
-- ---------------------------------------------------------------------
create table public.extraction_runs (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references public.tenants(id) on delete cascade,
  deal_id         uuid        not null references public.deals(id)  on delete cascade,
  call_id         uuid        references public.calls(id) on delete set null,
  model_name      text        not null,
  prompt_version  text,
  raw_response    jsonb,
  token_input     integer,
  token_output    integer,
  duration_ms     integer,
  created_at      timestamptz not null default now()
);

create index extraction_runs_deal_id_created_idx on public.extraction_runs (deal_id, created_at desc);
create index extraction_runs_tenant_id_idx       on public.extraction_runs (tenant_id);
create index extraction_runs_call_id_idx         on public.extraction_runs (call_id);

-- ---------------------------------------------------------------------
-- briefing_runs (audit trail for /api/prepare-briefing)
-- ---------------------------------------------------------------------
create table public.briefing_runs (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references public.tenants(id) on delete cascade,
  deal_id         uuid        not null references public.deals(id)  on delete cascade,
  model_name      text        not null,
  prompt_version  text,
  raw_response    jsonb,
  token_input     integer,
  token_output    integer,
  duration_ms     integer,
  created_at      timestamptz not null default now()
);

create index briefing_runs_deal_id_created_idx on public.briefing_runs (deal_id, created_at desc);
create index briefing_runs_tenant_id_idx       on public.briefing_runs (tenant_id);

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger deals_set_updated_at
  before update on public.deals
  for each row execute function public.set_updated_at();

create trigger field_extractions_set_updated_at
  before update on public.field_extractions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Tenant alignment: every child row's tenant_id must match its parent's.
-- One generic function, parameterized via TG_ARGV[0]=parent_table,
-- TG_ARGV[1]=fk_column. Optional FKs (null) are skipped.
-- ---------------------------------------------------------------------
create or replace function public.enforce_tenant_alignment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_table   text := TG_ARGV[0];
  fk_column      text := TG_ARGV[1];
  fk_value       uuid;
  parent_tenant  uuid;
begin
  execute format('select ($1).%I', fk_column) into fk_value using NEW;

  -- If the FK is null, skip the alignment check.
  -- Column-level NOT NULL constraints handle required-ness on their own.
  if fk_value is null then
    return NEW;
  end if;

  execute format('select tenant_id from public.%I where id = $1', parent_table)
    into parent_tenant
    using fk_value;

  if parent_tenant is null then
    raise exception 'tenant_alignment: parent % row not found for %.%=%',
      parent_table, TG_TABLE_NAME, fk_column, fk_value;
  end if;

  if NEW.tenant_id is distinct from parent_tenant then
    raise exception 'tenant_alignment: %.tenant_id=% does not match %(id=%).tenant_id=%',
      TG_TABLE_NAME, NEW.tenant_id, parent_table, fk_value, parent_tenant;
  end if;

  return NEW;
end;
$$;

create trigger contacts_enforce_deal_tenant
  before insert or update on public.contacts
  for each row
  execute function public.enforce_tenant_alignment('deals', 'deal_id');

create trigger calls_enforce_deal_tenant
  before insert or update on public.calls
  for each row
  execute function public.enforce_tenant_alignment('deals', 'deal_id');

create trigger transcripts_enforce_call_tenant
  before insert or update on public.transcripts
  for each row
  execute function public.enforce_tenant_alignment('calls', 'call_id');

create trigger field_extractions_enforce_deal_tenant
  before insert or update on public.field_extractions
  for each row
  execute function public.enforce_tenant_alignment('deals', 'deal_id');

create trigger field_extractions_enforce_call_tenant
  before insert or update on public.field_extractions
  for each row
  execute function public.enforce_tenant_alignment('calls', 'last_updated_from_call_id');

create trigger extraction_runs_enforce_deal_tenant
  before insert or update on public.extraction_runs
  for each row
  execute function public.enforce_tenant_alignment('deals', 'deal_id');

create trigger extraction_runs_enforce_call_tenant
  before insert or update on public.extraction_runs
  for each row
  execute function public.enforce_tenant_alignment('calls', 'call_id');

create trigger briefing_runs_enforce_deal_tenant
  before insert or update on public.briefing_runs
  for each row
  execute function public.enforce_tenant_alignment('deals', 'deal_id');

-- ---------------------------------------------------------------------
-- tenant_id immutability: every UPDATE that changes tenant_id is rejected.
-- Closes the gap where a parent could be re-tenanted while children stay
-- pointed at the old tenant. tenants table itself is excluded.
-- ---------------------------------------------------------------------
create or replace function public.prevent_tenant_id_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.tenant_id is distinct from new.tenant_id then
    raise exception 'tenant_id is immutable on table %', TG_TABLE_NAME;
  end if;
  return new;
end;
$$;

create trigger deals_prevent_tenant_change
  before update on public.deals
  for each row execute function public.prevent_tenant_id_change();

create trigger contacts_prevent_tenant_change
  before update on public.contacts
  for each row execute function public.prevent_tenant_id_change();

create trigger calls_prevent_tenant_change
  before update on public.calls
  for each row execute function public.prevent_tenant_id_change();

create trigger transcripts_prevent_tenant_change
  before update on public.transcripts
  for each row execute function public.prevent_tenant_id_change();

create trigger field_extractions_prevent_tenant_change
  before update on public.field_extractions
  for each row execute function public.prevent_tenant_id_change();

create trigger extraction_runs_prevent_tenant_change
  before update on public.extraction_runs
  for each row execute function public.prevent_tenant_id_change();

create trigger briefing_runs_prevent_tenant_change
  before update on public.briefing_runs
  for each row execute function public.prevent_tenant_id_change();

-- ---------------------------------------------------------------------
-- Role grants. Required after a `drop schema public cascade; create
-- schema public;` cleanup, which wipes Supabase's default ACLs.
-- A fresh Supabase project has these baked in; we restore them here so
-- the schema is self-contained and replayable.
-- RLS still gates row-level access for anon and authenticated.
-- ---------------------------------------------------------------------
grant all on all tables    in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

alter default privileges in schema public grant all on tables    to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated;
