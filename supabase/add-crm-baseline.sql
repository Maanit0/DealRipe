-- Day-0 CRM baseline: a frozen snapshot of what the connected CRM (Rolldog)
-- reported for a pilot deal at pilot start. This is the "before" picture used
-- to (a) benchmark DealRipe's captured state against over the pilot and
-- (b) seed first-call briefings with reported-but-unverified context.
--
-- IMPORTANT: this is reference only. It never marks a SQL gate as confirmed.
-- The verified ledger lives in field_extractions and fills only from calls.
--
-- One row per deal (the day-0 freeze). Re-running the capture upserts.

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
