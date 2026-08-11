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
money. Mark Buman is the sponsor, Mitch Nemmers the VP.

Six reps are enrolled: Juan Lopez, Eduardo Bencomo, Alexandra Suntrup, Daniel
Blitstein, Ariel Rodriguez, Steven Johnson. The first four have connected
calendars. **Steven has no Rolldog user id in `REP_UID`, so his deals can never
auto-reconcile.** Get that before he takes pilot calls.

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

**Salesforce is read-only today.** We resolve an Account by email domain for BDR
context. There is no Salesforce opportunity linking, `SALESFORCE_PILOT_OPPORTUNITY_IDS`
is empty, and `lib/salesforce-writeback.ts` has no caller.

**Free-mail domains never resolve by domain**, only by exact address. Matching
`%@gmail.com` once returned an unrelated company's account.

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

- Post-call draft voice tuning, one preview per rep
- Salesforce write-back: mapping layer exists, no caller
- Populating the Rolldog checklist from calls (currently we read it, never tick it)
- Email context into briefings: nothing is wired
- Weekly digest verification for six reps plus Mitch
- Rep UI for the Magaya tenant
- Deals needing a rep to resolve: TQL (7 candidates), Medov (17), Dunavant
  (only a 2021 record owned by another user), Milsped, Febest, Sunny Wing and
  Gezairi (no Rolldog opportunity exists at all)
