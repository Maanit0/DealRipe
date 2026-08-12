-- What did we try, and what came back?
--
-- Until now nothing recorded a link attempt. rolldog-relink computed
-- confirmed/review/none per run, returned it in an HTTP response, and threw it
-- away. So the database could not tell these apart:
--
--   we searched Rolldog for this customer and it genuinely is not there
--   we never searched, because the deal had no captured call yet
--   we searched and Rolldog was down
--
-- All three looked identical: a deal with no rolldog_opportunity_id. On
-- 2026-08-11 three of Ariel Rodriguez's deals reported "no Rolldog opportunity
-- on this deal", which read as a fact about Rolldog and was actually a fact
-- about our own deal row. Nobody had looked.
--
-- One row per deal per system. `status` is the outcome, and `unavailable` is
-- deliberately not the same as `no_candidates`: absence of evidence is not
-- evidence of absence, and this table exists so the difference survives.
--
-- `queries` records the search terms actually sent, so a miss can be judged
-- ("did we even try the right name?") rather than trusted.

create table if not exists deal_link_attempts (
  deal_id uuid not null,
  system text not null check (system in ('rolldog', 'salesforce')),
  status text not null check (status in ('linked', 'needs_decision', 'no_candidates', 'unavailable')),
  candidates jsonb,
  queries jsonb,
  note text,
  searched_at timestamptz not null default now(),
  primary key (deal_id, system)
);

create index if not exists deal_link_attempts_status_idx
  on deal_link_attempts (status, searched_at desc);

alter table deal_link_attempts enable row level security;

comment on table deal_link_attempts is
  'One row per deal per CRM recording the last link attempt: what was searched, what came back, and whether we got an answer at all. Service role only.';
comment on column deal_link_attempts.status is
  'linked = a confident match was stored. needs_decision = candidates found, only a human should choose. no_candidates = the CRM answered and had nothing. unavailable = we could not ask, which is NOT the same as nothing existing.';
comment on column deal_link_attempts.queries is
  'The search terms actually sent. A miss is only meaningful if you can see what was asked.';
