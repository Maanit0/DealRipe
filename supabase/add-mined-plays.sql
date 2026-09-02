-- The mined motion: what the reps actually did, kept where the transcripts
-- already are.
--
-- This started life as a generated TypeScript module so a human could read the
-- diff before any of it reached a briefing. That was wrong and the reason is
-- one line of CLAUDE.md: Magaya is under NDA, and customer transcripts and
-- generated previews stay local and are never committed. 114 verbatim quotes
-- from real calls across 38 named accounts is call content, whoever is
-- speaking, and a git repository is a new place for it to exist. Supabase
-- already holds the transcripts these are derived from, so this adds no
-- exposure that is not already there.
--
-- The review step survives the move and gets stronger: nothing is readable by
-- a briefing until approved is true, which is a deliberate act by a person
-- rather than a diff that can be waved through.
--
-- Safe to re-run.

create table if not exists public.mined_plays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  kind text not null,
  quote text not null,
  doing text not null,
  speaker text not null,
  rep text,
  account text,
  stage text,
  call_date date,
  -- CONTEXT, NEVER CAUSE. The stage moved after this move; nothing holds
  -- anything constant and one call is one of several.
  preceded_advance boolean not null default false,
  next_meeting_in_a_week boolean not null default false,
  -- Off until a person says otherwise. These sentences reach a briefing a rep
  -- reads aloud to a customer.
  approved boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- A STORED COLUMN rather than a unique index on md5(quote) directly.
  -- PostgREST's on_conflict takes column names and not expressions, so an
  -- expression index cannot be named as the conflict target and the upsert in
  -- scripts/mine-plays.ts would fail at runtime against a schema that looks
  -- correct in psql.
  quote_hash text generated always as (md5(quote)) stored
);

-- Re-running the miner over an overlapping window must not duplicate a move.
-- Keyed on the quote itself, since that is what identifies it: the same
-- sentence re-mined is the same move, and its outcome columns may have moved on.
create unique index if not exists mined_plays_tenant_quote_uniq
  on public.mined_plays (tenant_id, quote_hash);

create index if not exists mined_plays_lookup_idx
  on public.mined_plays (tenant_id, approved, stage);

comment on table public.mined_plays is
  'Seller moves mined from captured transcripts by scripts/mine-plays.ts. Read by lib/mined-plays.ts into the briefing prompt, and only where approved is true. Contains verbatim call content: never export this table into the repository.';
