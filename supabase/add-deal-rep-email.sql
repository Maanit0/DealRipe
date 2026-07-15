-- The rep whose calendar a deal belongs to. Set on auto-created deals (from
-- the calendar auto-join) so post-call recaps and briefings route to the right
-- rep even when the deal isn't in the hand-maintained PILOT_REP_EMAILS map.
-- Null for the original hand-seeded pilot deals (they route via pilot-config).

alter table public.deals
  add column if not exists rep_email text;
