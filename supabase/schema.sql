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

-- =====================================================================
-- CRM access enforcement (added for Magaya pilot)
--
-- Append-only audit of every CRM call that passed through assertScopedRead
-- or assertScopedWrite in lib/crm-scope.ts. Both passes and failures are
-- logged. The table is intentionally write-once at the RLS layer (no
-- UPDATE or DELETE policies).
-- =====================================================================

create table public.crm_access_log (
  id                          uuid          primary key default gen_random_uuid(),
  tenant_id                   uuid          not null references public.tenants(id) on delete cascade,
  operation                   text          not null check (operation in ('read', 'write')),
  opportunity_external_id     text          not null,
  fields                      jsonb         not null,
  allowed                     boolean       not null,
  violation_reason            text,
  created_at                  timestamptz   not null default now()
);

create index crm_access_log_tenant_id_idx          on public.crm_access_log (tenant_id);
create index crm_access_log_opportunity_id_idx     on public.crm_access_log (tenant_id, opportunity_external_id);
create index crm_access_log_created_at_idx         on public.crm_access_log (tenant_id, created_at desc);

-- tenant_id immutability for the log. There is no enforce_tenant_alignment
-- trigger here because crm_access_log has no parent in the deals/calls
-- hierarchy; it points only at tenants.
create trigger crm_access_log_prevent_tenant_change
  before update on public.crm_access_log
  for each row execute function public.prevent_tenant_id_change();

-- =====================================================================
-- Recall.ai integration (delta to the calls table)
--
-- 1. Extends the calls.source allowlist with 'recall_ai'.
-- 2. Adds calls.recall_bot_id: the external bot id returned by
--    POST /api/v1/bot/. Unique because each bot maps to at most one
--    call row; nullable because manual_paste and gong-sourced calls
--    have no bot id.
--
-- The unique index on (deal_id, external_id) is unchanged; recall_bot_id
-- is a separate identifier that uniquely identifies the upstream bot.
-- =====================================================================

alter table public.calls
  drop constraint calls_source_check;

alter table public.calls
  add constraint calls_source_check
    check (source in ('gong','manual_paste','recall_ai'));

alter table public.calls
  add column recall_bot_id text;

alter table public.calls
  add constraint calls_recall_bot_id_unique unique (recall_bot_id);

create index calls_recall_bot_id_idx
  on public.calls (recall_bot_id)
  where recall_bot_id is not null;

-- =====================================================================
-- Microsoft Graph connection (Magaya pilot)
--
-- One row per (tenant, Microsoft user) OAuth connection. Stores the
-- encrypted refresh token; access tokens are minted from it at request
-- time and never persisted (see lib/microsoft-graph.ts).
--
-- The refresh_token_encrypted column holds the output of lib/token-crypto.ts
-- (AES-256-GCM, format `${iv_b64}.${ct_b64}.${tag_b64}`). The encryption
-- key is TOKEN_ENCRYPTION_KEY in env, never in the database.
-- =====================================================================

create table public.microsoft_connections (
  id                          uuid          primary key default gen_random_uuid(),
  tenant_id                   uuid          not null references public.tenants(id) on delete cascade,
  user_principal_name         text,
  microsoft_user_id           text,
  refresh_token_encrypted     text          not null,
  scopes                      text,
  connected_at                timestamptz   not null default now(),
  last_synced_at              timestamptz,
  unique (tenant_id, microsoft_user_id)
);

create index microsoft_connections_tenant_id_idx
  on public.microsoft_connections (tenant_id);

create index microsoft_connections_last_synced_idx
  on public.microsoft_connections (tenant_id, last_synced_at desc nulls last);

create trigger microsoft_connections_prevent_tenant_change
  before update on public.microsoft_connections
  for each row execute function public.prevent_tenant_id_change();

-- =====================================================================
-- Calendar -> Recall ingest glue (delta to the calls table)
--
-- ingest_error: free-text reason set by lib/transcript-sync.ts when a
-- bot reaches a terminal state but the extract/persist/delete pipeline
-- fails. Null on healthy rows. Never reset to null by the sync code:
-- once flagged, an operator inspects and resolves manually.
-- =====================================================================

alter table public.calls
  add column ingest_error text;

-- =====================================================================
-- Qualification framework configuration (multi-tenant)
--
-- Replaces the hardcoded SCOTSMAN list with a per-tenant table of
-- framework + fields. topsort uses the seeded 'SCOTSMAN' builtin;
-- magaya will use a 'Rolldog Stage Gates' framework (MEDDIC variant)
-- ingested at kickoff.
--
-- The extraction prompt is assembled at runtime from framework_fields,
-- so adding/removing fields is a data change, not a code change.
-- =====================================================================

create table public.qualification_frameworks (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  name        text        not null,
  source      text        not null check (source in ('builtin', 'rolldog', 'manual')),
  created_at  timestamptz not null default now(),
  unique (tenant_id, name)
);

create index qualification_frameworks_tenant_id_idx
  on public.qualification_frameworks (tenant_id);

create table public.framework_fields (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references public.tenants(id) on delete cascade,
  framework_id  uuid        not null references public.qualification_frameworks(id) on delete cascade,
  field_key     text        not null,
  label         text        not null,
  question      text        not null,
  stage_key     text,
  write_target  jsonb,
  sort_order    integer     not null default 0,
  created_at    timestamptz not null default now(),
  unique (framework_id, field_key)
);

create index framework_fields_tenant_id_idx     on public.framework_fields (tenant_id);
create index framework_fields_framework_id_idx  on public.framework_fields (framework_id, sort_order);

-- Tenant alignment for framework_fields (tenant must match parent framework).
create trigger framework_fields_enforce_framework_tenant
  before insert or update on public.framework_fields
  for each row
  execute function public.enforce_tenant_alignment('qualification_frameworks', 'framework_id');

-- tenant_id immutability triggers for both new tables.
create trigger qualification_frameworks_prevent_tenant_change
  before update on public.qualification_frameworks
  for each row execute function public.prevent_tenant_id_change();

create trigger framework_fields_prevent_tenant_change
  before update on public.framework_fields
  for each row execute function public.prevent_tenant_id_change();

-- deals: optional framework reference. Existing rows have null until the
-- seed:frameworks script backfills them.
alter table public.deals
  add column framework_id uuid references public.qualification_frameworks(id) on delete set null;

create index deals_framework_id_idx
  on public.deals (framework_id)
  where framework_id is not null;

-- deals.framework_id must point at a framework in the same tenant. The
-- enforce_tenant_alignment trigger fires for null fk_value as a no-op,
-- so existing rows with framework_id=null are unaffected.
create trigger deals_enforce_framework_tenant
  before insert or update on public.deals
  for each row
  execute function public.enforce_tenant_alignment('qualification_frameworks', 'framework_id');

-- field_extractions: rename scotsman_field_id -> framework_field_key.
-- Existing rows survive: the column is renamed in place. The implicit
-- unique constraint (deal_id, scotsman_field_id) auto-updates its column
-- reference; we rename the constraint name for clarity.
alter table public.field_extractions
  rename column scotsman_field_id to framework_field_key;

alter table public.field_extractions
  rename constraint field_extractions_deal_id_scotsman_field_id_key
  to field_extractions_deal_id_framework_field_key_key;

-- field_extractions: add framework_id (nullable; legacy rows have null).
alter table public.field_extractions
  add column framework_id uuid references public.qualification_frameworks(id) on delete set null;

create index field_extractions_framework_id_idx
  on public.field_extractions (framework_id)
  where framework_id is not null;

create trigger field_extractions_enforce_framework_tenant
  before insert or update on public.field_extractions
  for each row
  execute function public.enforce_tenant_alignment('qualification_frameworks', 'framework_id');

-- =====================================================================
-- Closed-loop forward-compat tables (no logic yet; lib/closed-loop.ts
-- exposes typed inserters so briefing + future sync code can call them).
-- =====================================================================

create table public.deal_signal_snapshots (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  deal_id             uuid        not null references public.deals(id) on delete cascade,
  snapshot_date       date        not null,
  signals             jsonb       not null,
  dealripe_forecast   jsonb,
  rep_commit          text,
  outcome_label       text,
  created_at          timestamptz not null default now(),
  unique (deal_id, snapshot_date)
);

create index deal_signal_snapshots_tenant_id_idx
  on public.deal_signal_snapshots (tenant_id);
create index deal_signal_snapshots_deal_date_idx
  on public.deal_signal_snapshots (deal_id, snapshot_date desc);

create trigger deal_signal_snapshots_enforce_deal_tenant
  before insert or update on public.deal_signal_snapshots
  for each row
  execute function public.enforce_tenant_alignment('deals', 'deal_id');

create trigger deal_signal_snapshots_prevent_tenant_change
  before update on public.deal_signal_snapshots
  for each row execute function public.prevent_tenant_id_change();

create table public.prescribed_actions (
  id                    uuid        primary key default gen_random_uuid(),
  tenant_id             uuid        not null references public.tenants(id) on delete cascade,
  deal_id               uuid        not null references public.deals(id) on delete cascade,
  call_external_id      text,
  framework_field_key   text        not null,
  prescription          text        not null,
  created_at            timestamptz not null default now(),
  asked_on_next_call    boolean,
  outcome_label         text
);

create index prescribed_actions_tenant_id_idx
  on public.prescribed_actions (tenant_id);
create index prescribed_actions_deal_idx
  on public.prescribed_actions (deal_id, created_at desc);
create index prescribed_actions_call_idx
  on public.prescribed_actions (call_external_id)
  where call_external_id is not null;

create trigger prescribed_actions_enforce_deal_tenant
  before insert or update on public.prescribed_actions
  for each row
  execute function public.enforce_tenant_alignment('deals', 'deal_id');

create trigger prescribed_actions_prevent_tenant_change
  before update on public.prescribed_actions
  for each row execute function public.prevent_tenant_id_change();

-- =====================================================================
-- Outcome labeling (Salesforce read-only sync)
--
-- Two columns on deals stamped by the outcome-sync job once Salesforce
-- reports IsClosed=true on the linked opportunity:
--   outcome_label        'won' | 'lost' (matches IsWon)
--   outcome_recorded_at  when the label was first set
--
-- The label is also backfilled onto every existing
-- deal_signal_snapshots and prescribed_actions row for the same deal so
-- the calibration job can pair signals + prescriptions to outcomes.
--
-- Read-only is a hard line per the Magaya security review: lib/salesforce.ts
-- exposes no write path, and assertScopedWrite in lib/crm-scope.ts has
-- no Salesforce branch.
-- =====================================================================

alter table public.deals
  add column outcome_label text check (outcome_label in ('won', 'lost'));

alter table public.deals
  add column outcome_recorded_at timestamptz;

create index deals_outcome_label_idx
  on public.deals (tenant_id, outcome_label)
  where outcome_label is not null;

-- =====================================================================
-- App users + Supabase Auth integration (magic-link auth)
--
-- Each row maps an email permitted to sign in to a tenant + role.
-- Provisioning is operator-managed via the service role: SELECT-only
-- RLS denies any anon/authenticated write path.
--
-- The custom_access_token_hook function below copies tenant_id +
-- tenant_slug + app_role into every freshly-minted JWT, so RLS
-- policies on data tables (deals, calls, etc.) continue to use
-- `(auth.jwt() ->> 'tenant_id') = tenant_id::text` exactly as today.
-- =====================================================================

create extension if not exists citext;

create table public.app_users (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references public.tenants(id) on delete cascade,
  email       citext      not null unique,
  role        text        not null check (role in ('cro', 'operator')),
  created_at  timestamptz not null default now()
);

create index app_users_tenant_id_idx on public.app_users (tenant_id);

create trigger app_users_prevent_tenant_change
  before update on public.app_users
  for each row execute function public.prevent_tenant_id_change();

-- ---------------------------------------------------------------------
-- Custom Access Token Hook (Supabase Auth)
--
-- Operator dashboard setup:
--   Authentication > Hooks > Custom Access Token Hook
--   -> public.custom_access_token_hook
--
-- On every token mint Supabase invokes this function with the pending
-- event (containing user_id, claims, etc.) and uses the returned event.
-- We append three claims when the authenticated email is in app_users:
--   tenant_id    (uuid as text)
--   tenant_slug  (text; convenience for client-side display)
--   app_role     ('cro' | 'operator')
--
-- If the email is NOT in app_users, the function returns the event
-- unchanged. The Next.js middleware then routes the user to /no-access.
--
-- security definer + restricted search_path are mandatory for an auth
-- hook (the hook runs as supabase_auth_admin, which has no read access
-- to public schema by default). The grants below are the minimum
-- surface the hook needs.
-- ---------------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claims      jsonb := coalesce(event -> 'claims', '{}'::jsonb);
  user_email  text  := lower(coalesce(claims ->> 'email', ''));
  app_record  record;
begin
  if user_email = '' then
    return event;
  end if;

  select au.tenant_id, au.role, t.slug
    into app_record
    from public.app_users au
    join public.tenants t on t.id = au.tenant_id
    where au.email = user_email
    limit 1;

  if not found then
    return event;
  end if;

  claims := claims
    || jsonb_build_object('tenant_id',   app_record.tenant_id::text)
    || jsonb_build_object('tenant_slug', app_record.slug)
    || jsonb_build_object('app_role',    app_record.role);

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- supabase_auth_admin is the role Supabase Auth runs hooks under.
-- It has no default permissions on public, so we grant exactly what
-- the hook reads.
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant usage  on schema public      to supabase_auth_admin;
grant select on public.app_users   to supabase_auth_admin;
grant select on public.tenants     to supabase_auth_admin;

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
