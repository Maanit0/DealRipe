-- =====================================================================
-- A third prescription source: 'reengage'.
--
-- WHY
--
-- prescribed_actions answers "what did DealRipe tell the rep to do, did
-- they do it, and what did the buyer do next". Until now every row came
-- from a briefing or a recap, so every row was triggered by a CALL.
--
-- lib/reengage-draft.ts issues instructions with no call behind them.
-- It fires when a flag says a deal has gone quiet, which is a trigger on
-- the ABSENCE of an event rather than on one. Those instructions are
-- prescriptions in exactly the sense this table means: DealRipe told a
-- rep to do a specific thing on a specific deal at a specific moment,
-- and whether they did it and what followed is measurable.
--
-- Recording them anywhere else would split the action-outcome dataset,
-- which is the asset. Two tables meaning the same thing is how the next
-- session writes to the wrong one, and this file's sibling migration
-- says so in its own header.
--
-- WHICH CALL A REENGAGE ROW POINTS AT
--
-- call_id is NOT NULL, deliberately: a prescription with no call cannot
-- be scored. A re-engagement has no call of its own, so it is attached
-- to the LAST CAPTURED CALL on the deal, which is not a workaround. The
-- silence is measured from that call, the draft is grounded in what that
-- call established, and scoring asks what happened after it. A deal with
-- no captured call gets no re-engagement prescription, which is correct:
-- there is nothing to ground one in.
--
--   psql "$SUPABASE_DB_URL" -f supabase/add-reengage-source.sql
--
-- Idempotent. Safe to re-run.
-- =====================================================================

begin;

do $$
begin
  if not exists (
    select 1
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
     where t.typname = 'prescription_source'
       and e.enumlabel = 'reengage'
  ) then
    alter type public.prescription_source add value 'reengage';
  end if;
end
$$;

commit;

-- A comment, so the next reader does not have to infer the asymmetry.
comment on column public.prescribed_actions.source is
  'Which surface issued the instruction. briefing and recap are triggered by a call. reengage is triggered by a flag firing on silence and carries the deal''s LAST captured call in call_id, because that is what the silence is measured from and what the draft is grounded in.';
