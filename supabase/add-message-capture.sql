-- What the email actually SAID, whether a document is signed, and whether a
-- file rode along.
--
-- WHY THIS EXISTS, 2026-09-08, AND WHAT IT REVERSES.
--
-- supabase/add-deal-messages.sql states plainly that bodies are never stored,
-- and that was the right call at the time for the right reason: Magaya is under
-- NDA, the Application Access Policy was declined so MS_CLIENT_SECRET is
-- effectively a tenant-wide mailbox key, and allowedMailboxes() in software is
-- the only boundary there is. None of that has changed.
--
-- What changed is what the metadata costs us. lib/deal-memory.ts opens with ten
-- draft-versus-sent pairs where the rep held something DealRipe did not: "a EULA
-- and a corrected proposal, we did not know they existed". Subjects and dates
-- cannot answer what was promised, what was asked and never answered, or which
-- document went out. The follow-up draft, the re-engagement sweep and the
-- stakeholder trajectory all need the message, and all three currently guess.
--
-- So this is a risk being ACCEPTED, deliberately and with mitigations, not an
-- oversight being corrected:
--
--   * Only messages the ingest has ALREADY mapped to a pilot deal through its
--     own customer-domain filter. Nothing else is fetched or stored.
--   * Never for machine senders. EchoSign notification bodies carry links into
--     a signing session, and is_machine_sender is computed here anyway.
--   * TRIMMED, not raw. Quoted history, signatures and the external-sender
--     banner are cut by lib/mail-body.ts before storage, and body_chars records
--     the original length so truncation is always visible rather than being
--     indistinguishable from a short email.
--   * Capped at 4000 characters. Generous enough that a later consumer can
--     re-trim to 700 without re-fetching, because Graph will eventually 404 the
--     message and then the body is gone for good.
--
-- WHY body_status HAS SEVEN VALUES. getMessageBody used to collapse a 404, a
-- 503 and a genuinely empty body into one null. That was harmless while a body
-- was fetched, used once and discarded; stored, all three become the same NULL
-- column and a backfill either retries dead ids forever or abandons rows it
-- could still read. lib/graph-mail.ts readMessageBody now distinguishes them and
-- this column keeps the distinction. NULL means the row predates this migration
-- and has never been considered, which is an eighth state and a real one.
--
-- WHY agreement_kind AND agreement_state ARE TWO COLUMNS. A single nullable
-- boolean would mean both "not an agreement" and "an agreement whose state we
-- do not know". Same reason the checklist needed a read-status table.
--
-- WHY THERE IS NO attachment_names COLUMN. deal_attachments.filename is the one
-- source. A denormalised copy beside it is two sources of one fact, and this
-- codebase has a specific history of the copy drifting and being believed.
--
-- BACKFILL DOES NOT COME FREE. lib/email-log.ts upserts with
-- ignoreDuplicates:true, so a re-run will never populate these on the ~1900
-- existing rows, and flipping to a real upsert would rewrite direction,
-- customer_side, subject and graph_message_id using today's rules. Every
-- backfill is a targeted update by primary key touching only these columns.
--
-- RLS is inherited: deal_messages already has row level security enabled with
-- no policy, so the service role is the only reader and nothing changes here.
--
-- Apply by hand:
--   psql "$SUPABASE_DB_URL" -f supabase/add-message-capture.sql
--
-- Additive and idempotent. Safe to re-run.

begin;

alter table public.deal_messages add column if not exists body_preview text;
alter table public.deal_messages add column if not exists body_trimmed text;
alter table public.deal_messages add column if not exists body_chars integer;
alter table public.deal_messages add column if not exists body_status text;
alter table public.deal_messages add column if not exists body_fetched_at timestamptz;

alter table public.deal_messages add column if not exists agreement_kind text;
alter table public.deal_messages add column if not exists agreement_state text;
alter table public.deal_messages add column if not exists is_machine_sender boolean not null default false;

alter table public.deal_messages add column if not exists has_attachments boolean;
alter table public.deal_messages add column if not exists attachment_status text;

comment on column public.deal_messages.body_preview is
  'Graph bodyPreview, roughly the first 255 characters of the RAW body. Already on the wire in MESSAGE_SELECT and previously discarded, so it costs nothing. Kept as a safety net for the one case trimming loses: a rep forwarding a customer message with a one-line note above it. NULL means not fetched, never "empty".';

comment on column public.deal_messages.body_trimmed is
  'The new content only: quoted history, signature furniture and the external-sender banner removed by lib/mail-body.ts, capped at 4000 chars. NULL means we hold no body; check body_status to learn WHY. Never read NULL as "the message was empty".';

comment on column public.deal_messages.body_chars is
  'Length of the body as Graph returned it, BEFORE trimming. Without it a heavily quoted thread and a two-line email are indistinguishable after the fact. NULL means no body was ever fetched.';

comment on column public.deal_messages.body_status is
  'WHICH kind of nothing, when body_trimmed is null. stored = we have it. truncated = we have it and the 4000 cap cut it. empty = Graph returned the message and its body is genuinely empty. not_fetched = eligible, not yet attempted, retry it. unavailable = we could not ask (5xx, throttling, token), TRANSIENT, retry it. gone = Graph 404/410, the message is deleted, PERMANENT, never retry. skipped = deliberately not fetched (machine sender or calendar response). NULL = the row predates this column and has never been considered.';

comment on column public.deal_messages.body_fetched_at is
  'When the body fetch was last attempted, successful or not. NULL means never attempted.';

comment on column public.deal_messages.agreement_kind is
  'nda, quote or agreement, parsed from the subject by agreementSignal(). NULL means this message is NOT an agreement notification, which is a positive finding and not a missing value.';

comment on column public.deal_messages.agreement_state is
  'sent or executed. Adobe EchoSign prefixes a fully executed envelope with "Completed:". NULL whenever agreement_kind is NULL. NOTE that ''sent'' means we saw it go out and have not seen it come back: it is NOT proof the document is unsigned, because a deal can be signed through a channel we do not read. Rolldog gate 420 is the independent second source.';

comment on column public.deal_messages.is_machine_sender is
  'True for echosign, docusign, calendly, no-reply and friends. Exists because customer_side is domain-based and counted echosign@echosign.com as the customer writing to you on 52 messages across 39 deals. customer_side is deliberately NOT rewritten on those rows: lib/activity-report.ts and scripts/validate-reports.ts already compensate for it, and changing it would change what they report.';

comment on column public.deal_messages.has_attachments is
  'Graph hasAttachments from the LIST call. TRUE IS NOT "THE REP SENT A DOCUMENT": every HTML signature carries a logo, so this is true on almost every message any rep sends. deal_attachments holds what survived the inline filter. NULL means the row predates this column.';

comment on column public.deal_messages.attachment_status is
  'none = listed and there were no real files. listed = deal_attachments rows exist for this message. not_listed = has_attachments is true and we have not enumerated them yet. unavailable = the attachments sub-request failed, which is NOT the same as no attachments. NULL means the row predates this column.';

-- The backfill and the cron gap pass both walk this.
create index if not exists deal_messages_body_status_idx
  on public.deal_messages (tenant_id, body_status, sent_at desc);

-- "Has an agreement ever gone out on this deal, and did it come back."
create index if not exists deal_messages_agreement_idx
  on public.deal_messages (deal_id, agreement_kind, sent_at desc)
  where agreement_kind is not null;

commit;
