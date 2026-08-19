# DealRipe

## What this is

A qualification execution layer for B2B sales teams. Reps run customer calls,
DealRipe joins them, extracts answers to the company's qualification framework
from the transcript, and writes structured field updates back to their CRM. The
wedge is the write: Gong produces notes and activity records, it does not
populate qualification fields.

## Where the product actually is, August 2026

**The TopSort demo is over.** `docs/topsort-demo-2026-04.md` is the old brief,
kept because `lib/briefing-prompt.ts` and the `topsort` tenant still exist in
code. Do not treat it as current: it describes seed data in TypeScript, no
database, and a Scotsman framework. None of that governs today.

**The live thing is the Magaya pilot.** Magaya sells logistics software
(customs filing, freight forwarding, WMS). Real reps, real customers, real
money. Mark Buman is the CRO and sponsor, Mitch Nemmers the VP.

Six reps are enrolled: Juan Lopez, Eduardo Bencomo, Alexandra Suntrup, Daniel
Blitstein, Ariel Rodriguez, Steven Johnson. **All six connected as of
2026-08-15**, Steven last after Mark chased him. He starts five weeks behind:
none of his accounts are linked and calendar-sync never saw his history, so his
first week of captures has nowhere to write until that is fixed.

Their framework is SQL0 through SQL5, 27 fields, seeded by
`scripts/seed-magaya-framework.ts`. Rolldog separately holds a 30-item
stage-requirement checklist the reps maintain by hand.

## Stack

- Next.js 14 app router, TypeScript, Tailwind, deployed on Vercel
- Supabase / Postgres. Types in `lib/database.types.ts`
- Vercel crons in `vercel.json`: calendar-sync, transcript-sync, briefing-sync
  every 5 min; rolldog-relink every 2h; snapshot every 4h; outcome-sync and
  audit daily; prescription-scoring every 6h; digest Tuesdays 11:00;
  link-escalation Mondays 14:00
- Recall.ai for meeting bots
- Microsoft Graph: delegated Calendars.Read per rep, app-only Mail.Read and
  Mail.ReadWrite. **Deliberately not Mail.Send.** Drafts are never sent.
- Rolldog (JSON:API) and Salesforce (JWT bearer) as the customer's CRMs
- Anthropic API for extraction, briefings, recaps, drafts

## The loop

```
calendar-sync    reads each rep's calendar, decides whether to join (join-gate),
                 creates the deal and calls row, schedules the Recall bot
briefing-sync    ~30 min before start, builds context and emails the rep
transcript-sync  bot finishes -> transcript persisted -> extraction -> marked.
                 Fast, and the only stage where being killed loses something
                 unrecoverable. CRM field write-back rides here (no LLM).
recap-sync       recap (three passes) -> follow-up draft in Outlook ->
                 Salesforce call activity and next-step Task. Everything
                 expensive and re-runnable.
rolldog-relink   every 2h, links deals to newly created opportunities and
                 backfills every captured call into them
```

A deal that gains a Rolldog opportunity later still gets its history pushed, so
a call captured before the opportunity existed is not lost.

## Hard-won facts

Each of these cost real time to discover. Do not re-derive them.

**Rolldog write authorization has two routes.** Hand-seeded deals use the static
`PILOT_OPPORTUNITY_IDS` allowlist in `lib/crm-scope.ts`. Auto-linked deals
authorize their own `confirmed`/`high` match at write time through
`runWithAuthorizedOpportunities`, needing no allowlist entry. `resolveWriteTarget`
in `lib/rolldog-writeback.ts` is the single source of that decision. Anything
asking "will this deal write back" calls it rather than restating the rules.

**Every Rolldog READ needs the same wrapper, and TWO of them did not have it.**
`assertScopedRead` is as fail-closed as the write side, so an opportunity
outside `PILOT_OPPORTUNITY_IDS` throws unless the call is wrapped in
`runWithAuthorizedOpportunities`, and the throw arrives at the caller as a
failed read rather than as a refusal.

`lib/snapshot.ts` was the first: 5,464 refusals between 2026-07-17 and
2026-08-16, and 21 live deals recording a month of four-hourly snapshots with
no CRM stage at all. The digest's movement detection, `readStageMoved` and the
per-rep calibration were all reading our own refusal as a deal that had not
moved.

`lib/pipeline-changes.ts` was the second, found 2026-08-16 while building
`scripts/evidence-pack.ts` and fixed the same day. Its per-deal
`getRolldogSummary` was unwrapped, so the engine behind Mark's weekly digest
AND the /review dashboard reported 27 deals carrying a rep forecast when 45 do.
The other 18 arrived as `forecastCategory: null`, which reads as "the rep has
entered no forecast" and is indistinguishable from it.

Finding one does not mean you have found the last one. That same grep
(`getRolldogSummary`, `readRolldogSummary`, `getDealRoom`) on 2026-08-16 found
three MORE unwrapped call sites. All are now fixed, and the worst of them is
the reason this paragraph exists:

- `app/deals/[id]/page.tsx` the deal page. An auto-linked deal showed no CRM
  stage and no deal size, while a briefing for the same deal showed both,
  because `lib/deal-context.ts` reads the identical opportunity wrapped.
- `app/pipeline/page.tsx` the pipeline table. This one is the nastiest shape
  the bug takes and the argument for never leaving one of these open: the
  refusal arrived as a null live read, and the existing fallback quietly
  substituted the frozen day-0 `deal_crm_baseline`. The table therefore showed
  a plausible stage and size that had been frozen since the pilot started, with
  nothing on the page saying the live read had been refused. A blank cell is a
  visible bug; a stale cell that looks live is not.
- `lib/weekly-digest-data.ts` reached by `scripts/generate-digest.ts`, not by
  the cron. Its "best-effort per deal" rep-forecast enrichment was in practice
  always omitted.

The live crons were already clean: `app/api/cron/digest/route.ts` and
`app/review/page.tsx` both go through `getPipelineChanges`.

One unwrapped read is left on purpose. `lib/crm-baseline.ts` calls `getDealRoom`
bare, and it is safe TODAY only because its single caller,
`scripts/capture-crm-baseline.ts`, iterates `PILOT_DEAL_ROLLDOG_IDS`, whose
opportunities are in `PILOT_OPPORTUNITY_IDS` by construction. It is a trap
rather than a bug: the first person to call `captureCrmBaseline` for an
auto-linked deal gets a throw that presents as "Rolldog has no room for this
opportunity". Wrap it when you touch that file.

`crm_access_log` says so every time and in real time: `allowed=false` with the
exact `READ_FIELDS` of the summary read. Query it before believing any claim
that a CRM record is absent, and query it after any fix, because zero refused
reads over a run is the only proof the wrapper is actually on the path. All
five sites were verified that way on 2026-08-16: the evidence pack, a
`generate-digest` run, and authenticated loads of `/pipeline?tenant=magaya` and
a deal page linked to an opportunity outside `PILOT_OPPORTUNITY_IDS`, each
producing 0 refused reads where the first two had produced 60 across 19
opportunities.

**Magaya's second Rolldog stage has no digit in its name.** It is called
"SQL - Develop Opportunity (Qualify)", stage id 200, and it is SQL1.
`lib/stage-gates.ts` resolves it positionally for the checklist and always did;
`stageKeyFromSummary` parsed the name with a regex and returned null, so six
live deals briefed and scored as having no CRM stage. The ids run 200, 202
(SQL2), 204 (SQL3), 208 (SQL5), with SQL0 apart on 773. That arithmetic implies
206 is SQL4, which is why 206 is deliberately NOT mapped: nobody has seen it.

**A stage of 0 or -1 with a null name is NOT "the rep never set a stage."** Nine
linked opportunities are in that state (Best, Dpworld, Successchb, GUYWBD, Air
Americas, Extrum, TW Customs, Shipping My Car, Loomis). It is a fact about their
CRM rather than a parse failure, and it is not SQL0, which is a real stage
carrying id 773, so mapping the number 0 to SQL0 would invent a stage for nine
deals. All of that still holds. The INTERPRETATION was wrong, and it was wrong
in this codebase's signature direction.

Checked against Salesforce 2026-08-18: seven of the nine are CLOSED. Best (won
2026-06-30), TW Customs (won 2026-06-25), Dpworld (lost 2026-08-07), GUYWBD
(lost 2026-08-07), Air Americas (lost 2026-08-07), Extrum (lost 2026-08-07),
Successchb (lost 2026-08-11). The rep did not fail to set a Rolldog stage; the
deal RESOLVED, in the other CRM, and nobody went back to maintain Rolldog. A
null stage means "ask the system that actually knows", never "nothing has
happened here". Loomis and Shipping My Car are the only two still unaccounted
for.

The live consequence, unfixed as of 2026-08-18: eleven deals whose Salesforce
account carries only closed opportunities are still SQL0 in our pipeline, still
accruing four-hourly snapshots (213 so far), and will appear in Mark's Monday
digest as live pipeline. Six of them are LOST. Three of the won ones (Mollaxpanama,
Treecorp, Eosits) took calls on 2026-08-18 that would have been briefed as new
business.

**Won/lost data EXISTS and outcome-sync has never once read it.** Two stacked
bugs, both found 2026-08-18, and the pair is the reason "0 won, 0 lost" was
believed for weeks.

`lib/outcome-sync.ts` selects `deals.external_id` and passes it to
`getOpportunityOutcome` as a Salesforce Opportunity id. In this pilot
`external_id` is DealRipe's own auto-created key (`auto:cbxglobal.com`,
`omniva`, `seino`). Zero of 108 deals carry a `006` Opportunity id there. The
Salesforce link lives on `salesforce_account_id` (91 deals, all `confirmed`),
and an account is not an opportunity: 45 of those 91 carry more than one, so
the mapping has to CHOOSE, and a deal with several closed opportunities and no
open one needs a rule rather than a first-row pick.

Second, `getOpportunityOutcome` calls `assertScopedRead`, the Rolldog guard,
against `SALESFORCE_PILOT_OPPORTUNITY_IDS`, which has **0 entries**. So even a
correct Opportunity id is refused before any network call. The daily cron logs
101 `allowed=false` reads every morning and reports them as `errors`, which is
the honest signal nobody was reading.

What is actually there, measured through the accounts: 215 opportunities on the
91 linked accounts, 163 closed, **126 won and 37 lost**, 52 open. So "no
outcomes exist" is false and should not be repeated.

**But almost none of it is DealRipe's.** 133 of the 163 closed before 2026 and
the pilot only started mid-July. Closed opportunities whose DealRipe deal had a
call ON OR BEFORE the close date: **7**. Carrying prescriptions as well: **3**.
That is the entire DealRipe-observed outcome set, and it is far too small to
calibrate or train on. Anyone reaching for these numbers wants one of two
different things and should say which:

- **A prior about Magaya's business** (what a won deal looks like, cycle length,
  amount, loss reason). The 163 support that. They say nothing about DealRipe.
- **Evidence DealRipe changed an outcome.** n=7. There is no such evidence yet
  and claiming it would not survive one question from Mark.

Worse, five of the seven are not independent losses. Mitch Nemmers closed
Dpworld, GUYWBD, Air Americas and Extrum within 90 seconds of each other at
2026-08-07T18:28, and Successchb on 08-11, every one of them reason
`No Decision / Non-Responsive`. That is a VP running a hygiene sweep over deals
that went dark about two weeks after creation, not five competitive losses. Read
as sales outcomes they would make DealRipe-observed deals look like they lose at
71%, against Magaya's historical 77% win rate. Both figures are noise at this n.

`Opportunity.Loss_Reason__c` exists and is populated, and it is a much richer
label than the won/lost boolean. Use it when the loop is finally built.

FIXED and APPLIED 2026-08-18, for the future rather than for a backlog: it is
the only thing that will capture pilot deals as they close. Resolution moved off
`external_id` and onto `salesforce_account_id`, in `lib/salesforce-outcome.ts`.
Two rules do the choosing, and both exist because getting them wrong invents an
outcome: any OPEN opportunity means still in play, and a close counts only if it
lands on or after the first call we captured. `open_with_recent_close` carries
both facts instead of picking one (Speed International won 2026-08-14 with other
business still open, so it is reported and left unlabelled). Dry run: 92
resolved, 0 errors, 0 unavailable, 1 won, 5 lost, 46 open, 8 only historical, 32
with no opportunity on the account. Drive it with
`scripts/run-outcome-sync.ts`, dry run by default, `--apply` **writes**.

`getPipelineChanges` now drops deals carrying an `outcome_label` and returns
`closedOut`, so the digest and /review stop counting resolved deals as live
pipeline without silently showing fewer rows.

Applied 2026-08-18: six deals labelled (Dpworld, Successchb, GUYWBD, Airamericas
and Extrum lost, Mollaxpanama won), 160 snapshots and 11 prescriptions
backfilled with an outcome, and all six verified absent from the pipeline view
with `closedOut` carrying them instead. Five of the six losses are the single
`No Decision / Non-Responsive` sweep, so treat that as one event and not as five
independent losses when the learning loop reads them.

**Rolldog's stage checklist lives at
`/opportunities/{id}/opportunity-stages-requirement`.** Note the pluralization.
`include=` 500s on this API, so sub-resources are separate GETs. Items carry a
stable definition id shared across opportunities; join on the id, never the
name, because the live payload contains a leading space in " Create Initial
Close Plan and Presented" and a typo in "Validate Who Negotiate and Signs".

**A `false` on a checklist item means unset, not "no".** There is one boolean
and no third state. Reading false as a recorded negative produced a briefing
telling a paying customer in onboarding that Magaya was not their selected
vendor. Only positive ticks carry information.

**Microsoft Graph returns event times with no offset.** `new Date(dateTime)`
parses them as local and shifts every meeting by the reader's UTC offset. Use
`lib/graph-time.ts`. Magaya works Central.

**`iCalUId` is stable across mailboxes, `id` is per-mailbox.** Calls are keyed on
`iCalUId` so a co-sold meeting on two calendars produces one bot, not two.

**Salesforce writes were forbidden until 2026-08-11, then authorized.** The old
rule was a Magaya security-review commitment, recorded above `assertScopedWrite`.
Mark Buman lifted it with Magaya security, without a field restriction.

Permitted and implemented are different. The writer touches exactly the eight
Account fields in `FIELD_SOURCES` (`lib/salesforce-writeback-run.ts`): Business
Issues, Software Purposes, Any Other Software, Other Providers Reached Out,
Desired Go-Live Date, and the Compelling Events, Budget Confirmed and Executive
Sponsorship booleans. Adding a field needs a mapping and a look at its type and
length, not just permission.

`SALESFORCE_PILOT_ACCOUNT_IDS` and `SALESFORCE_WRITEBACK_ENABLED` still gate
every write. They are blast-radius gates rather than permission gates now, for
the same reason `PILOT_OPPORTUNITY_IDS` gates Rolldog. `assertScopedWrite` stays
Rolldog-only; Salesforce goes through `assertScopedAccountWrite` in
`lib/salesforce-scope.ts`.

The Salesforce READ side is separate and unrestricted: `resolveAccount` returns
a six-way result and falls back to a name search when the domain is free-mail,
which is the only way Gezairi's real account was ever going to be reachable from
a gmail invite.

**Free-mail domains never resolve by domain**, only by exact address. Matching
`%@gmail.com` once returned an unrelated company's account.

**The reliable join key for a Salesforce account is the BDR's activity, not the
domain.** Eduardo, 2026-08-14: there is always an activity on the account when a
BDR books a discovery call. Match that activity's date and contact against the
calendar event. Domain matching alone put Dunavant on a stale 2021 record for a
week and left ten of his deals unlinked. His own edge case: when a rep books the
meeting himself he logs the activity after the fact or never, so fall back to
contact, then account, then email the owner and say which step failed.

**Account ids beginning `0013j` are legacy records, `001RN` are current.**
Characters four to six encode the instance the record was created on. Two deals
were pointed at `3j` accounts with zero activity while the live opportunity sat
on the `RN` twin. Salesforce's own duplicate rule does not catch them.

**`salesforce_link_confidence` fails closed below `confirmed`.** Setting
`salesforce_account_id` alone produces a deal that is correctly linked and
refuses every write, silently. Any tool that sets the id sets the confidence.

**Magaya deploys per office, so one customer is several accounts.** Medov
Logistics is the parent of Medov Europe. Read `ParentId`, and when the invite
does not disambiguate, say which one was chosen rather than picking silently.
Eduardo is relaxed about landing on the wrong one; he is not relaxed about not
knowing which was used.

**Rolldog and Salesforce are not either-or.** `log-salesforce-calls.ts` skipped
every deal that had a Rolldog opportunity, so a deal in both CRMs got nothing in
Salesforce by design. Eduardo wants both: Salesforce for portability and because
accounting integrates there, Rolldog because it is where the sales team lives.
Mark may disagree. Make it configurable rather than assumed.

**The recap is three passes now, and they live in their own cron.** Measured
2026-08-16: one 36k-character transcript takes 3m 27s. transcript-sync has a
240s budget inside a 300s ceiling and checks it only at the top of its loop, so
a recap starting at t=239s is killed halfway. That is the 2026-08-13 failure
that cost Ariel three drafts. `lib/recap-sync.ts` refuses to START a call it
cannot finish, so an interruption there costs five minutes and nothing else.
`scripts/run-recap-sync.ts` drives it by hand.

**The narrative pass runs for EVERY call type; only the audit is routed.** A
renewal or a support call gets the readout and no qualification record, which is
what `docs/recap-target-eduardo.md` asks for. The narrative never receives the
extraction: `buildNarrative` has no framework parameter, which is the only form
of that instruction that cannot be quietly undone.

**A no-show has a transcript.** Joining noise, "okay", "I'll be on the line",
about a thousand characters of nothing. It passes any length check. Filter on
`outcome` against the NO_CONTENT set or you will email a rep a recap of a
meeting that never happened.

**Contact count is a broken tiebreaker for duplicate Salesforce accounts.** A
legacy record accumulates contacts for years: Dunavant's 2021 Closed Lost record
had 14 on dunavant.com while the live account had 2, so ranking by count picked
the dead one and marked it `confirmed`. An OPEN OPPORTUNITY separates live from
dead. A name check is still required on top of it, because Mollaxpanama has one
candidate with an open opportunity and it is named "Vene-embarques, C.A. LLC",
a different company. Both guards live in `preferLiveAccount`.

**The recap reads like a form because it is generated from the extraction.**
Eduardo, 2026-08-14: "it's very tied to the checks that we have." This is
topology, not prompt quality. The fix is three independent passes over the
transcript rather than one derived pass: narrative in the customer's own words
with no framework vocabulary, then the gap audit unchanged, then demo strategy.
He was explicit that the audit stays. `docs/recap-target-eduardo.md` is the
structure he asked for, written by him.

**`Account.Customer_Status__c` does not mean what it says.** It carries
'Active' on 39,297 of Magaya's ~45,000 accounts, including every prospect on a
first discovery call. It describes whether the RECORD is active. The field that
means "they buy from us" is **`Account.Type`** (5,198 Customer against 39,452
Prospect), corroborated by `Customer_Since__c` and `Account_Active_Licenses__c`.
Reading Customer_Status as customer evidence classified seven genuine discovery
calls as expansion conversations. Same shape as the checklist boolean: a field
whose values were assumed rather than counted.

**The useful Salesforce fields for classifying a call, all confirmed present by
describe:** `Opportunity.Is_Renewal__c`, `Opportunity.Opportunity_Type__c`,
`Account.Type`, `Account.Customer_Since__c`, `Account.Implementati__c`
(implementation status), `Account.Account_Active_Licenses__c`. Read through
`readCustomerStanding` / `readOpportunitySituation` in `lib/salesforce-context.ts`,
which describe first so a field hidden by field-level security is "did not
check" rather than "no".

**Recall transcripts are diarized into fragments and interleaved, so a spoken
sentence is often not contiguous text.** One sentence is split across several
lines by the same speaker with other people's "mhm" in between. Any check that
requires a verbatim quote must join a single speaker's own consecutive
fragments (`quoteAppearsIn` in `lib/prescription-scoring.ts`), never across
speakers. A naive contiguous match rejects correct evidence and reports it as
the thing not having been said, which is this codebase's own failure mode
arriving from the inside.

**An end commitment is usually secured after the call, in writing.** The first
scoring run found 21 commitments and exactly one proposed out loud, with seven
of the remaining twenty followed by mail from the rep to the customer. A
question is asked on the call or not at all; a commitment has two channels and
scoring it from the transcript alone records reps who did the work as reps who
did nothing.

**Follow-through on a briefing tracks the CALL TYPE, not the rep.** Measured
across five reps: 25% on discovery, 8% on proposal, 0% on demo, follow-up and
existing-customer calls. Cargoservicesgroup was an existing customer mid
implementation being asked "what's driving you to look at a new solution", and
Unitedchb was a demo ending "appreciate the demo" being asked the same. The reps
were right not to ask. Read a low rate on a late-stage or existing-customer call
as evidence about the briefing, never about the rep, until "route by call type"
below is done.

## The failure mode that dominates this codebase

Every integration here fails by returning nothing rather than by throwing
something visible. So the recurring bug, and the recurring reasoning error, is
**treating absence of evidence as evidence of absence.**

Real examples, all from one evening:

- A transient Salesforce error fell through to a weaker match strategy and
  returned null, which callers read as "this company is not in Salesforce".
  Four briefings lost their context between two runs with nothing in the logs.
- An unticked checklist box was read as a recorded "no".
- A diagnostic computed the deal id differently from production and reported two
  healthy, running deals as nonexistent.
- A diagnostic checked one of two write-authorization routes and reported four
  writable deals as blocked, on the same day one of them wrote to Rolldog.

Two rules follow, and they are worth more than any feature in the backlog:

**Distinguish "no" from "did not check" in every return value.** Anything
crossing an integration boundary should say which of the two it means.
`crmContextStatus` in `lib/deal-context.ts` is the pattern: present, empty,
no_account, unavailable, have_own_calls, no_company_domain.

**A diagnostic imports production logic or it does not exist.** Two of the four
above were scripts reimplementing rules and drifting. A checker that can
disagree with the code it checks will, and it will do so confidently.

There is an outstanding pass to do: grep for `catch { ... = null }` and give each
one a distinguishable failure result.

**Capture failures are admission failures, not recording failures.** Fourteen
calls carried "bot done but media unavailable". Not one had lost media: thirteen
bots were never admitted to the meeting and one had a dead join link. The cause
was in Recall's `status_changes` the whole time, and `extractLatestStatusDetail`
in `lib/recall.ts` read the sub_code off the LAST entry, which on a lobby death
is a bare `done` carrying nothing while `call_ended(timeout_exceeded_waiting_room)`
sits immediately before it. `lib/capture-classify.ts` reads backwards for the
first entry that carries a sub_code, and is the single source of that verdict.

**A lobby timeout is undecidable and always will be.** A bot waiting outside the
room cannot see whether anyone is inside it, so "the meeting ran and nobody
noticed the lobby" and "the meeting never happened" produce byte-identical
histories. Recall's own `noone_joined_timeout`, which would decide it, only fires
once the bot is inside. Eleven of the fourteen are this. They are counted as
themselves, never as failures and never as no-shows, and capture rate is reported
as a range for that reason.

**A call whose bot was never dispatched is invisible to everything.**
transcript-sync's main loop filters on `recall_bot_id not null`,
`capture-failures.ts` queries `outcome='capture_failed'`, and every rep and CRO
view skips a call with no outcome, so a row where `createBot` failed sits
untouched forever carrying nothing. calendar-sync's no-bot retry branch does
re-dispatch, but only while the meeting is still in the lookahead window; once
it is in the past the row is orphaned. `recordDispatchFailure` now writes the
reason onto the call, and `capture-health.ts` reports it as unknown rather than
counting it anywhere. Found 2026-08-16, four days after it happened to Sunny
Wing Logistics, and only because unknown is never folded into a failure bucket.

**An absent recording is what SUCCESS looks like.** `deleteSourceRecording` runs
on every successful capture to honour the delete-after-pull commitment, so a bot
that reached `in_call_recording` with no media attached is the normal end state
of a call that worked. `classifyCapture` briefly read that as `media_lost` and
returned it for Gezairi and Speed International, both captured, with 22,301 and
54,860 character transcripts sitting in our own database. The only thing
separating "Recall lost it" from "we pulled it and cleaned up" is whether a
transcript is stored, so a caller that has not passed `transcriptChars` gets
`unknown`, never `media_lost`.

**A Recall 404 in `ingest_error` usually means we deleted that bot, not that
Recall forgot it.** The Gezairi row carries a 404 for a bot id that is not the
bot id on the row: calendar-sync's reschedule path calls `deleteBot` then
`createBot`, and transcript-sync polled the dead id once before the row caught
up. The call captured normally. Do not read a 404 as evidence expiry without
checking the id in the error against `recall_bot_id`.

**The bots are stuck in Magaya's own lobbies, not the customer's.** Of the ten
lobby events with a recorded organizer, nine are Magaya-organized meetings and
one is customer-organized, and Eduardo says that one was a no-show he did not
attend. So the first remedy is a Teams lobby policy change through Ernesto, not
a notification: Magaya controls the door on its own meetings. The rep ping and
the forward-the-invite re-entry are for the residual, where the prospect hosts.

**A refused bot is not automatically a lost call.** Eduardo, 2026-08-14: "good
if it's maybe an internal conversation, I think I rejected it once." Both
refusals in the pilot were in Magaya-organized meetings, so the hand on the deny
button was Magaya's, and a rep keeping a conversation private is the product
working. `classifyCapture` takes `hostSide` for this reason: a refusal in our own
meeting is undecidable and someone has to be asked, a refusal in the customer's
is a loss. Do not restate that rule anywhere; `capture-health.ts` computes its
rate from `countsAsCaptureFailure` rather than from the category for exactly
this reason, having got it wrong once by re-deriving it.

**Teams caps the lobby at 30 minutes regardless of what we ask for.** Our
`waiting_room_timeout` of 2400s is applied and correct; `call_ended_by_platform_waiting_room_timeout`
is the platform ending it first. Waiting longer is exhausted as a lever, so the
remaining fix is getting a human to admit the bot.

## Diagnostics

All read-only unless noted. Run with `npx tsx scripts/<name>.ts`.

- `meeting-readiness.ts --briefing` per meeting: join verdict, bot, Rolldog,
  Salesforce, checklist, and a real generated briefing
- `meeting-crm-map.ts` one row per upcoming meeting: will the write land
- `sync-writeback-allowlist.ts` deals that cannot write back, and why
- `check-names.ts --deal X --name Y` traces a name in a briefing to its source
- `diagnose-deal.ts --deal X` walks one deal through the whole chain
- `preflight-reps.ts` per-rep readiness
- `preflight-calls.ts` next 48h: bot, briefing, write target
- `capture-health.ts` per rep and overall, over any window: captured, no-show,
  lobby timeout, bot refused, never joined, media failure, and unknown with its
  reason. Imports `lib/capture-classify.ts` rather than restating it, and
  reports capture rate as a range because lobby timeouts are undecidable
- `backfill-capture-diagnostics.ts` re-reads Recall for every capture_failed
  call and stores what it says. Dry run by default, `--apply` **writes**,
  `--reclassify` moves a proven no-show off capture_failed
- `rolldog-opp-detail.ts --name X` opportunities with owner, stage, created
- `link-accounts.ts` matches deals to Salesforce accounts by Eduardo's ladder
  (contact address, then activity on the meeting date, then domain, then name).
  Dry run by default, `--apply` **writes** the confirmed links
- `prescription-report.ts --rep X` follow-through rate and the outcome rate for
  followed versus not followed; `--deal Y` every prescription with its evidence
- `backfill-prescriptions.ts` recovers prescriptions from briefings already
  sent. Dry run by default, `--apply` **writes**
- `run-outcome-sync.ts` resolves each deal's Salesforce outcome from its
  account, not from `external_id`. Dry run by default, `--apply` **writes** the
  labels and backfills the calibration tables, `--refill-detail` fills the
  opportunity id, close date, loss reason and amount onto deals labelled before
  those columns existed and reports rather than overwrites a disagreement
- `link-deal.ts --deal X --opp N --apply` **writes**
- `mine-plays.ts [--rep X] [--days 30] [--top N]` the specific moves the reps
  made, verbatim, grouped by what the move was doing, with whether a next
  meeting followed within seven days and whether the stage advanced within
  thirty. Quotes are verified back against the transcript with `quoteAppearsIn`,
  and the seller side is decided from the invite roster, never from the model
- `probe-stage-gates.ts --opp N` discovery for the checklist endpoint
- `verify-stage-gates.ts --opps a,b,c` checks item ids are stable
- `evidence-pack.ts --days 45` what the pilot has actually produced, for an
  outside conversation: coverage and capture, what was delivered and written,
  where DealRipe's forecast differs from the rep's and why, what it caught,
  follow-through by call type, and three named examples. Every figure is a
  query and anything unmeasurable prints as "not measured" rather than as
  zero. Two claims it deliberately refuses to print: the forecast-accuracy
  tile in `lib/forecast-room.ts` (`CALIBRATION`, 90% against the rep's 63%,
  184 deals) is a hardcoded demo constant never computed from a Magaya
  outcome, and a probability-weighted pipeline figure would require the
  category-to-probability map, which is also a demo device

## Conventions

- **No em-dashes or en-dashes in any user-facing copy.** Mark reads them as
  machine-written. Enforced in `lib/briefing-lint.ts`.
- Product name is DealRipe. One word, capital D, capital R.
- No sycophantic copy. Mark's CRO brain treats it as noise.
- Briefings are linted before delivery and regenerated on failure. A briefing
  that breaks a hard rule twice is suppressed, not sent: no briefing beats a
  wrong one.
- An "ask" in a briefing is spoken aloud to a customer. It may never cite our
  CRM state, contain an unfilled placeholder, or address a shared mailbox by
  name.

## Security and data handling

- **Magaya is under NDA.** Customer transcripts and generated previews stay
  local and are never committed. `digest-preview.html` and `welcome-preview.html`
  are gitignored for this reason.
- `.env.local` and `dealripe-sf.key` are live production secrets. Never commit,
  never log.
- `MS_CLIENT_SECRET` is effectively a tenant-wide mailbox key: the Application
  Access Policy was declined, so app-only mail scopes cover every mailbox.
- `PILOT_OPPORTUNITY_IDS` and `crm-scope.ts` are the boundary governing writes
  into a customer's CRM. Fail-closed by design. Nothing automated may widen it.
- The previously exposed Resend API key still needs rotating.
- Crons are pinned to the `magaya` tenant. Keelson and Second Nature seeds must
  stay additive, idempotent and inert.

## Open items

Ordered by what Eduardo asked for on 2026-08-14, since he is the only rep who
has looked closely enough to be specific.

**Before Monday**

- Deploy. `recap-sync` exists in `vercel.json` but until it ships NOTHING
  produces recaps: transcript-sync no longer does.
- The qualification email still renders through the OLD
  `renderPostCallSummaryEmail`. The general path already uses the new
  `renderRecapEmailBody`, so a renewal gets the new artifact and a discovery
  call does not. Close that asymmetry first.
- The recap has never been linted. `lintBriefing` is called from exactly one
  place, `generate-briefing.ts`. Extend it before the Note ships, since that
  writes generated copy into a customer's CRM. Three tiers, because the failures
  are not alike:
    - AUTO-FIX, never regenerate: em-dashes and en-dashes. Substitution is exact
      and lossless, and regenerating a 3m30s pass over one dash is absurd. The
      dash in the Salesforce Task title is not model output at all (it is the
      rep's own calendar subject via `cleanMeetingTitle`) so it can ONLY be
      fixed this way.
    - REGENERATE ONCE, then ship and flag: framework vocabulary in the
      narrative. "Compelling event" is off-register, not wrong, and suppressing
      the section would delete the operational-detail paragraph to fix a noun.
    - HARD FAIL, suppress: unfilled placeholders, bracketed tokens, a heading
      with nothing under it. Anything that asserts what we cannot stand behind.
  One more check, learned 2026-08-16: a pain point containing no verb that
  describes a problem is a requirement CATEGORY that leaked through ("customs
  sophistication is a decision driver"). Categories belong in
  `requirementsByArea`; pain points describe mechanics. It is mechanically
  detectable and it is worth detecting, because ranking categories as pains
  pushed the one paragraph the doc calls "worth more than the whole gap audit"
  down to fourth.
- Recap as a Salesforce **Note**. `renderRecapNote` produces the body; nothing
  posts it.
- Follow-up draft recipients from the call's external attendees, not from
  Graph's `createReply`, which addresses the last sender and therefore the BDR.
  `customerEmails` is already computed and correct and never used on the reply
  path.
- Recap written as a Salesforce **Note** on the opportunity as well as the Task.
  He pasted ours into a Note by hand the day after the call, then shares that
  Note with the solution engineer to prep the demo. That is the real consumer.
- Briefing enrichment: the account's own numbers, any prior proposal amount, and
  the person. He does the LinkedIn and website pass by hand every morning.

**This week**

- ~~Account linking off the BDR activity~~ DONE. The ladder lives in
  `lib/salesforce-account-match.ts` and now runs FIRST in the relink cron;
  domain matching is the fallback. Confirmed links went 39 to 78 of 92 deals.
  Two guards worth knowing: an account named "Tbd" is a real record in their
  org and two deals matched it through a contact, so placeholder names are
  demoted to `review`; and a legacy `0013j` match looks for its current `001RN`
  twin by name prefix, because the legacy records are where the typos are
  ("UNITED CUSOTMHOUSE BROKERS INC"). Still unresolved: 5 ambiguous (a person
  chooses), 4 review, 5 with no calls to match on
- Re-invite the bot by forwarding the invite to a DealRipe address, plus a ping
  to the rep while the bot is still in the lobby. On a prospect-hosted call the
  rep is the only person inside who can admit it.
- Route by call type. `Is_Renewal` and `Opportunity Type` are already on the
  Salesforce layout. A renewal QBR currently gets a new-business audit and lists
  budget and decision process as open on a customer who has paid for years.
  The ledger measured the cost of this: 0% follow-through on demo, follow-up
  and existing-customer calls against 25% on discovery. `lib/call-type-precall.ts`
  now resolves the type BEFORE the call and the briefing prompt states it as a
  fact. Note `calls.meeting_type` and `call_subtype` are written by
  transcript-sync AFTER capture, so they are null for the call being briefed:
  the pre-call resolver uses the deal's PRIOR calls plus the invite title.
  Backtested at 21 right, 2 wrong, and 35 of 58 still `unknown` for want of a
  signal, which is what the CRM and email inputs would close.
- ~~Rolldog reads outside the scope guard~~ DONE 2026-08-16. All five call
  sites are wrapped: `lib/pipeline-changes.ts` (deals carrying a rep forecast
  went 27 to 45), `app/deals/[id]/page.tsx`, `app/pipeline/page.tsx`,
  `lib/weekly-digest-data.ts`, plus `lib/snapshot.ts` earlier. Every path
  re-verified at 0 refused reads in `crm_access_log`. Recorded in full under
  hard-won facts, since the class of bug matters more than these instances.
- Close the loop on dead deals. The mapping and the digest exclusion are done;
  what remains is running `supabase/add-outcome-detail.sql` then
  `scripts/run-outcome-sync.ts --apply`, and deciding what a closed deal does to
  BRIEFING and SNAPSHOTTING, which still treat them as live.
- Write to both CRMs when both are linked
- Teams transcript access via Ernesto as the fallback when the bot never gets in
- Salesforce Account field writes: blocked on their contractor exempting the
  integration user from `Record_Triggered_ACCOUNT_Before_Save`
- Steven Johnson: calendar and a Rolldog uid in `REP_UID`

**The distance to what the decks promise**

- The learning loop. `outcome-sync` runs daily, produces nothing, and nothing
  consumes it. It is broken at the identifier (see the won/lost fact above): fix
  the deal-to-Opportunity mapping and the empty allowlist FIRST, but do it to
  catch pilot deals as they close, NOT because a training backlog exists: only 7
  closed opportunities have a DealRipe call before the close, and 5 of those are
  one hygiene sweep. Until this runs, "learns your winning sales motion" is a
  claim, not a feature, and it stays a claim for months after it runs.
  The prescription ledger (`prescribed_actions`, see
  `supabase/add-prescription-ledger.sql`) is the substrate: what the briefing
  told the rep, whether they did it, and what followed. Written on issue by
  `briefing-sync`, scored by `lib/prescription-scoring.ts`. Nothing consumes it
  yet either, but it now accumulates several rows per call instead of one row
  per deal per quarter.
- Per-rep commit calibration. The four-hourly snapshots already accumulate the
  data. Nothing computes it. This is the single reason Ashlee Horn trusted Clari
  within 5%.
- The waterfall view over those same snapshots
- Slack delivery. Ashlee said flatly she does not like email as a channel.
- The manager layer. Outputs go to rep, leader and CRM. In an org this size the
  manager is the person doing the inspecting.
- Mutual action plan
- Email reasoning in briefings: reply latency, new people cc'd, questions never
  answered, promises never delivered
- Demo strategy, then branded deck, then pricing estimate from their price book.
  Eduardo named this sequence himself and said not to start it until the recap
  is right.
- Populating the Rolldog checklist from calls (we read it, never tick it)
- Rep UI for the Magaya tenant
