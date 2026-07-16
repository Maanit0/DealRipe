-- Call outcome.
--
-- A bot can join a meeting that produces no substantive conversation: a
-- customer no-show, or a placeholder hold that never became a real meeting
-- (everyone leaves within seconds, empty transcript). Previously such a call
-- either errored quietly or, once its row was pruned, vanished entirely, so an
-- active deal looked untouched. This column records the call's outcome so the
-- UI can show it honestly and forecasting can treat it as signal.
--
--   null              -> not processed yet (in progress)
--   'captured'        -> real conversation, extracted
--   'no_conversation' -> bot joined, no substantive content (system-detected)
--   'no_show'         -> rep-confirmed: customer did not show
--   'rescheduled'     -> rep-confirmed: moved to another time
--   'placeholder'     -> rep-confirmed: never a real meeting
--
-- Apply in the Supabase SQL editor once.

alter table public.calls
  add column if not exists outcome text;

comment on column public.calls.outcome is
  'Call outcome: captured | no_conversation | no_show | rescheduled | placeholder. Null = not processed. Set by transcript-sync; the no_* refinements are rep-classified.';
