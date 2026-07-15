-- Auto-linked deals: which Rolldog opportunity a calendar-created deal was
-- matched to, and how confident the match is. Only 'confirmed' (website domain
-- matched) and 'high' (invite domain == a unique account name) authorize
-- write-back. 'review' / null never write.

alter table public.deals
  add column if not exists rolldog_opportunity_id text,
  add column if not exists rolldog_link_confidence text; -- confirmed | high | review
