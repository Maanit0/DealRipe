-- ====================================================================
-- DealRipe: tenant-aware auth + RLS for the live pilot UI.
--
-- Apply this to your Supabase project (SQL editor), then enable the
-- access-token hook in the dashboard (instructions at the bottom).
--
-- What it does:
--   1. custom_access_token_hook: on every login, looks up the user in
--      public.app_users and injects tenant_id, tenant_slug, app_role
--      into their JWT. The middleware already reads these claims.
--   2. RLS: defense-in-depth so an authenticated user can only SELECT
--      their own tenant's rows. (The server read layer in
--      lib/supabase-queries.ts uses the service role + an explicit
--      tenant filter, so it is unaffected; RLS protects any direct
--      client-side query.)
--
-- Prereq: public.app_users(email, tenant_id, role) is seeded with
--   mbuman@magaya.com -> magaya tenant, role 'cro'
--   maanits@berkeley.edu -> magaya tenant (or operator), role 'operator'
-- (scripts/seed-app-users.ts).
-- ====================================================================

-- --------------------------------------------------------------------
-- 1. Custom access token hook
-- --------------------------------------------------------------------
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
as $$
declare
  claims     jsonb;
  v_email    text;
  v_tenant   uuid;
  v_slug     text;
  v_role     text;
begin
  claims := coalesce(event->'claims', '{}'::jsonb);

  select u.email into v_email
  from auth.users u
  where u.id = (event->>'user_id')::uuid;

  select au.tenant_id, t.slug, au.role
    into v_tenant, v_slug, v_role
  from public.app_users au
  join public.tenants t on t.id = au.tenant_id
  where lower(au.email) = lower(v_email)
  limit 1;

  if v_tenant is not null then
    claims := jsonb_set(claims, '{tenant_id}',   to_jsonb(v_tenant::text));
    claims := jsonb_set(claims, '{tenant_slug}', to_jsonb(coalesce(v_slug, '')));
    claims := jsonb_set(claims, '{app_role}',    to_jsonb(coalesce(v_role, '')));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- The auth admin role runs the hook and must read the lookup tables.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant select on public.app_users to supabase_auth_admin;
grant select on public.tenants  to supabase_auth_admin;

-- --------------------------------------------------------------------
-- 2. Row-level security (defense in depth)
--    SELECT-only policies scoped to the JWT tenant_id claim.
--    Service-role reads/writes (cron + lib/supabase-queries.ts) bypass RLS.
-- --------------------------------------------------------------------
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'deals', 'contacts', 'calls', 'transcripts', 'field_extractions',
    'briefing_runs', 'deal_signal_snapshots', 'prescribed_actions',
    'qualification_frameworks', 'framework_fields'
  ]
  loop
    execute format('alter table public.%I enable row level security;', tbl);
    execute format('drop policy if exists tenant_select on public.%I;', tbl);
    execute format(
      'create policy tenant_select on public.%I for select to authenticated '
      || 'using (tenant_id = (auth.jwt() ->> ''tenant_id'')::uuid);',
      tbl
    );
  end loop;
end $$;

-- ====================================================================
-- AFTER running this SQL:
--   Dashboard -> Authentication -> Hooks (or Auth Hooks) ->
--   "Custom Access Token" -> enable -> select
--   public.custom_access_token_hook.
--
-- Then Mark (mbuman@magaya.com) logs in at /login via magic link and his
-- JWT will carry tenant_id (magaya), tenant_slug 'magaya', app_role 'cro'.
-- The middleware redirects users without a tenant_id claim to /no-access,
-- so seed app_users first.
-- ====================================================================
