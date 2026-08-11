# Prompt: Salesforce resolution and write-back

Paste everything below the line into Claude Code in the DealRipe folder.

---

Read CLAUDE.md first and treat its rules as binding, in particular the section
on treating absence of evidence as evidence of absence, and the rule that a
diagnostic imports production logic or it does not exist.

We are making Salesforce a first-class CRM alongside Rolldog. Today it is
read-only: `getAccountContextByDomain` resolves an Account by email domain for
BDR context, `SALESFORCE_PILOT_OPPORTUNITY_IDS` is empty, and
`lib/salesforce-writeback.ts` has `planAccountWriteBack` / `applyAccountWriteBack`
with no caller anywhere.

There is a hard deadline. Daniel Blitstein has a Salesforce-only discovery call
with Beyond Pegasus (`chris@beyond-pegasus.co.uk`) on Wednesday August 12 at
9:00 AM Central. That call is the acceptance test.

## The bug that motivates this

Eduardo ran a real discovery call with Gezairi on August 11. The only attendee
address on the invite was `manele.khoury@gmail.com`. Salesforce Account
`001RN00000mNkLHYA0` named "Gezairi" exists, with a contact on it. We never found
it, because `resolveAccountId` works by email domain and a free-mail domain
resolves to nothing by design (matching `%@gmail.com` once returned an unrelated
company's account, so the guard is correct and must stay).

The briefing therefore had no Salesforce context, and said nothing about why.
"No account exists" and "we could not reach the account from this invite" are
different facts and the code collapses them.

## Work item 1: resolution that cannot silently fail

In `lib/salesforce-context.ts`:

- Change the account resolution entry point to return a discriminated result
  rather than `SalesforceAccountContext | null`. Follow the `crmContextStatus`
  pattern already in `lib/deal-context.ts`. At minimum distinguish: resolved by
  domain, resolved by name, no account found, ambiguous (several candidates),
  lookup failed, and no usable identifier on the invite.
- Add a name-based fallback, used when the domain is free-mail OR when domain
  resolution returns nothing. Source the name from the deal's account name first,
  then `accountFromSubject` on the meeting subject. Reuse `findAccountsByName`.
- Require a real name overlap before accepting a candidate. Copy the guard from
  `scripts/meeting-readiness.ts`: normalize both sides with `normalizeName` and
  require one to be a prefix of the other. Salesforce `LIKE '%x%'` is fuzzy and
  will hand back a different customer.
- Exactly one surviving candidate is a match. Two or more is `ambiguous`, which
  is a state a human resolves, never one the code guesses at.
- A thrown error is `lookup_failed`. It must never fall through to a weaker
  strategy that then returns "not found". That exact fall-through cost four
  briefings their context with nothing in the logs.

Persist the outcome. Add `salesforce_account_id` and
`salesforce_link_confidence` to `deals`, mirroring the Rolldog columns, with a
migration and a `lib/database.types.ts` update. Resolution should be sticky:
once an account is confirmed for a deal we stop re-deriving it per call.

Surface the status in `lib/deal-context.ts` and in the briefing the same way
`crmContextStatus` already is, so a briefing built without Salesforce context
says which of the reasons applied.

## Work item 2: look ahead and link

Write `scripts/sync-salesforce-links.ts`, read-only by default with `--apply`.

For every deal with a call in the next N days (default 14), resolve an Account
using the logic above and report one row per deal: current link, proposed link,
confidence, and the reason. `--apply` writes only `confirmed` matches.
`ambiguous` rows print their candidates and are left for a human.

Then add a `salesforce-relink` cron modelled on `rolldog-relink`: same cadence
shape, same idea that a deal which gains an Account later still gets linked. Add
it to `vercel.json`. Keep it pinned to the `magaya` tenant.

## Work item 3: the write

Add `lib/salesforce-scope.ts` modelled on `lib/crm-scope.ts`. Fail closed. Two
authorization routes exactly as Rolldog has them, and a single
`resolveSalesforceWriteTarget` function that is the only place the decision is
made, so diagnostics cannot drift from it:

1. A static `SALESFORCE_PILOT_ACCOUNT_IDS` allowlist for hand-seeded accounts.
2. Runtime authorization of a `confirmed` link stored on the deal, scoped to the
   duration of one write, like `runWithAuthorizedOpportunities`.

Wire `planAccountWriteBack` / `applyAccountWriteBack` into `transcript-sync` at
the same point the Rolldog write happens. Both CRMs should be attempted, and a
failure of one must not prevent the other.

Field mapping goes through `accountFieldMap` / `accountFieldMeta` rather than
hardcoded API names, since those differ per org and are already discovered at
runtime. Respect field type and length from `accountFieldMeta`; truncating into
a field with a shorter limit throws and would take the whole write down.

**Write policy, change this if you disagree with it:** only populate fields that
are currently blank in Salesforce. Never overwrite a value already present. The
BDRs populate these fields by hand, and an extraction quietly replacing a human's
note is a much worse first impression than a field left empty. Anything we would
have written into an occupied field goes into the plan as `skipped_occupied` so
it is visible rather than lost.

Default to dry run. `--apply` to write. Log the full plan either way.

## Work item 4: prove it

Write `scripts/salesforce-writeback-preflight.ts`: one row per upcoming call
showing the resolved Account, the link confidence, whether
`resolveSalesforceWriteTarget` authorizes a write, and which fields would be
written. It must import the production functions, not restate their rules.

Run it against Beyond Pegasus and paste the output. Then run the write in dry
run for that deal and paste the plan.

## Constraints

- Distinguish "no" from "did not check" in every return value you add. This is
  the single most important line in this prompt.
- No em-dashes or en-dashes in any user-facing copy, including anything written
  into Salesforce.
- Magaya is under NDA. No transcripts, no customer data, no generated previews
  in commits.
- `PILOT_OPPORTUNITY_IDS` and the new Salesforce equivalent govern writes into a
  paying customer's CRM. Nothing automated may widen either one.
- Run `npx tsc --noEmit` before you report done.

## Report back

State what you changed, what you verified by running, and what you did not
verify. Do not describe untested code as working.
