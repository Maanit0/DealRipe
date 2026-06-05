-- =====================================================================
-- DealRipe RLS posture.
--
-- Layered defense:
--   1. Triggers in schema.sql (enforce_tenant_alignment +
--      prevent_tenant_id_change) reject mismatched/changed tenant_id at
--      write time. They fire on every connection, including service role.
--   2. RLS policies (this file) filter every read and write to the
--      caller's tenant, based on the JWT's tenant_id claim.
--
-- Service role bypasses RLS (Supabase default). Server-side audit writes
-- run as service role and need full access; that bypass is correct.
--
-- See supabase/RLS-POLICIES.md for the human-readable summary handed to
-- Magaya's IT review on May 11.
--
-- Idempotent: drop-if-exists guards on every policy so this file can be
-- re-applied without error after edits.
-- =====================================================================

-- ---------------------------------------------------------------------
-- TEMPORARY: helper for the no-auth demo fallback.
-- SECURITY DEFINER so the anon fallback can resolve without giving the
-- anon client SELECT on the tenants table itself.
-- Remove this function and any reference to it when real auth lands.
-- ---------------------------------------------------------------------
create or replace function public.demo_topsort_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.tenants where slug = 'topsort' limit 1;
$$;

-- ---------------------------------------------------------------------
-- Enable RLS on every table.
-- ---------------------------------------------------------------------
alter table public.tenants            enable row level security;
alter table public.deals              enable row level security;
alter table public.contacts           enable row level security;
alter table public.calls              enable row level security;
alter table public.transcripts        enable row level security;
alter table public.field_extractions  enable row level security;
alter table public.extraction_runs    enable row level security;
alter table public.briefing_runs      enable row level security;

-- ---------------------------------------------------------------------
-- tenants: any authenticated user can SELECT (to look up their own
-- tenant). No INSERT/UPDATE/DELETE policies => only service role writes.
-- ---------------------------------------------------------------------
drop policy if exists tenants_select_authenticated on public.tenants;

create policy tenants_select_authenticated on public.tenants
  for select
  using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------------
-- The standard pattern, repeated for every tenant_id-bearing table:
--
--   SELECT: row.tenant_id matches JWT claim
--           OR (TEMPORARY) JWT has no tenant_id and row is in topsort
--   INSERT: NEW.tenant_id matches JWT claim
--   UPDATE: tenant_id matches on USING (old) and WITH CHECK (new)
--   DELETE: no policy => denied for all non-service-role connections
-- ---------------------------------------------------------------------

-- ----- deals
drop policy if exists deals_select on public.deals;
drop policy if exists deals_insert on public.deals;
drop policy if exists deals_update on public.deals;

create policy deals_select on public.deals
  for select
  using (
    (auth.jwt() ->> 'tenant_id') = tenant_id::text
    -- TEMPORARY: anon fallback for the demo. Remove when auth is wired.
    or (
      (auth.jwt() ->> 'tenant_id') is null
      and tenant_id = demo_topsort_tenant_id()
    )
  );

create policy deals_insert on public.deals
  for insert
  with check ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

create policy deals_update on public.deals
  for update
  using       ((auth.jwt() ->> 'tenant_id') = tenant_id::text)
  with check  ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

-- ----- contacts
drop policy if exists contacts_select on public.contacts;
drop policy if exists contacts_insert on public.contacts;
drop policy if exists contacts_update on public.contacts;

create policy contacts_select on public.contacts
  for select
  using (
    (auth.jwt() ->> 'tenant_id') = tenant_id::text
    -- TEMPORARY: anon fallback for the demo. Remove when auth is wired.
    or (
      (auth.jwt() ->> 'tenant_id') is null
      and tenant_id = demo_topsort_tenant_id()
    )
  );

create policy contacts_insert on public.contacts
  for insert
  with check ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

create policy contacts_update on public.contacts
  for update
  using       ((auth.jwt() ->> 'tenant_id') = tenant_id::text)
  with check  ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

-- ----- calls
drop policy if exists calls_select on public.calls;
drop policy if exists calls_insert on public.calls;
drop policy if exists calls_update on public.calls;

create policy calls_select on public.calls
  for select
  using (
    (auth.jwt() ->> 'tenant_id') = tenant_id::text
    -- TEMPORARY: anon fallback for the demo. Remove when auth is wired.
    or (
      (auth.jwt() ->> 'tenant_id') is null
      and tenant_id = demo_topsort_tenant_id()
    )
  );

create policy calls_insert on public.calls
  for insert
  with check ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

create policy calls_update on public.calls
  for update
  using       ((auth.jwt() ->> 'tenant_id') = tenant_id::text)
  with check  ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

-- ----- transcripts
drop policy if exists transcripts_select on public.transcripts;
drop policy if exists transcripts_insert on public.transcripts;
drop policy if exists transcripts_update on public.transcripts;

create policy transcripts_select on public.transcripts
  for select
  using (
    (auth.jwt() ->> 'tenant_id') = tenant_id::text
    -- TEMPORARY: anon fallback for the demo. Remove when auth is wired.
    or (
      (auth.jwt() ->> 'tenant_id') is null
      and tenant_id = demo_topsort_tenant_id()
    )
  );

create policy transcripts_insert on public.transcripts
  for insert
  with check ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

create policy transcripts_update on public.transcripts
  for update
  using       ((auth.jwt() ->> 'tenant_id') = tenant_id::text)
  with check  ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

-- ----- field_extractions
drop policy if exists field_extractions_select on public.field_extractions;
drop policy if exists field_extractions_insert on public.field_extractions;
drop policy if exists field_extractions_update on public.field_extractions;

create policy field_extractions_select on public.field_extractions
  for select
  using (
    (auth.jwt() ->> 'tenant_id') = tenant_id::text
    -- TEMPORARY: anon fallback for the demo. Remove when auth is wired.
    or (
      (auth.jwt() ->> 'tenant_id') is null
      and tenant_id = demo_topsort_tenant_id()
    )
  );

create policy field_extractions_insert on public.field_extractions
  for insert
  with check ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

create policy field_extractions_update on public.field_extractions
  for update
  using       ((auth.jwt() ->> 'tenant_id') = tenant_id::text)
  with check  ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

-- ----- extraction_runs
drop policy if exists extraction_runs_select on public.extraction_runs;
drop policy if exists extraction_runs_insert on public.extraction_runs;
drop policy if exists extraction_runs_update on public.extraction_runs;

create policy extraction_runs_select on public.extraction_runs
  for select
  using (
    (auth.jwt() ->> 'tenant_id') = tenant_id::text
    -- TEMPORARY: anon fallback for the demo. Remove when auth is wired.
    or (
      (auth.jwt() ->> 'tenant_id') is null
      and tenant_id = demo_topsort_tenant_id()
    )
  );

create policy extraction_runs_insert on public.extraction_runs
  for insert
  with check ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

create policy extraction_runs_update on public.extraction_runs
  for update
  using       ((auth.jwt() ->> 'tenant_id') = tenant_id::text)
  with check  ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

-- ----- briefing_runs
drop policy if exists briefing_runs_select on public.briefing_runs;
drop policy if exists briefing_runs_insert on public.briefing_runs;
drop policy if exists briefing_runs_update on public.briefing_runs;

create policy briefing_runs_select on public.briefing_runs
  for select
  using (
    (auth.jwt() ->> 'tenant_id') = tenant_id::text
    -- TEMPORARY: anon fallback for the demo. Remove when auth is wired.
    or (
      (auth.jwt() ->> 'tenant_id') is null
      and tenant_id = demo_topsort_tenant_id()
    )
  );

create policy briefing_runs_insert on public.briefing_runs
  for insert
  with check ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

create policy briefing_runs_update on public.briefing_runs
  for update
  using       ((auth.jwt() ->> 'tenant_id') = tenant_id::text)
  with check  ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

-- ---------------------------------------------------------------------
-- crm_access_log (Magaya pilot)
--
-- Append-only audit. SELECT and INSERT are tenant-scoped. There are no
-- UPDATE or DELETE policies, so the table cannot be tampered with through
-- the public API; only the service role (used by server-side audit
-- writes) can issue any modification.
-- ---------------------------------------------------------------------
alter table public.crm_access_log enable row level security;

drop policy if exists crm_access_log_select on public.crm_access_log;
drop policy if exists crm_access_log_insert on public.crm_access_log;

create policy crm_access_log_select on public.crm_access_log
  for select
  using (
    (auth.jwt() ->> 'tenant_id') = tenant_id::text
    -- TEMPORARY: anon fallback for the demo. Remove when auth is wired.
    or (
      (auth.jwt() ->> 'tenant_id') is null
      and tenant_id = demo_topsort_tenant_id()
    )
  );

create policy crm_access_log_insert on public.crm_access_log
  for insert
  with check ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

-- No UPDATE policy: log entries are immutable.
-- No DELETE policy: log entries are append-only.

-- ---------------------------------------------------------------------
-- microsoft_connections (Magaya pilot)
--
-- Tenant-scoped SELECT/INSERT/UPDATE via the standard JWT pattern. No
-- DELETE policy: connection removal is operator-run via the service
-- role (a future revoke script will also call /me/revokeSignInSessions
-- on Graph before deleting the row).
-- ---------------------------------------------------------------------
alter table public.microsoft_connections enable row level security;

drop policy if exists microsoft_connections_select on public.microsoft_connections;
drop policy if exists microsoft_connections_insert on public.microsoft_connections;
drop policy if exists microsoft_connections_update on public.microsoft_connections;

create policy microsoft_connections_select on public.microsoft_connections
  for select
  using (
    (auth.jwt() ->> 'tenant_id') = tenant_id::text
    -- TEMPORARY: anon fallback for the demo. Remove when auth is wired.
    or (
      (auth.jwt() ->> 'tenant_id') is null
      and tenant_id = demo_topsort_tenant_id()
    )
  );

create policy microsoft_connections_insert on public.microsoft_connections
  for insert
  with check ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

create policy microsoft_connections_update on public.microsoft_connections
  for update
  using       ((auth.jwt() ->> 'tenant_id') = tenant_id::text)
  with check  ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

-- No DELETE policy: row removal is operator-run via service role.

-- ---------------------------------------------------------------------
-- Framework configuration tables (multi-tenant, standard pattern)
-- ---------------------------------------------------------------------
alter table public.qualification_frameworks enable row level security;
alter table public.framework_fields         enable row level security;
alter table public.deal_signal_snapshots    enable row level security;
alter table public.prescribed_actions       enable row level security;

-- ----- qualification_frameworks
drop policy if exists qualification_frameworks_select on public.qualification_frameworks;
drop policy if exists qualification_frameworks_insert on public.qualification_frameworks;
drop policy if exists qualification_frameworks_update on public.qualification_frameworks;

create policy qualification_frameworks_select on public.qualification_frameworks
  for select
  using (
    (auth.jwt() ->> 'tenant_id') = tenant_id::text
    or (
      (auth.jwt() ->> 'tenant_id') is null
      and tenant_id = demo_topsort_tenant_id()
    )
  );

create policy qualification_frameworks_insert on public.qualification_frameworks
  for insert
  with check ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

create policy qualification_frameworks_update on public.qualification_frameworks
  for update
  using       ((auth.jwt() ->> 'tenant_id') = tenant_id::text)
  with check  ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

-- ----- framework_fields
drop policy if exists framework_fields_select on public.framework_fields;
drop policy if exists framework_fields_insert on public.framework_fields;
drop policy if exists framework_fields_update on public.framework_fields;

create policy framework_fields_select on public.framework_fields
  for select
  using (
    (auth.jwt() ->> 'tenant_id') = tenant_id::text
    or (
      (auth.jwt() ->> 'tenant_id') is null
      and tenant_id = demo_topsort_tenant_id()
    )
  );

create policy framework_fields_insert on public.framework_fields
  for insert
  with check ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

create policy framework_fields_update on public.framework_fields
  for update
  using       ((auth.jwt() ->> 'tenant_id') = tenant_id::text)
  with check  ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

-- ----- deal_signal_snapshots
drop policy if exists deal_signal_snapshots_select on public.deal_signal_snapshots;
drop policy if exists deal_signal_snapshots_insert on public.deal_signal_snapshots;
drop policy if exists deal_signal_snapshots_update on public.deal_signal_snapshots;

create policy deal_signal_snapshots_select on public.deal_signal_snapshots
  for select
  using (
    (auth.jwt() ->> 'tenant_id') = tenant_id::text
    or (
      (auth.jwt() ->> 'tenant_id') is null
      and tenant_id = demo_topsort_tenant_id()
    )
  );

create policy deal_signal_snapshots_insert on public.deal_signal_snapshots
  for insert
  with check ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

create policy deal_signal_snapshots_update on public.deal_signal_snapshots
  for update
  using       ((auth.jwt() ->> 'tenant_id') = tenant_id::text)
  with check  ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

-- ----- prescribed_actions
drop policy if exists prescribed_actions_select on public.prescribed_actions;
drop policy if exists prescribed_actions_insert on public.prescribed_actions;
drop policy if exists prescribed_actions_update on public.prescribed_actions;

create policy prescribed_actions_select on public.prescribed_actions
  for select
  using (
    (auth.jwt() ->> 'tenant_id') = tenant_id::text
    or (
      (auth.jwt() ->> 'tenant_id') is null
      and tenant_id = demo_topsort_tenant_id()
    )
  );

create policy prescribed_actions_insert on public.prescribed_actions
  for insert
  with check ((auth.jwt() ->> 'tenant_id') = tenant_id::text);

create policy prescribed_actions_update on public.prescribed_actions
  for update
  using       ((auth.jwt() ->> 'tenant_id') = tenant_id::text)
  with check  ((auth.jwt() ->> 'tenant_id') = tenant_id::text);
