-- When DealRipe last wrote back to the deal's CRM record. Used to attribute
-- the CRM's updated-at away from DealRipe's own writes, so the "rep last
-- activity" signal stays a true rep signal (see lib/rolldog-summary.ts
-- repLastActivityIso). Null until DealRipe has written back to the deal.

alter table public.deals
  add column if not exists dealripe_last_writeback_at timestamptz;
