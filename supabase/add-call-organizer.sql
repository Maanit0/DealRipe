-- Who organized the meeting.
--
-- Microsoft Graph already returns this on every event and calendar-sync already
-- parses it into NormalizedMeeting.organizerEmail. It was then discarded,
-- because there was nowhere to put it.
--
-- It turned out to be the field that decides what to do about lost calls. Over
-- 2026-08-07 to 08-13, ten of sixty-three meetings were never captured, and nine
-- of those were bots that reached the waiting room and were never admitted. The
-- fix depends entirely on whose waiting room it was:
--
--   organizer at magaya.com  -> Magaya's own lobby. A Teams policy change admits
--                               the bot for every rep at once and requires
--                               nobody to remember anything.
--   organizer elsewhere      -> the customer's lobby. Magaya cannot configure it,
--                               and the person who sees "DealRipe Notetaker"
--                               waiting outside has never heard of DealRipe.
--
-- Those are opposite fixes and there was no way to tell them apart, which is why
-- the eight historical failures can only be resolved by asking the reps.
--
-- Null means the organizer was not recorded: either the row predates this column
-- or Graph returned no organizer. It does NOT mean the meeting had no organizer,
-- and anything reading this column should keep those apart.
--
-- Apply in the Supabase SQL editor once.

alter table public.calls
  add column if not exists organizer_email text;

comment on column public.calls.organizer_email is
  'Meeting organizer address from Microsoft Graph, captured at schedule time. Determines whose waiting room a bot lands in. Null = not recorded (pre-dates the column, or Graph gave none), not "no organizer".';
