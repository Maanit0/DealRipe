# DealRipe Supabase setup

This guide walks through the one-time Supabase project setup. You do steps 1, 2, and 3 manually in the dashboard; the schema DDL lives at [supabase/schema.sql](supabase/schema.sql).

After completing this file, the next step (separate task) installs `@supabase/supabase-js` and wires up `lib/supabase.ts`.

---

## 1. Create the Supabase project

1. Go to https://supabase.com/dashboard and sign in.
2. Click **New project**. Suggested settings:
   - **Name**: `dealripe-prod` (or `dealripe-staging` if this is the test env)
   - **Database password**: generate a strong one and save it to your password manager. You will not need it for the application, only for direct DB access via the Supabase CLI.
   - **Region**: pick the region closest to where Vercel runs your app (typically `us-east-1`).
   - **Pricing plan**: free is fine for the demo.
3. Wait ~2 minutes for the project to provision.

---

## 2. Capture the connection credentials

In the Supabase dashboard for your new project:

1. **Settings → API → Project URL.** Copy the `https://<project-ref>.supabase.co` URL.
2. **Settings → API → Project API keys.** Copy two keys:
   - The **`anon` `public`** key (safe to expose to the browser; subject to RLS).
   - The **`service_role` `secret`** key (bypasses RLS; **server-side only, never ship to the browser**).

Add these to `.env.local` at the repo root, alongside `ANTHROPIC_API_KEY`. Append the following block:

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<paste-anon-key-here>
SUPABASE_SERVICE_ROLE_KEY=<paste-service-role-key-here>
```

Notes:
- `NEXT_PUBLIC_` is required by Next.js to expose the variable to the browser bundle. The anon key is designed to be public; RLS enforces what it can read.
- `SUPABASE_SERVICE_ROLE_KEY` has no `NEXT_PUBLIC_` prefix on purpose — Next.js will NOT expose it to the browser.
- `.env.local` is gitignored. Do not commit it. Verify with `git status`.

After saving, restart `npm run dev` so the new env vars load.

---

## 3. Run the schema

In the Supabase dashboard:

1. **SQL Editor → New query.**
2. Open [supabase/schema.sql](supabase/schema.sql) in your editor, copy the entire file, paste into the Supabase SQL editor.
3. Click **Run**. The script should execute as a single block in roughly 1 second.

If it errors midway, the project may be in a half-applied state. Drop the schema and rerun:

```sql
drop schema public cascade;
create schema public;
grant usage on schema public to postgres, anon, authenticated, service_role;
grant all on schema public to postgres, service_role;
```

Then paste [supabase/schema.sql](supabase/schema.sql) and run again. The schema file restores table-level grants at the bottom, so service_role and the anon/authenticated keys can reach the tables (with RLS still gating row visibility).

---

## 4. Verify each table exists

Run each of these in the SQL editor. Each should return one row with the expected column count.

```sql
-- 8 tables expected
select table_name
from information_schema.tables
where table_schema = 'public'
order by table_name;
-- Expected: briefing_runs, calls, contacts, deals, extraction_runs,
--           field_extractions, tenants, transcripts
```

```sql
-- Indexes (10+ expected, including PKs and unique constraints)
select schemaname, tablename, indexname
from pg_indexes
where schemaname = 'public'
order by tablename, indexname;
```

```sql
-- Triggers (17 expected: 2 set_updated_at + 8 enforce_tenant_alignment + 7 prevent_tenant_id_change)
select event_object_table as table_name,
       trigger_name,
       action_timing,
       event_manipulation
from information_schema.triggers
where trigger_schema = 'public'
order by event_object_table, trigger_name;
```

```sql
-- field_extractions payload check should be present
select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.field_extractions'::regclass
  and contype = 'c';
-- Expected: field_extractions_yes_payload_chk (and the status check)
```

---

## 5. Smoke-test the tenant alignment trigger

This is the check Magaya's IT review on May 11 will exercise. Run it once to confirm cross-tenant writes are rejected at the database level.

```sql
-- Setup: two tenants and a deal owned by tenant A.
insert into public.tenants (slug, name) values
  ('topsort', 'TopSort'),
  ('magaya',  'Magaya');

with t as (select id from public.tenants where slug = 'topsort')
insert into public.deals (tenant_id, external_id, account, stage_key, rep_forecast_probability, rep_forecast_close_date)
select id, 'smoketest-deal', 'Smoketest', 'validation', 0.50, '2026-12-31' from t;

-- This should SUCCEED: contact tenant matches deal tenant.
with t as (select id from public.tenants where slug = 'topsort'),
     d as (select id from public.deals where external_id = 'smoketest-deal')
insert into public.contacts (tenant_id, deal_id, name, relationship)
select t.id, d.id, 'Aligned Contact', 'champion' from t, d;

-- This should FAIL with: tenant_alignment: contacts.tenant_id=... does not match deals(id=...).tenant_id=...
with t_wrong as (select id from public.tenants where slug = 'magaya'),
     d as       (select id from public.deals where external_id = 'smoketest-deal')
insert into public.contacts (tenant_id, deal_id, name, relationship)
select t_wrong.id, d.id, 'Misaligned Contact', 'champion' from t_wrong, d;
-- ERROR: tenant_alignment: contacts.tenant_id=<magaya-uuid> does not match deals(id=<deal-uuid>).tenant_id=<topsort-uuid>

-- Cleanup
delete from public.deals where external_id = 'smoketest-deal';
delete from public.tenants where slug in ('topsort','magaya');
```

If both the success and the failure happen as described, the alignment trigger is working. **Do not skip this test** — it's the kind of check the May 11 review will repeat.

### 5b. Smoke-test tenant_id immutability

A second defense: `tenant_id` cannot be changed by any UPDATE. This closes the loophole where a deal could be re-tenanted while its children stay pointed at the old tenant.

```sql
-- Setup: two tenants, one deal owned by the first.
insert into public.tenants (slug, name) values
  ('topsort-imm-test', 'TopSort Imm Test'),
  ('magaya-imm-test',  'Magaya Imm Test');

with t as (select id from public.tenants where slug = 'topsort-imm-test')
insert into public.deals (tenant_id, external_id, account, stage_key, rep_forecast_probability, rep_forecast_close_date)
select id, 'imm-deal', 'Immutable Deal', 'validation', 0.50, '2026-12-31' from t;

-- This should FAIL with: tenant_id is immutable on table deals
update public.deals
   set tenant_id = (select id from public.tenants where slug = 'magaya-imm-test')
 where external_id = 'imm-deal';

-- Cleanup
delete from public.deals where external_id = 'imm-deal';
delete from public.tenants where slug in ('topsort-imm-test','magaya-imm-test');
```

The `prevent_tenant_id_change()` trigger fires on `BEFORE UPDATE` for every table that has a `tenant_id` column (excluding `tenants` itself). Any attempt to change `tenant_id` is rejected loudly, regardless of which client (anon, authenticated, or service role) issued the update.

---

## 6. Apply RLS policies

The schema in section 3 creates the tables but does not add Row Level Security policies. RLS is added separately in [supabase/rls.sql](supabase/rls.sql). Apply it now:

1. **SQL Editor → New query.**
2. Open [supabase/rls.sql](supabase/rls.sql), copy the entire file, paste, and click **Run**.

The file is idempotent (every `create policy` is preceded by `drop policy if exists`), so it is safe to re-run after future edits.

What this adds:

- A `demo_topsort_tenant_id()` `SECURITY DEFINER` helper for the temporary anon-key fallback.
- `enable row level security` on every table (no-op if you clicked "Run and enable RLS" earlier).
- 22 policies in total: 1 SELECT on `tenants`, plus 3 each (SELECT, INSERT, UPDATE) on the 7 tenant_id-bearing tables.
- No DELETE policies. Deletions go through the service role only.

See [supabase/RLS-POLICIES.md](supabase/RLS-POLICIES.md) for the human-readable summary written for the May 11 Magaya code review.

---

## 7. Verify RLS

### 7a. Policies are present

Run in the SQL editor:

```sql
-- Should return 22 rows: tenants_select_authenticated + 3 policies each on
-- 7 tenant_id-bearing tables (deals, contacts, calls, transcripts,
-- field_extractions, extraction_runs, briefing_runs).
select schemaname, tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
```

```sql
-- Should return 8 rows, all with rowsecurity = true.
select c.relname as table_name, c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
```

### 7b. Anonymous fallback works (only for TopSort)

From a terminal in the project root:

```bash
URL=$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2-)
ANON=$(grep -E '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)

# Should return Lumora's row.
curl -s -H "apikey: $ANON" "$URL/rest/v1/deals?select=external_id,account"

# Should return Lumora's 18 field rows (count via Content-Range header).
curl -sI -H "apikey: $ANON" -H "Prefer: count=exact" \
  "$URL/rest/v1/field_extractions?select=*" | grep -i content-range
```

If both queries return data, the temporary anon fallback is working as intended.

### 7c. Service role bypass works

```bash
SVC=$(grep -E '^SUPABASE_SERVICE_ROLE_KEY=' .env.local | cut -d= -f2-)
curl -sI -H "apikey: $SVC" -H "Authorization: Bearer $SVC" -H "Prefer: count=exact" \
  "$URL/rest/v1/extraction_runs?select=*" | grep -i content-range
```

This must succeed regardless of how many tenants exist or what their slugs are; the service role bypasses RLS entirely.

### 7d. Cross-tenant isolation (when a second tenant exists)

This test is meaningful only after a second tenant (e.g. Magaya) has been seeded. Today only TopSort exists, so this is a placeholder to revisit after the next migration.

```sql
-- Insert a second tenant and a deal under it
insert into public.tenants (slug, name) values ('magaya', 'Magaya');
with t as (select id from public.tenants where slug = 'magaya')
insert into public.deals (tenant_id, external_id, account, stage_key,
                          rep_forecast_probability, rep_forecast_close_date)
select id, 'magaya-test-1', 'Magaya Test', 'validation', 0.50, '2026-12-31' from t;
```

Then from the terminal:
```bash
# Anon key returns ONLY the topsort row (Lumora), not the magaya row.
# This is because the temporary fallback restricts anon to topsort.
curl -s -H "apikey: $ANON" "$URL/rest/v1/deals?select=external_id"
# Expected: [{"external_id":"lumora-2026-q2"}]
```

Cleanup when done:
```sql
delete from public.deals where external_id = 'magaya-test-1';
delete from public.tenants where slug = 'magaya';
```

### 7e. Review checklist when auth is added

When SSO lands, return to this section and:

1. Drop `demo_topsort_tenant_id()` and remove the `-- TEMPORARY` clauses from every SELECT policy.
2. Add an authenticated-user test that reads with a wrong-tenant JWT and confirms empty results (cross-tenant isolation under real auth).
3. Add an authenticated-user test that writes with a wrong-tenant JWT and confirms the INSERT/UPDATE is rejected with a policy violation.
4. Update [supabase/RLS-POLICIES.md](supabase/RLS-POLICIES.md) to remove the "Temporary anonymous fallback" section.

---

## 8. What's next

After this file is fully done, the next tasks wire the migration script and the API audit writes. Both are completed in steps 4 and 5 of the build (see project notes).

---

## Troubleshooting

- **`gen_random_uuid` does not exist.** The `pgcrypto` extension didn't enable. Run `create extension if not exists pgcrypto;` and retry.
- **`permission denied for schema public`.** You ran the drop-schema cleanup but didn't regrant. Run the grant block from section 3.
- **Trigger fires on every row but you wanted to disable it temporarily.** Don't. The whole point is that there is no escape hatch except `service_role`. If you need to bulk-load, do it via service role with explicit, correct `tenant_id` on every row.

---

## Caching: reads must be live (do not remove `no-store`)

**The Supabase clients in `lib/supabase.ts` are created with `global.fetch` forcing `cache: "no-store"`. Do not remove this.**

Next.js App Router patches the global `fetch` to cache responses in its **Data Cache**, which is persistent and **survives redeploys** (it is not cleared by a normal deploy, nor by an "ignore build cache" rebuild). `supabase-js` issues its queries through `fetch`, so without `no-store` every Supabase read is eligible for caching keyed by its query URL. The failure mode is nasty and hard to diagnose: you fix data in the database, but the app keeps serving a stale read from before the change, indefinitely, while a *different* query (different URL) on the same page shows fresh data. `export const dynamic = "force-dynamic"` on a route does **not** reliably prevent this for individual `supabase-js` fetches.

Rules to keep this from recurring:

1. Keep `cache: "no-store"` on both `supabaseClient()` and `supabaseAdmin()` in `lib/supabase.ts`.
2. Never cache database rows in a process-wide / module-level structure (e.g. a top-level `Map`). Such a cache outlives a runtime data change until the serverless instance is recycled, producing the same class of stale-read bug. If you need per-request de-duplication, wrap the loader in React's `cache()` (request-scoped, discarded at request end), as `loadFramework` in `lib/framework.ts` does.
3. If you ever want a specific read cached for performance, opt in deliberately per query (e.g. `{ next: { revalidate: N } }`), never rely on the default.
