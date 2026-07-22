-- Call title + sub-type.
--
-- Two additions to the calls table so the Meetings view can show what a meeting
-- was and what it was about:
--
--   title        -> the calendar event subject captured at schedule time
--                   (e.g. "Maanit / Venkat: DealRipe Progress"). Null for calls
--                   that predate this column or had no subject.
--
--   call_subtype -> the purpose of the call, classified from the transcript and
--                   cross-checked against the deal's stage. Values:
--                     'discovery'   -> a first/early fact-finding call
--                     'demo'        -> a product demo or presentation
--                     'proposal'    -> proposal / pricing / negotiation
--                     'follow_up'   -> a follow-up / check-in on an opportunity
--                     'customer'    -> existing-customer meeting (not an opp)
--                     'internal'    -> internal / team meeting
--                   Null = not yet classified. Set by transcript-sync.
--
-- Apply in the Supabase SQL editor once.

alter table public.calls
  add column if not exists title text,
  add column if not exists call_subtype text;

comment on column public.calls.title is
  'Calendar event subject captured at schedule time. Null if unknown.';
comment on column public.calls.call_subtype is
  'Call purpose: discovery | demo | proposal | follow_up | customer | internal. Null = unclassified. Set by transcript-sync.';
