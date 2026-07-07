-- Meeting start timestamp on the call row.
--
-- calendar-sync stores call_date (date only). To show the exact upcoming
-- meeting time and compute when the pre-call briefing will send (~30 min
-- before), we need the full start timestamp. Populated by calendar-sync.
--
-- Apply in the Supabase SQL editor once.

alter table public.calls
  add column if not exists scheduled_start timestamptz;

comment on column public.calls.scheduled_start is
  'Meeting start (UTC) from the calendar. Used to show the next call time and '
  'the pre-call briefing send time. Set by calendar-sync.';
