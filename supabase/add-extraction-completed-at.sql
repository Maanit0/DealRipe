-- When extraction actually finished for a call.
--
-- calls.has_been_extracted cannot answer this, and that is by design rather
-- than by accident. transcript-sync sets it BEFORE running extraction, so the
-- transcript body is durable and the call stops being re-polled even if
-- extraction then fails. It means "the body is safe", not "the fields exist".
--
-- Two different facts were sharing one column, and recap-sync read the wrong
-- one. It filters on has_been_extracted, so it can pick a call up in the gap
-- between the mark and the rows landing. Mohawk Global is what that produced:
-- ten fields captured and correctly attributed to the call, and a recap that
-- told the rep "Nothing new was captured on this call". The readout was rich,
-- because it only needs the transcript. The audit was empty, which is the half
-- a rep checks against their CRM.
--
-- Without this column the only way to tell "extraction has not run" from
-- "extraction ran and found nothing" is the call's age, which is a guess on a
-- path that emails reps.
--
-- Null means extraction has not completed. It does NOT mean it found nothing.
--
-- Apply in the Supabase SQL editor once.

alter table public.calls
  add column if not exists extraction_completed_at timestamptz;

comment on column public.calls.extraction_completed_at is
  'When field extraction finished for this call. Null means it has not completed, which is different from having run and found nothing. Distinct from has_been_extracted, which is set BEFORE extraction as a durability marker so the call is not re-polled.';

create index if not exists calls_extraction_pending_idx
  on public.calls (tenant_id, scheduled_start)
  where extraction_completed_at is null;
