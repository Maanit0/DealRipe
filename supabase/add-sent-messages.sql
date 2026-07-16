-- Sent communications archive.
--
-- Pre-call briefings and post-call recaps are rendered and emailed to the rep,
-- but the rendered copy was never stored, so there was no way to see exactly
-- what a rep received. This table keeps the exact sent message (subject + the
-- html and text bodies) so it can be shown on the deal page and audited later.
--
-- One row per send. Written best-effort right after the email goes out; a
-- failure to record never affects the send. Reference only; drives no logic.
--
-- Apply in the Supabase SQL editor once.

create table if not exists public.sent_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  deal_id uuid not null references public.deals (id) on delete cascade,
  call_id uuid references public.calls (id) on delete set null,
  kind text not null,              -- 'briefing' | 'recap'
  to_email text not null,
  subject text not null,
  body_html text not null,
  body_text text not null,
  provider_id text,                -- Resend message id, when available
  sent_at timestamptz not null default now()
);

create index if not exists sent_messages_deal_idx
  on public.sent_messages (deal_id, sent_at desc);

create index if not exists sent_messages_tenant_idx
  on public.sent_messages (tenant_id);

comment on table public.sent_messages is
  'Exact briefings and recaps emailed to reps, stored at send time for the deal page and auditing. Reference only.';
