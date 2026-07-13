-- Mark's day-0 read (CRO baseline) per deal. His gut call captured at pilot
-- start, held so we can compare it against what DealRipe surfaces at day 30.
-- One row per deal (editable). Reference only; never drives any logic.

create table if not exists public.deal_cro_read (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  deal_id uuid not null references public.deals (id) on delete cascade,
  forecast_category text,          -- Commit | Expect | Pipeline
  win_probability int,             -- 0-100
  expected_close text,             -- free text, e.g. "September 2026"
  economic_buyer_engaged text,     -- Yes | No | Not sure
  biggest_unknown text,
  notes text,
  updated_at timestamptz not null default now(),
  unique (deal_id)
);

create index if not exists deal_cro_read_tenant_idx
  on public.deal_cro_read (tenant_id);
