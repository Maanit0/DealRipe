-- Outcome detail for the learning loop.
--
-- outcome_label alone says won or lost. It does not say WHICH opportunity was
-- read, when it closed, or why it was lost, so nothing downstream can check
-- the label or learn from it. Loss_Reason__c in particular is a far richer
-- signal than the boolean: Magaya's losses are dominated by
-- "No Decision / Non-Responsive", which is a different problem from
-- "Lost to Competitor" and wants a different play.
--
-- Additive and idempotent. Safe to run more than once.

alter table deals add column if not exists outcome_opportunity_id text;
alter table deals add column if not exists outcome_close_date date;
alter table deals add column if not exists outcome_reason text;
alter table deals add column if not exists outcome_amount numeric;

comment on column deals.outcome_opportunity_id is
  'Salesforce Opportunity id the outcome_label was read from. Lets anything downstream re-verify the label instead of trusting it.';
comment on column deals.outcome_close_date is
  'CloseDate of that opportunity. Always on or after the deal''s first captured call; older closes are the account''s history, not this deal''s outcome.';
comment on column deals.outcome_reason is
  'Opportunity.Loss_Reason__c as recorded by the rep. Null means not read or not set, never "no reason".';
comment on column deals.outcome_amount is
  'Opportunity.Amount at close, for weighting the learning loop.';
