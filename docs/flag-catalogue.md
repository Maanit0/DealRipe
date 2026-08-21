# The flag catalogue, mapped to data that exists

Source: the Kiddom ops leader's core-pipeline and forecast-validation flags,
2026-08-20. This file is the audit that has to happen before any of it is built,
because a catalogue written against one company's CRM is a specification, not an
implementation, and the difference is entirely which fields are populated.

## The band mapping, and why it is inverted from intuition

**Low is the MOST certain band. High is the least.** It is a risk scale.

The spec says it plainly under "Suggested evidence by forecast bucket": Low
requires "Committed stage; clear customer commitment; engaged economic buyer;
validated close date; known procurement path". High is "Qualified opportunity
with active customer interest, a plausible timeline". And "High should represent
credible upside, not a storage bucket for stale deals."

    Low     ->  Commit
    Medium  ->  Expect
    High    ->  Pipeline

Reading these the intuitive way inverts every one of the 21 forecast-validation
flags. "High Forecast Is Inactive" is a complaint about a WEAK deal going stale,
not about a strong one.

Kiddom stage names map onto Magaya's SQL ladder as:

    Qualified   ->  SQL1 to SQL2
    Quoted      ->  SQL3
    Committed   ->  SQL4 to SQL5

## What Salesforce actually holds, measured 2026-08-20

    Quote                     21,194 rows      readable
    OpportunityLineItem      224,875 rows      readable
    OpportunityContactRole     4,065 rows      readable
    Task, last 60 days        41,812 rows      readable
    Event, last 60 days        1,027 rows      readable
    OpportunityFieldHistory  147,777 rows      readable, back to 2025-02-19

So the quote flags, the product flags, the role-based buyer and champion flags
and every activity flag are buildable at Magaya. That was not obvious and it is
the reason this audit exists rather than a guess.

## The one finding that changes the design

**`Opportunity.NextStep` is populated on 34 of 4,443 open opportunities. 0.8%.**

Four flags in the catalogue are built on it: No Clear Next Step, Past-Due Next
Step, Seller-Only Next Step, and Low Forecast With Past-Due Next Step. Shipped
as written they fire on 99.2% of the book.

A flag that fires on everything is not a flag. It is a field-adoption complaint
wearing a flag's clothes, and it trains a leader to skip the section, which
costs more than the four flags are worth.

It is also the wrong response to the situation. DealRipe already extracts the
agreed next step from the CALL, and `DealChangeRecord.agreedNextStep`,
`nextStepIsMeeting`, `nextStepIsCustomerWait` and `repOwedMeeting` already carry
it with the customer-versus-seller distinction the catalogue asks for. So the
right move is to WRITE the next step Salesforce is missing, and flag only the
cases our own extraction can judge: a next step that is a seller action with no
customer commitment, or one whose date has passed. Flagging the absence of a
field nobody fills is the least useful thing available.

## Status of every flag

Built means it exists in `lib/deal-flags.ts` today and fires on live data.

### Core pipeline

| Flag | Status | Notes |
| --- | --- | --- |
| Stage Stale | buildable | OpportunityFieldHistory StageName, thresholds per band |
| No Recent Activity | BUILT | `losing_momentum`, and better: measured against the deal's OWN cadence, not a fixed 21 days |
| Late-Stage Inactivity | buildable | same signal, gated on stage |
| Single-Threaded Deal | BUILT | `band_above_pipeline_single_threaded`, from who actually SPOKE on calls rather than from contact records |
| No Economic Buyer | BUILT | `commit_without_economic_buyer` |
| Economic Buyer Not Engaged | buildable | OpportunityContactRole joined to call rosters and the mailbox |
| No Champion | buildable | OpportunityContactRole, plus `contacts.relationship` |
| Champion Gone Quiet | buildable | `contacts.last_contacted_at` plus the email log |
| No Upcoming Meeting | buildable | `nextMeetingBooked` already computed |
| Emailing without reply | BUILT | `emailing_without_reply`, needs the mailbox and no CRM holds it |
| Meeting Canceled, Not Rescheduled | buildable | calendar-sync sees cancellations |
| Proposal Sent, No Follow-Up | buildable | Quote.CreatedDate plus the email log |
| Quote Not Confirmed Received | buildable | Quote plus inbound mail |
| No Clear Next Step | REDESIGN | NextStep is 0.8% populated. Write it, do not flag it |
| Past-Due Next Step | buildable | from OUR extracted next step, not the CRM field |
| Seller-Only Next Step | buildable | `nextStepIsCustomerWait` already distinguishes this |
| Decision Date Unknown | BUILT | the `close_date_validated` gate |
| No Decision Process | BUILT | the `decision_process_mapped` gate |
| No Budget Confirmation | BUILT | `commit_without_budget` |
| Missing Procurement Path | needs a field | no Magaya equivalent found on describe |
| Missing Quote or Products | buildable | Quote and OpportunityLineItem |
| Placeholder Quote Aging | buildable | Quote plus stage age |
| Quote Expiring Soon | buildable | Quote.ExpirationDate |
| Quote Expired | buildable | Quote.ExpirationDate |
| Close Date Slipped Multiple Times | BUILT | `close_date_repeatedly_pushed` |
| Major Close-Date Slip | buildable | the delta is already in the close-date history |
| Close Date in Past | BUILT | `close_date_past` |
| Close Date Unsupported | BUILT | the `close_date_validated` gate |
| Closing Soon, Not Ready | BUILT | `close_date_unachievable` |
| Implementation Timeline at Risk | Kiddom only | print delivery and professional learning have no Magaya analogue |
| Duplicate Opportunity Risk | buildable | several open opportunities on one account, already read |
| Stale Manager Review | needs a field | no manager-review log exists |

### Forecast validation

Every one of these is buildable, because each is a JOIN between the rep's band
and evidence DealRipe already computes. They are the cheapest high-value flags
in the catalogue and they are what a CRO actually opens the tool for.

The two that do not survive translation:

- **Low Forecast With No Board Meeting Date.** School boards approve Kiddom
  purchases. Magaya has no equivalent decision body, and inventing one would be
  a flag nobody can act on.
- **Forecast Upgraded Without Evidence** is misnamed in the source: it describes
  High to Medium to Low, which on the Low-is-strongest scale is an UPGRADE in
  confidence. Worth keeping, worth renaming.

`lib/forecast-why.ts` already implements the hardest one of this group,
**Forecast Not Updated After Negative Signal**, in its stronger form: it names
who moved the number and whether the calls support the move.

## Order to build

1. The forecast-validation set, because it is a join over data already in hand
   and it is what a leader opens the tool for.
2. Quote-based flags, now that Quote and OpportunityLineItem are confirmed
   readable.
3. Role-based buyer and champion flags from OpportunityContactRole.
4. Write `Opportunity.NextStep` from the extracted next step, then flag it.
