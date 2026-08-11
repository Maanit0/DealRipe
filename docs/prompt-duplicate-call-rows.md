# Prompt: one meeting, one call row

Paste everything below the line into Claude Code in the DealRipe folder.

---

Read CLAUDE.md first and treat its rules as binding.

A single customer meeting is producing two rows in `calls`, and the work splits
across them. Confirmed cases from August 11:

Gezairi, 8:30 AM, deal `Gezairi`, rep `ebencomo`:

- `5ca151e4-11ea-4880-9204-66a0d6ad2343`, created Aug 10 8:05 AM. Held the bot,
  captured, extracted, sent the recap and wrote the draft. `briefing_sent_at` is
  null.
- `e2f28a12-e4f2-4f5b-9bff-435652736189`, created Aug 11 7:55 AM. Briefing sent
  at 7:55 AM. Nothing else.

FTZ Question Connect, 11:00 AM, deal `Beeimagine`, rep `asuntrup`:

- `a015a135-3f8c-48d6-91fc-a6362ab37395`, created Aug 10 4:01 PM, holds bot
  `03f76204` which Recall confirms was recording.
- `9e2fb7d5-1174-4d81-a7fc-b2659d584eaf`, created Aug 11 10:35 AM, no bot.

The rep experience was actually fine in the Gezairi case: Eduardo received a
briefing, a recap and a draft. But the Activity view reports "Briefing never
sent" on the row that has the recap, so it shows a defect that did not happen,
and every count of captured calls is inflated, including the weekly digest that
goes to Mark Buman.

## Cause

`lib/calendar-sync.ts` dedupes on `external_id`, looking up
`.in("external_id", [callKey, ev.eventId])` and migrating an older row from the
Graph event id to the iCalUId. That handles one identifier changing form. It
does not handle the invite being re-issued, which produces a genuinely new
`iCalUId`, so neither key matches and a second row is inserted.

## Work item 1: do not create the second row

When resolving a calls row for an event, after the existing `external_id` lookup
fails, look for an existing row on the same `deal_id` with the same
`scheduled_start`. If one exists, adopt it: update its `external_id` to the new
key, refresh title and participants, and keep whatever it already holds,
especially `recall_bot_id` and `briefing_sent_at`.

Adopting rather than inserting is the important part. The older row is usually
the one with the bot already dispatched, and creating a new row silently
orphans that bot's work.

Do not match on start time alone across deals. Same deal, same instant. Compare
instants, not timestamp strings: Supabase renders timestamptz as `+00:00` and
`graphIso` renders `Z`, and string equality on those two is false for the same
moment. That mistake already produced a diagnostic reporting zero call rows for
meetings that plainly had two.

## Work item 2: merge the rows that already exist

Write `scripts/merge-duplicate-calls.ts`, read-only by default with `--apply`.

Find every set of rows sharing `deal_id` and `scheduled_start`. For each set,
pick the survivor as the row with a transcript, or failing that the row with a
bot, or failing that the oldest. Merge onto the survivor the fields the others
hold and it does not, `briefing_sent_at` above all. Re-point `sent_messages` and
`transcripts` at the survivor. Delete the losers only under `--apply`, and print
exactly what would change first.

Run it in dry run and paste the output before applying anything. There are live
bots attached to some of these rows today.

## Work item 3: make the Activity view answer the right question

The card answers "what happened to this row" when the rep is asking "what
happened for this meeting". Group by deal and start time and report the union,
so a briefing sent on any row for a meeting reads as sent.

While you are there, `Rolldog write-back: not applicable` is shown for Gezairi,
which has no Rolldog opportunity. That is correct but it is the same word the UI
would use for a deal whose write failed to be authorized, and those need
different labels. Follow the `crmContextStatus` pattern.

## Work item 4: stop recording routine cleanup as a fault

The Gezairi row that succeeded completely carries
`ingest_error: getBot failed: Recall API 404`. Recall drops bot resources after
media deletion, so a 404 on a bot whose call already produced a transcript is
expected cleanup, not an error. Do not store it as `ingest_error`; a later
diagnostic reading that column will report healthy calls as broken.

Related and in the same file: `extractLatestStatusCode` in `lib/recall.ts`
returns `unknown` for a bot that Recall's own dashboard shows as "In Call
Recording", so its expected payload shape has drifted. Fix the parser against a
live response. Nothing outside `lib/recall.ts` reads that field today, so this is
contained, but it makes bot state unobservable.

## Constraints

- Distinguish "no" from "did not check" in every return value you add.
- A diagnostic imports production logic or it does not exist.
- No em-dashes or en-dashes in user-facing copy.
- Magaya is under NDA. No customer data in commits.
- Run `npx tsc --noEmit` before reporting done.

## Report back

State what you changed, what you verified by running, and what you did not
verify. Do not describe untested code as working.
