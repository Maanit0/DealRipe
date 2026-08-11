-- Which Salesforce Account a deal resolves to, and how that link was reached.
-- Mirrors add-deal-rolldog-link.sql deliberately: the two CRMs get the same
-- shape so the write-authorization rules can be read side by side.
--
-- salesforce_link_confidence is one of:
--   confirmed  resolved by email domain, or by a name match a human applied.
--              This is the only value that authorizes a write.
--   review     a candidate was found but something about it needs a human:
--              a name-only match, or several candidates.
--   null       never resolved.
--
-- Deliberately NOT stored: "we looked and found nothing" versus "the lookup
-- failed". Those live in the resolution result, not on the deal row, because a
-- failed lookup must never be persisted as a fact about the customer. A null
-- here means only that no link has been established.

alter table public.deals
  add column if not exists salesforce_account_id text,
  add column if not exists salesforce_link_confidence text; -- confirmed | review
