-- Two drafts in a rep's Outlook for one call.
--
-- recap-sync takes a claim before generating and says so in its own comment:
-- "Checking is not reserving." The claim is a SELECT followed by an INSERT with
-- nothing making the pair atomic, so it narrows the window to the length of one
-- insert rather than closing it. Two runs that both read before either writes
-- still both generate. Measured 2026-09-02: 107 draft rows, 106 distinct
-- (tenant, call, kind), one live duplicate from 2026-09-01 fourteen seconds
-- apart, "MAGAYA CUSTOMS COMPLIANCE - DEMO".
--
-- A partial unique index makes the INSERT itself the lock. The code is already
-- written for this: recap-sync skips the call when its claim insert errors, and
-- lib/followup-draft.ts fails closed on a duplicate. Nothing here changes
-- behaviour on the happy path.
--
-- Safe to re-run.

-- 1. The recap claim. 72 rows on 2026-09-02, all distinct, so this applies
--    cleanly with no cleanup.
create unique index if not exists sent_messages_recap_claim_uniq
  on public.sent_messages (tenant_id, call_id)
  where kind = 'recap_claim' and call_id is not null;

-- 2. The draft archive row, which lib/followup-draft.ts calls the idempotency
--    marker. One existing duplicate BLOCKS this index, so it is removed first.
--
--    WHAT THIS DELETES: the newer of two archive rows describing two drafts
--    that both really exist in a rep's mailbox. It is a record, not the draft.
--    THE SECOND OUTLOOK DRAFT IS NOT TOUCHED, deliberately: a rep's mailbox is
--    something they can see, and removing a message from it without telling
--    them is not something a migration should do. Delete it by hand, or leave
--    it, but decide that separately from this.
delete from public.sent_messages a
where a.kind = 'followup_draft'
  and a.call_id is not null
  and exists (
    select 1 from public.sent_messages b
    where b.kind = 'followup_draft'
      and b.tenant_id = a.tenant_id
      and b.call_id = a.call_id
      and (b.sent_at < a.sent_at or (b.sent_at = a.sent_at and b.id < a.id))
  );

create unique index if not exists sent_messages_followup_draft_uniq
  on public.sent_messages (tenant_id, call_id)
  where kind = 'followup_draft' and call_id is not null;

comment on index public.sent_messages_followup_draft_uniq is
  'One follow-up draft per call. The lock behind the check in lib/followup-draft.ts: a second concurrent run fails its insert and skips rather than putting a duplicate in a rep''s Outlook.';
