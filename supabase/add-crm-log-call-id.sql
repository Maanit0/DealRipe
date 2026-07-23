-- Hard-link Rolldog write-back audit rows to the call they belong to, so the
-- activity log ties a CRM write to its meeting by id instead of nearest-in-time.
-- Nullable: reads and legacy rows have no call context. ON DELETE SET NULL so
-- deleting a call never removes the security audit trail.

alter table public.crm_access_log
  add column if not exists call_id uuid references public.calls(id) on delete set null;

create index if not exists crm_access_log_call_id_idx on public.crm_access_log (call_id);
