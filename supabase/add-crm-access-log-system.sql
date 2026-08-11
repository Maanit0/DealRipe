-- Which CRM did we write to?
--
-- crm_access_log has recorded every write since the Rolldog pilot began, and
-- until now that was unambiguous because Rolldog was the only system we wrote
-- to. Salesforce write-back changes that: lib/salesforce-scope.ts already calls
-- the same emitAudit, so its entries land in this table too, and without a
-- system column the Activity view labels a Salesforce write "Wrote to Rolldog".
--
-- Defaulting existing rows to 'rolldog' is correct rather than convenient. Every
-- row written before 2026-08-11 was a Rolldog write by architectural constraint,
-- recorded above assertScopedWrite in lib/crm-scope.ts.

alter table crm_access_log
  add column if not exists system text not null default 'rolldog';

-- Cheap and worth having: the Activity view filters on tenant, operation and
-- system together, and this table only grows.
create index if not exists crm_access_log_tenant_system_idx
  on crm_access_log (tenant_id, system, created_at desc);

comment on column crm_access_log.system is
  'Which CRM this row describes: rolldog or salesforce. Rows predating the Salesforce write path default to rolldog, which is accurate: no other write path existed.';
