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
  audit daily; digest Tuesdays 11:00
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
transcript-sync  bot finishes -> transcript -> extraction -> recap email ->
                 follow-up draft in Outlook -> Rolldog write-back
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

**The recap reads like a form because it is generated from the extraction.**
Eduardo, 2026-08-14: "it's very tied to the checks that we have." This is
topology, not prompt quality. The fix is three independent passes over the
transcript rather than one derived pass: narrative in the customer's own words
with no framework vocabulary, then the gap audit unchanged, then demo strategy.
He was explicit that the audit stays. `docs/recap-target-eduardo.md` is the
structure he asked for, written by him.

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
- `rolldog-opp-detail.ts --name X` opportunities with owner, stage, created
- `link-deal.ts --deal X --opp N --apply` **writes**
- `probe-stage-gates.ts --opp N` discovery for the checklist endpoint
- `verify-stage-gates.ts --opps a,b,c` checks item ids are stable

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

- Recap rebuilt to `docs/recap-target-eduardo.md`. Three passes, not one.
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

- Account linking off the BDR activity, per the note above
- Re-invite the bot by forwarding the invite to a DealRipe address, plus a ping
  to the rep while the bot is still in the lobby. On a prospect-hosted call the
  rep is the only person inside who can admit it.
- Route by call type. `Is_Renewal` and `Opportunity Type` are already on the
  Salesforce layout. A renewal QBR currently gets a new-business audit and lists
  budget and decision process as open on a customer who has paid for years.
- Write to both CRMs when both are linked
- Teams transcript access via Ernesto as the fallback when the bot never gets in
- Salesforce Account field writes: blocked on their contractor exempting the
  integration user from `Record_Triggered_ACCOUNT_Before_Save`
- Steven Johnson: calendar and a Rolldog uid in `REP_UID`

**The distance to what the decks promise**

- The learning loop. `outcome-sync` runs daily and nothing consumes it. Until
  this runs, "learns your winning sales motion" is a claim, not a feature.
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
