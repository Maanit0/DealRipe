# DealRipe Row Level Security posture

**Audience:** Magaya IT and security reviewers (May 11 code review).
**Status:** RLS enabled on every table in the `public` schema. Tenant isolation is enforced at the database level by two independent layers.

---

## At a glance

| Table | RLS | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|---|
| `tenants` | enabled | authenticated only | service role only | service role only | service role only |
| `deals` | enabled | tenant-scoped | tenant-scoped | tenant-scoped | service role only |
| `contacts` | enabled | tenant-scoped | tenant-scoped | tenant-scoped | service role only |
| `calls` | enabled | tenant-scoped | tenant-scoped | tenant-scoped | service role only |
| `transcripts` | enabled | tenant-scoped | tenant-scoped | tenant-scoped | service role only |
| `field_extractions` | enabled | tenant-scoped | tenant-scoped | tenant-scoped | service role only |
| `extraction_runs` | enabled | tenant-scoped | tenant-scoped | tenant-scoped | service role only |
| `briefing_runs` | enabled | tenant-scoped | tenant-scoped | tenant-scoped | service role only |

DELETE is intentionally not exposed via RLS for any client. Deletions go through service-role-controlled procedures (currently the migration script's `--reset` flag and SQL editor for manual operations) and are out of scope for any client API key.

---

## The general policy pattern

For each tenant_id-bearing table:

```sql
SELECT  USING (
  (auth.jwt() ->> 'tenant_id') = tenant_id::text
  OR <demo fallback>          -- temporary; see below
)
INSERT  WITH CHECK ( (auth.jwt() ->> 'tenant_id') = tenant_id::text )
UPDATE  USING      ( (auth.jwt() ->> 'tenant_id') = tenant_id::text )
        WITH CHECK ( (auth.jwt() ->> 'tenant_id') = tenant_id::text )
DELETE  -- no policy, denied
```

In effect: any read or write through the public PostgREST API requires a JWT whose `tenant_id` claim matches the row's `tenant_id`. A user cannot read or write a row outside their tenant.

The `tenants` table is the exception: it has only a SELECT policy gated by `auth.role() = 'authenticated'`, because every authenticated user needs to be able to look up their own tenant record.

---

## Defense in depth

Two independent layers protect tenant isolation, both at the database level:

### Layer 1: triggers in [supabase/schema.sql](schema.sql)

- **`enforce_tenant_alignment`** rejects any INSERT or UPDATE where a row's `tenant_id` does not match its parent's. Example: a `contacts` row whose `tenant_id` differs from the `deals.tenant_id` it points to fails immediately with `tenant_alignment: contacts.tenant_id=X does not match deals(id=Y).tenant_id=Z`.
- **`prevent_tenant_id_change`** rejects any UPDATE that changes `tenant_id`. The column is effectively immutable once written.

These triggers fire on every connection, **including service role**. Even a misbehaving server-side write cannot cross a tenant boundary or reassign a row to another tenant.

### Layer 2: RLS policies in [supabase/rls.sql](rls.sql)

Per-row filter on top of every read and write through the public API, as described above. RLS does not apply to service role connections by Supabase's design (see next section).

---

## Service role bypass: why it is correct

The `service_role` Postgres role bypasses RLS by Supabase's default configuration. DealRipe's server-side code uses the service role key for two operations:

1. **Writing audit rows** to `extraction_runs` and `briefing_runs` after every Anthropic API call. These rows are immutable history and must succeed regardless of the requesting user's JWT, including when no user JWT is present (cron jobs, system-triggered work).
2. **Reading server-side state** during request handling, where the user's JWT is not propagated. Today this is limited to the tenant/deal UUID lookups in [lib/tenant-deal-lookup.ts](../lib/tenant-deal-lookup.ts).

Service role usage is restricted to the Next.js server runtime. The key is held in `SUPABASE_SERVICE_ROLE_KEY`, which is intentionally not prefixed with `NEXT_PUBLIC_`, so Next.js does not include it in the browser bundle. [lib/supabase.ts](../lib/supabase.ts) contains a runtime guard that throws if `supabaseAdmin()` is called from a browser context (`typeof window !== "undefined"`).

Triggers (Layer 1) still apply to service role connections, so even with RLS bypassed, cross-tenant writes are rejected at the database level.

---

## Temporary anonymous fallback

The current build is in a no-auth state. SSO is on the roadmap; until it lands, we keep the demo functional by including a fallback clause in every SELECT policy:

```sql
OR (
  (auth.jwt() ->> 'tenant_id') is null
  AND tenant_id = demo_topsort_tenant_id()
)
```

This allows anonymous reads of TopSort tenant data only. Reads of any other tenant (e.g., Magaya, when seeded) are denied to anonymous clients. Writes via the anon key are denied unconditionally; only the service role can write.

The helper `demo_topsort_tenant_id()` is a `SECURITY DEFINER` function that returns the UUID of the topsort tenant. It is `SECURITY DEFINER` so the fallback can resolve the tenant ID without granting anon clients a SELECT policy on `tenants` itself. The function takes no arguments, has a fixed `search_path = public`, and runs as the function owner (postgres), with no privilege escalation surface.

### When to remove the fallback

The fallback must be removed when authentication is implemented. The cleanup steps:

1. Drop the `demo_topsort_tenant_id()` function:
   ```sql
   drop function public.demo_topsort_tenant_id();
   ```
2. Remove the `OR ( (auth.jwt() ->> 'tenant_id') is null AND tenant_id = demo_topsort_tenant_id() )` clause from every SELECT policy. Grep target: `-- TEMPORARY: anon fallback for the demo`.

A new test in [SETUP.md](../SETUP.md) will then verify cross-tenant reads are denied for authenticated users with the wrong tenant claim.

---

## How auth will plug in

When SSO is wired:

1. The auth provider (likely Supabase Auth or a SAML/OIDC bridge) issues JWTs that include a top-level `tenant_id` claim.
2. Server-side code continues to use the service role for system writes (audit tables, migration scripts).
3. Read paths that today come from seed files will switch to using the user's session token via the Supabase JS client. Reads will be filtered by RLS automatically.
4. The TEMPORARY fallback clauses are removed (see previous section).

The SELECT policies do not need to change shape at that point — they already check `auth.jwt() ->> 'tenant_id'`. Removing the fallback is the only edit.

---

## Verification

Verification queries are documented in [SETUP.md](../SETUP.md) under section 7. The smoke test confirms:

1. All 8 tables have `rowsecurity = true`.
2. Each tenant_id-bearing table has 3 policies (SELECT, INSERT, UPDATE) and no DELETE policy.
3. An anon-key REST query against `deals` returns the TopSort row (the temporary fallback works).
4. An anon-key REST query against a non-TopSort tenant's data returns empty.
5. Service-role REST queries return all rows from all tenants (the bypass works).

Re-run these tests periodically and after any change to RLS or the auth layer.
