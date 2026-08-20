-- =====================================================================
-- The email event log.
--
-- WHY, measured 2026-08-20:
--
-- DealRipe already reads the mailbox. lib/graph-mail.ts holds
-- listMailboxMessages and getMessageBody, and three callers use them:
-- readPostCallCustomerMail, the follow-up reply-thread lookup, and the
-- commitment-evidence pass in prescription-scoring. Not one of them
-- persists a single inbound message. Every read is per-call,
-- window-scoped, used once and discarded.
--
-- So today "the customer has gone quiet" and "we have no email log" are
-- the same absence, and the deal read says so out loud on every stalling
-- verdict: ten deals are currently flagged as losing momentum with the
-- caveat "this counts calls only, the customer may have been in touch."
-- That caveat is what this table removes.
--
-- It also fixes a documented scoring error. CLAUDE.md: an end commitment
-- is usually secured after the call, in writing. The first scoring run
-- found 21 commitments and exactly one proposed out loud, with seven of
-- the remaining twenty followed by mail from the rep. Scoring from the
-- transcript alone records reps who did the work as reps who did nothing.
--
-- WHAT IS DELIBERATELY NOT STORED: the body.
--
-- Magaya is under NDA, and MS_CLIENT_SECRET is effectively a tenant-wide
-- mailbox key because the Application Access Policy was declined, so the
-- only thing keeping DealRipe out of ~45,000 mailboxes is allowedMailboxes()
-- in software. Metadata answers every signal this log exists for: who wrote,
-- to whom, when, on which thread. A body is fetched on demand by
-- getMessageBody when a specific claim needs evidence, and is not retained.
-- Storing bodies would raise the cost of getting that gate wrong by orders
-- of magnitude for no signal we cannot already compute.
--
-- Subject IS stored: calendar-response detection needs it, and a rep
-- cannot recognise a thread without it.
--
-- Apply by hand:
--   psql "$SUPABASE_DB_URL" -f supabase/add-deal-messages.sql
--
-- Additive and idempotent. Safe to re-run.
-- =====================================================================

begin;

create table if not exists public.deal_messages (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references public.tenants(id) on delete cascade,
  deal_id           uuid        not null references public.deals(id)   on delete cascade,

  -- Graph's per-message id is per-MAILBOX, the same trap as calendar events
  -- (iCalUId is stable across mailboxes, id is not). A co-sold thread sitting
  -- in two reps' mailboxes would otherwise store as two unrelated rows and be
  -- counted twice. internet_message_id is the RFC 5322 Message-ID and IS
  -- stable across mailboxes, so it is the dedupe key and graph_message_id is
  -- kept only to fetch the body later.
  internet_message_id text      not null,
  graph_message_id  text        not null,
  mailbox           text        not null,

  -- Graph's thread key. Groups a reply chain without parsing References.
  conversation_id   text,

  direction         text        not null check (direction in ('inbound', 'outbound')),
  from_email        text,
  from_domain       text,
  to_emails         text[]      not null default '{}',
  cc_emails         text[]      not null default '{}',
  subject           text,
  sent_at           timestamptz,

  -- "Accepted:", "Declined:", "Tentative:" and the like. These are calendar
  -- machinery, not a human replying, and counting one as customer engagement
  -- would turn an auto-response into a signal of life.
  is_calendar_response boolean   not null default false,

  -- True when from_domain belongs to the customer rather than to the seller.
  -- Stored rather than derived at read time because the seller's own domain
  -- is tenant configuration and will change per customer.
  customer_side     boolean     not null default false,

  first_seen_at     timestamptz not null default now(),

  unique (tenant_id, internet_message_id, deal_id)
);

comment on table public.deal_messages is
  'Email metadata per deal. Bodies are deliberately never stored: Magaya is under NDA and the Graph app-only grant covers every mailbox in the tenant, so the log holds only what the signals need. Fetch a body on demand with getMessageBody when a specific claim needs evidence.';

comment on column public.deal_messages.internet_message_id is
  'RFC 5322 Message-ID, stable across mailboxes. The dedupe key, because Graph''s own message id is per-mailbox and a co-sold thread would otherwise be counted once per rep.';

comment on column public.deal_messages.is_calendar_response is
  'An "Accepted:" or "Declined:" auto-response. Excluded from every engagement signal: a calendar client answering is not a customer replying.';

comment on column public.deal_messages.customer_side is
  'Whether the sender is the customer rather than the seller. The whole point of the log is measuring what the BUYER did, and an outbound thread with no reply is the signal, not the noise.';

-- Reads are "the most recent customer message on this deal" and "everything
-- on this deal since a date", so both go through (deal_id, sent_at).
create index if not exists deal_messages_deal_sent_idx
  on public.deal_messages (deal_id, sent_at desc);

create index if not exists deal_messages_tenant_sent_idx
  on public.deal_messages (tenant_id, sent_at desc);

-- ---------------------------------------------------------------------
-- RLS: same tenant-keyed shape as every other table.
-- ---------------------------------------------------------------------

alter table public.deal_messages enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'deal_messages' and policyname = 'deal_messages_select'
  ) then
    create policy deal_messages_select on public.deal_messages
      for select using (
        tenant_id in (select tenant_id from public.app_users where user_id = auth.uid())
      );
  end if;
end
$$;

commit;
