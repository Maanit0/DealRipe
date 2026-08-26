-- =====================================================================
-- The current read on every deal.
--
-- Written once when the evidence changes, then read by everything: the
-- Monday pipeline review, the weekly digest, and the pre-call briefing.
-- Before this, each consumer assembled its own view of a deal and they
-- drifted, which is how a briefing and a digest end up describing the
-- same deal differently in the same week.
--
-- evidence_hash is the point of the table. Regenerating on every read
-- would be 120 model calls per report and a different paragraph each
-- time for a deal where nothing happened. The hash is taken over the
-- assembled evidence lines, which are all dated facts, so it changes
-- when the deal changes and not when the clock moves. Same discipline as
-- lib/snapshot-diff.ts: never treat a field we write ourselves as a fact
-- about the deal.
--
-- Apply by hand:
--   psql "$SUPABASE_DB_URL" -f supabase/add-deal-reads.sql
--
-- Idempotent. Safe to re-run.
-- =====================================================================

begin;

create table if not exists public.deal_reads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  deal_id uuid not null references public.deals(id) on delete cascade,

  -- The read itself. Three sentences, written for a leader.
  text text not null,

  -- Hash of the evidence the read was written from. A caller compares
  -- before spending a model call.
  evidence_hash text not null,

  -- When the evidence last changed, which is NOT when this row was last
  -- touched. A read regenerated because a new call landed is a different
  -- fact from a row re-saved by a backfill, and only the first one means
  -- the deal moved.
  generated_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One current read per deal. History lives in the git of the evidence,
  -- not here: a leader wants what is true now, and a stale read shown
  -- beside a fresh one is worse than no read.
  unique (tenant_id, deal_id)
);

create index if not exists deal_reads_tenant_idx on public.deal_reads (tenant_id);

alter table public.deal_reads enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'deal_reads' and policyname = 'deal_reads_service_all'
  ) then
    create policy deal_reads_service_all on public.deal_reads
      for all using (true) with check (true);
  end if;
end
$$;

comment on column public.deal_reads.evidence_hash is
  'Hash over the dated evidence lines the read was written from. Compared before regenerating, so a deal where nothing happened keeps its paragraph instead of getting a differently worded one each week.';

commit;
