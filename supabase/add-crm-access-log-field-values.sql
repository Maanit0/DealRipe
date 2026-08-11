-- What did we actually write, not just which fields.
--
-- crm_access_log.fields holds field NAMES. For Rolldog that was survivable
-- because the Activity view re-composes the content from the deal to show what
-- went in. That re-composition is not a record of the write, though: it shows
-- what we WOULD write now, so it drifts as the deal changes, and it cannot
-- explain a write that happened three weeks ago.
--
-- For Salesforce it is worse. The scope token is the single coarse value
-- 'sales_development', so `fields` says nothing at all about which Account
-- fields were touched.
--
-- field_values records the labels and the values at the moment of the write,
-- which is what an audit is for.
--
-- Shape: [{"label": "Business Issues", "value": "...", "mode": "fill_blank"}]
-- Nullable, because reads and refusals have no values, and every row written
-- before this column existed has none.

alter table crm_access_log
  add column if not exists field_values jsonb;

comment on column crm_access_log.field_values is
  'Labels and values actually written, captured at write time. Null for reads, refusals, and rows predating this column. Not a substitute for fields, which records the scope token the assert checked.';
