-- =====================================================================
-- What happened to an email after we sent it.
--
-- WHY, measured 2026-08-23:
--
-- DealRipe has delivered 129 briefings and 102 recaps, and EVERY ONE of
-- them carries a Resend provider id on its sent_messages row. Resend
-- emits delivered / opened / clicked / bounced webhooks against exactly
-- that id, and nothing receives them. So the single most important
-- question about the pilot, do the reps actually read this, has a
-- complete data path and no endpoint at the end of it.
--
-- That question decides a renewal. Follow-through rates tell us what a
-- rep DID after a briefing; they cannot separate "read it and ignored
-- it" from "never opened it", and those need completely different
-- responses from us.
--
-- WHAT IS STORED
--
-- The event, the provider id it belongs to, and when. No recipient
-- address (sent_messages already has it), no body, no headers, no IP or
-- user agent. Open tracking is already a weak signal because image
-- proxies fire it, and storing more of the fingerprint would not make it
-- stronger, only more sensitive. Magaya is under NDA.
--
-- ON OPEN TRACKING'S HONESTY, since a reader will ask: an open is
-- evidence the mail was rendered, not that a human read it, and Outlook
-- prefetch inflates it. A NON-open on a delivered message is the more
-- reliable half of the signal, and it is the half we most want.
--
--   psql "$SUPABASE_DB_URL" -f supabase/add-email-events.sql
--
-- Additive and idempotent. Safe to re-run.
-- =====================================================================

begin;

create table if not exists public.email_events (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        references public.tenants(id) on delete cascade,

  -- Resend's message id, which sent_messages.provider_id already holds.
  -- The join key, and the reason no fresh identifier is invented here.
  provider_id  text        not null,

  -- "email.sent", "email.delivered", "email.opened", "email.clicked",
  -- "email.bounced", "email.complained". Stored verbatim rather than
  -- mapped to an enum: Resend can add a type and an unknown value is
  -- worth keeping rather than dropping on the floor.
  event        text        not null,

  -- When RESEND says it happened, not when we received it. A webhook
  -- retried an hour later must not look like an open an hour later.
  occurred_at  timestamptz not null,
  received_at  timestamptz not null default now(),

  created_at   timestamptz not null default now()
);

comment on table public.email_events is
  'Resend delivery and engagement webhooks, keyed to sent_messages.provider_id. Metadata only: no recipient, no body, no user agent. An open means the mail was rendered, not that a human read it; a non-open on a delivered message is the more reliable half.';

-- Resend retries a webhook until it gets a 2xx, so the same event can
-- arrive several times. One row per (message, event, moment).
create unique index if not exists email_events_dedupe
  on public.email_events (provider_id, event, occurred_at);

create index if not exists email_events_provider_idx on public.email_events (provider_id);
create index if not exists email_events_tenant_time_idx on public.email_events (tenant_id, occurred_at desc);

-- Service role only, the same shape as model_runs and deal_messages.
alter table public.email_events enable row level security;

commit;
