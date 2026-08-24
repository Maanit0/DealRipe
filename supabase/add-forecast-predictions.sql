-- DealRipe's own forecast call on a deal, recorded on the day it was made.
--
-- Why this table exists. Every Monday the digest computes where DealRipe
-- disagrees with the rep, and then throws it away. The disagreement is the only
-- thing DealRipe can be scored on that does not require waiting for the learning
-- loop, and it is only scoreable if it was written down BEFORE the deal
-- resolved. A read taken after the close is not a prediction.
--
-- Idempotent on (deal_id, predicted_on): re-running the recorder on the same day
-- updates that day's row rather than adding a second one. Unlike
-- deal_signal_snapshots, the columns here are ones DealRipe asserts rather than
-- ones it observes, so a same-day re-run correcting an assertion is right.

create table if not exists forecast_predictions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  deal_id uuid not null references deals(id) on delete cascade,

  predicted_on date not null,

  -- The two sides of the call, as they stood on predicted_on.
  rep_category text,              -- rolldog forecastCategory, the rep's own band
  dealripe_category text,         -- DealRipe's band from the call evidence
  disagrees boolean not null,     -- the two differ. false rows are agreements,
                                  -- kept because "we agreed and were right" is
                                  -- also evidence and its absence would bias the
                                  -- eventual scoring upward.

  verdict_kind text,              -- confirmed | overstated | risk | lags | none
  verdict_text text,              -- the sentence shown to the leader
  blockers jsonb,                 -- the specific open gaps behind the call

  -- What the deal looked like when the call was made, so the outcome can be
  -- weighted and a pushed close date is visible after the fact.
  annual_value numeric,
  rep_close_date date,
  stage_key text,
  gates_confirmed int,
  rep_email text,
  account text,

  -- Filled in later by the scorer, once the deal resolves. Never written here.
  resolved_at timestamptz,
  outcome_label text,             -- won | lost, from deals.outcome_label
  outcome_close_date date,
  dealripe_was_right boolean,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (deal_id, predicted_on)
);

create index if not exists forecast_predictions_tenant_date_idx
  on forecast_predictions (tenant_id, predicted_on desc);
create index if not exists forecast_predictions_unresolved_idx
  on forecast_predictions (tenant_id, resolved_at) where resolved_at is null;
