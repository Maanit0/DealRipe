-- One access token per credential, shared across serverless invocations.
--
-- lib/rolldog.ts caches its token in a module-level variable. That is correct
-- inside a process and useless between them: every Vercel cron invocation, every
-- cold page render of /pipeline or /deals/[id], and every `npx tsx scripts/...`
-- run starts with an empty cache and asks Rolldog for a new token. Rolldog
-- flagged this on 2026-08-11 (125 token requests in a day) and said they will
-- begin enforcing a daily limit.
--
-- Rolldog tokens live 24 hours, so the right number of requests per day is
-- roughly one. This table is where that one token lives.
--
-- Storing a bearer token in the pilot database is a deliberate tradeoff and the
-- reason RLS is enabled with no policies: only the service role key can read
-- this table, the same key that already holds every credential these jobs use.
-- A leaked row is worth at most the remainder of a 24 hour window, and rotating
-- ROLLDOG_CLIENT_SECRET invalidates it immediately. It is never logged.
--
-- `key` is namespaced by a hash of client id, audience and OAuth URL, so
-- rotating a credential or pointing at a sandbox cannot serve a stale token
-- minted for a different one.

create table if not exists crm_token_cache (
  key text primary key,
  token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table crm_token_cache enable row level security;

comment on table crm_token_cache is
  'Shared OAuth access tokens so serverless invocations reuse one token instead of minting one each. Service role only: RLS is on and no policies exist by design.';
comment on column crm_token_cache.key is
  'Namespace plus a hash of the credential that minted the token, so a rotated client id or a different audience never reuses this row.';
