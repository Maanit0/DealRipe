-- Pre-call briefing dedupe marker.
--
-- The briefing-sync cron scans upcoming pilot meetings and emails the rep a
-- briefing ~30 minutes before each call. This column records that a briefing
-- was already sent for a given call so the every-5-minute cron never sends a
-- duplicate.
--
-- Apply in the Supabase SQL editor once.

alter table public.calls
  add column if not exists briefing_sent_at timestamptz;

comment on column public.calls.briefing_sent_at is
  'When the pre-call briefing email was sent for this call. Null = not yet sent. Set by briefing-sync.';
