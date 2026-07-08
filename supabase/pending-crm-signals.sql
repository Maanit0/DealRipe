-- Pending migrations as of 2026-07-07. Safe to run as one paste in the
-- Supabase SQL editor; both statements are idempotent (IF NOT EXISTS).
--
-- 1) deals.dealripe_last_writeback_at
--    When DealRipe last wrote back to the deal's CRM record. Lets the
--    "Rep last activity" signal attribute Rolldog's updated-at away from
--    DealRipe's own writes so it stays a true rep signal.
--    (see lib/rolldog-summary.ts repLastActivityIso)
--
-- 2) deal_crm_baseline
--    Frozen day-0 snapshot of what the CRM reported at pilot start. Reference
--    only: it never marks a SQL gate confirmed. The verified ledger lives in
--    field_extractions and fills only from captured calls.

alter table public.deals
  add column if not exists dealripe_last_writeback_at timestamptz;

create table if not exists public.deal_crm_baseline (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  deal_id uuid not null references public.deals (id) on delete cascade,
  rolldog_opportunity_id text,
  captured_at timestamptz not null default now(),
  payload jsonb not null,
  unique (deal_id)
);

create index if not exists deal_crm_baseline_tenant_idx
  on public.deal_crm_baseline (tenant_id);
