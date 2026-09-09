-- Keep the raw message where it matters, so trimming stops being a one-way door.
--
-- WHY, 2026-09-08, measured rather than assumed.
--
-- supabase/add-message-capture.sql stored bodies TRIMMED and capped, and the
-- reasoning was sound: Outlook quotes the whole thread into every reply, so the
-- median customer message is 11,398 raw characters carrying about 374 of new
-- content, and storing the rest is storing the same text N times across N
-- messages. Across 1,880 bodies that is 40.66M raw characters reduced to 1.01M.
--
-- But the trim is LOSSY IN THREE MEASURED WAYS, and it is not reversible:
--
--   195 messages trimmed to an EMPTY STRING while carrying body_status
--   'stored'. That status is a lie: we hold nothing and claim we hold it.
--
--   160 messages (7.7%) have a raw body over 5,000 characters and a trimmed
--   body under 120. Almost certainly content sitting BELOW a quote boundary,
--   which cutQuotedTail removes wholesale. A rep forwarding a customer's mail
--   with a one-line note above it is exactly this shape.
--
--   body_preview, which add-message-capture.sql described as the safety net for
--   precisely that case, is populated on 0 of 2,075 rows. It comes from the
--   LIST call and the body backfill only ever touched the message endpoint, so
--   it was silently skipped.
--
-- SCOPED TO CUSTOMER-SIDE INBOUND, deliberately, and not to everything. Those
-- 810 messages are what the customer actually said, which is the content the
-- draft, the re-engagement sweep and the stakeholder work all need and cannot
-- reconstruct. Our own outbound is already in sent_messages, and a machine
-- sender's body is a link into a signing session. Storing every raw body would
-- be roughly 40M characters for perhaps 9M of unique information.
--
-- The NDA position does not change: this is the same content from the same
-- messages on the same pilot deals, already mapped by the ingest's own
-- customer-domain filter. What changes is that the trimmer stops being
-- destructive, so a better trimmer can be applied later to text we still have.
--
-- Apply by hand:
--   psql "$SUPABASE_DB_URL" -f supabase/add-message-raw-body.sql
--
-- Additive and idempotent. Safe to re-run.

begin;

alter table public.deal_messages add column if not exists body_raw text;
alter table public.deal_messages add column if not exists body_raw_scope text;

comment on column public.deal_messages.body_raw is
  'The message as Graph returned it, untrimmed. Populated ONLY where body_raw_scope says so, which today means customer-side inbound. NULL means we did not keep the raw text for this row, NEVER that the message was empty: body_status is what says which kind of nothing you have.';

comment on column public.deal_messages.body_raw_scope is
  'Why the raw body was or was not kept. customer_inbound = kept. not_in_scope = deliberately not kept (our own outbound, machine senders, calendar responses). too_large = over the storage ceiling. NULL = the row predates this column and has never been considered, which is an eighth state and a real one.';

-- The backfill and the ingest both walk this.
create index if not exists deal_messages_raw_scope_idx
  on public.deal_messages (tenant_id, body_raw_scope, sent_at desc);

commit;
