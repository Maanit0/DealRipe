-- Which document actually went out, and whether it was ours or theirs.
--
-- WHY, 2026-09-08.
--
-- 260 messages across 41 deals mention a proposal, quote or pricing, and no
-- document exists anywhere in the ledger. "The proposal was sent" is a subject
-- line. lib/deal-memory.ts renders the rep's sent items with the hedge
-- "Subjects only, so a file may have ridden on any of them", and SentItem
-- carries an attachments array that has been hardcoded to [] since it was
-- written.
--
-- lib/graph-mail.ts listMessageAttachments has existed since this morning with
-- zero callers, and findSentAttachments before it. Same shape as
-- OpportunityFieldHistory and the Rolldog activities: the read path exists and
-- the result is discarded.
--
-- TWO CATEGORIES, BY LIFECYCLE AND NOT BY NAME.
--
-- Magaya sends two very different kinds of file. Stock collateral (the rates
-- solution sheet, the supply chain data sheet, the brochure) is identical
-- across every deal and already lives in assets/collateral. A proposal, a
-- storyboard deck or an executed agreement is built for ONE customer and exists
-- nowhere else. Losing the first costs nothing; losing the second loses the
-- artifact.
--
-- lib/magaya-collateral.ts already distinguishes them for the OUTBOUND draft
-- path, with an incident behind it: a draft naming "Magaya Supply Chain Demo
-- Deck - Dunavant 2026-08-27.pptx" nearly had the generic Supply Chain Data
-- Sheet attached to it. Those same patterns classify here.
--
-- THE NDA IS BOTH, AND THAT IS THE SUBTLETY. The template is stock; the
-- executed copy is a customer artifact. Same filename, different lifecycle
-- stage, and deal_messages.agreement_state already tells them apart via Adobe
-- Sign's "Completed:" prefix. So classification is (name pattern) x (agreement
-- state), never name alone.
--
-- artifact_blobs IS CONTENT-ADDRESSED AND storage_path NULL IS MEANINGFUL: it
-- says we know the file and deliberately hold no copy. Juan sent the Supply
-- Chain Data Sheet 23 times; that is one blob row with a null path and 23
-- attachment rows, not 23 copies.
--
-- NO BYTES ARE STORED BY THIS MIGRATION. Metadata answers "was the proposal
-- actually sent, and when", which is the question. Retaining the files needs a
-- private Supabase Storage bucket that does not exist yet, and creating one is
-- a manual step with a default (public: true) that would put customer proposals
-- on a guessable URL. Deliberately not done in passing.
--
-- Apply by hand:
--   psql "$SUPABASE_DB_URL" -f supabase/add-deal-attachments.sql
--
-- Additive and idempotent. Safe to re-run.

begin;

create table if not exists public.artifact_blobs (
  content_sha256 text primary key,
  size_bytes integer,
  content_type text,
  -- NULL means we know this file and deliberately keep no copy of it.
  storage_path text,
  is_stock_collateral boolean not null default false,
  collateral_file text,
  first_seen_at timestamptz not null default now()
);

comment on table public.artifact_blobs is
  'One row per distinct file, keyed by content hash. Juan sent the same data sheet 23 times: that is one row here and 23 in deal_attachments.';

comment on column public.artifact_blobs.storage_path is
  'NULL means we hold no copy, DELIBERATELY. It is not a missing value and not a failed upload: stock collateral already lives in assets/collateral and does not need storing again.';

create table if not exists public.deal_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  deal_id uuid references public.deals (id) on delete set null,
  message_id uuid not null references public.deal_messages (id) on delete cascade,

  direction text,
  filename text not null,
  content_type text,
  size_bytes integer,
  is_inline boolean not null default false,

  classification text,
  classification_basis text,
  content_sha256 text references public.artifact_blobs (content_sha256) on delete set null,
  storage_status text,

  graph_attachment_id text,
  mailbox text,
  first_seen_at timestamptz not null default now()
);

comment on table public.deal_attachments is
  'One row per file on one message. The answer to "did the proposal actually go out, and when".';

comment on column public.deal_attachments.is_inline is
  'TRUE for a signature logo and other cid: furniture. Every rep here has an HTML signature, so hasAttachments is true on almost everything they send: without this, "the rep sent a document" fires on most of the book and is not a flag.';

comment on column public.deal_attachments.classification is
  'static = stock collateral, identical across deals, already in assets/collateral. customized = built for this customer and existing nowhere else, which is the one worth keeping. unclassified = we abstain, and an outbound unclassified file is still treated as worth keeping because losing a unique artifact costs more than keeping a spare brochure. NULL means not yet classified.';

comment on column public.deal_attachments.classification_basis is
  'WHY it was classified that way: collateral_hash, datasheet_pattern, nda_template, customer_specific_pattern, or abstained. Recorded so a wrong call is debuggable rather than mysterious.';

comment on column public.deal_attachments.storage_status is
  'pointer = the bytes are the same as a file we already hold. skipped_static = stock collateral, not stored. not_fetched = eligible, bytes not pulled. too_large = over the ceiling, metadata kept. unavailable = the attachment read failed, which is NOT the same as no attachment. NULL = bytes were never in scope.';

create index if not exists deal_attachments_deal_idx
  on public.deal_attachments (deal_id, first_seen_at);

create index if not exists deal_attachments_message_idx
  on public.deal_attachments (message_id);

create index if not exists deal_attachments_class_idx
  on public.deal_attachments (tenant_id, classification);

-- Idempotency: one row per attachment per message.
create unique index if not exists deal_attachments_once
  on public.deal_attachments (message_id, graph_attachment_id);

alter table public.artifact_blobs enable row level security;
alter table public.deal_attachments enable row level security;

drop policy if exists artifact_blobs_service on public.artifact_blobs;
create policy artifact_blobs_service on public.artifact_blobs
  for all to service_role using (true) with check (true);

drop policy if exists deal_attachments_service on public.deal_attachments;
create policy deal_attachments_service on public.deal_attachments
  for all to service_role using (true) with check (true);

commit;
