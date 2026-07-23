-- Change-detection for Rolldog write-back, so a re-ingest writes only what
-- genuinely changed instead of either duplicating or being skipped wholesale.
--   dealripe_last_write_hash: hash of the composed notes payloads last written.
--     Unchanged hash + unchanged next step means nothing to write (skip).
--   dealripe_last_next_step: the last next-step text written, so a new next-step
--     activity is created only when the recommendation actually changed.

alter table public.deals
  add column if not exists dealripe_last_write_hash text,
  add column if not exists dealripe_last_next_step text;
