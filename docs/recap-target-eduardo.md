# The recap Eduardo actually wants

Written from the 2026-08-14 call and from the output he produced himself by
pasting the Dunavant transcript into ChatGPT. That output is the spec. This file
exists so the recap is built to a customer's artifact rather than to our idea of
one.

## What he said, verbatim

> "The recap is good, but I feel it's very very targeted, very straight to
> you're missing XYZ. Like a questionnaire kind of thing."

> "It's dry. It's a little dry. I need more. The volumes, primary points,
> accuracy. It was discussed there."

> "It's very tied to the checks that we have. It's like, is this covered, is this
> covered. So we need also the nuances, and the things they called out in their
> operation. For example they talk about we start by quote and this and that."

> "This does not allow me to prepare for a demo. This is pretty much an overview.
> Hey what's your budget, what's this, are they positioned to move. It doesn't
> give me the nitty gritty detail, the data I need to move and demo them."

And the part that is easy to miss, because it protects what already works:

> "The audit is fine, because it flushes out those points. Putting it in front of
> us, hey remember you're missing this and that, which is always good. Like the
> coaching, hey we moved too fast here and there. I love that. But I was looking
> for more like something that helps me prepare for the demo."

So this is **additive**. Nothing in the gap audit gets removed.

## Why it reads like a form

The recap is generated from the extraction. The extraction is a framework, so the
recap inherits the framework's shape. That is a topology problem, not a prompt
quality problem, and no amount of rewriting the recap prompt fixes it while the
recap's only input is a list of filled and unfilled fields.

**Three independent passes over the same transcript. Not one derived pass.**

## Pass 1: narrative

The conversation as a readout. No framework vocabulary anywhere in this pass. No
"SQL2", no "compelling event", no "still open". Written as if by someone who was
on the call and is briefing a colleague who was not.

From his Dunavant output, the sections that carried this:

- **Executive summary.** Two or three sentences. What this account is, what they
  are trying to do, and how serious it is.
- **Current environment.** Their systems, their offices, their headcount, their
  volumes, in their numbers. "Approximately 125 users." "Under 1,000 global
  freight forwarding transactions per month." "Approximately 95% ocean, roughly
  a 50/50 import export mix."
- **Pain points and decision drivers.** Ranked, with the customer's own words
  attached. When asked why they were switching, Debra answered: "Price." Then
  immediately: price alone will not win this.
- **The specific operational detail nobody would have captured.** In his output
  this was the manual product data problem: inbound transactions of 20 to 100
  lines, outbound up to 600, unit conversions recalculated by hand, no central
  product database, and an internal project starting to build one. That single
  paragraph is worth more than the whole gap audit, and it exists only because
  someone read the transcript for what was said rather than for what was missing.
- **Requirements by area.** Grouped the way the customer's business is grouped,
  not the way our framework is grouped.
- **Buying process.** Who evaluates first, who gets brought in later, who is
  explicitly not the decision maker, how legal works.
- **Timeline and urgency**, with the evidence for it.

## Pass 2: the gap audit

Unchanged from today. SQL0 through SQL5, what was confirmed on this call, what is
still open. He values it and asked for it to stay. It goes **after** the
narrative, not before, and it does not colour the narrative's language.

## Pass 3: demo strategy

The thing he asked for by name and the thing no generic tool produces.

> "Recommended demo strategy. You know, start by this because we talked about
> that. I'd say we should do it first, cost of compliance."

From his output, the shape:

- Multi-session rather than one demo, when the scope warrants it
- Each session named, with what to cover in it and in what order
- **Why that order**, tied to what the customer said
- A critical preparation item: what we need to validate internally before the
  session, because it might be a functional gap. His was: "validate the product
  database and mass data-management story internally before this session."
- Risks, stated plainly. His listed five, including "customs sophistication is
  critical" and "they will likely evaluate Magaya against CargoWise
  functionality rather than simply price."
- A recommended positioning sentence

## Routing

A renewal or QBR must not receive a new-business audit. Medov is an existing
customer and got budget and decision process listed as open on an account that
has paid for years.

`Is_Renewal` and `Opportunity Type` are already on the Salesforce opportunity
layout. Read them. A support call on an existing account with no open
opportunity should produce a narrative and no qualification record at all.

## The follow-up email is a separate artifact with a separate voice

His note on it:

> "This is not wrong, it's a little dry. I would like to have more like, we
> discussed this, we agreed this. Kind of like have a starting point in the next
> conversation."

And the failure he watched a rep hit: proposing a next step with no time, because
the rep could not see a slot. Pull a real time from the rep's calendar.

## The end state, in his words

> "You start with the discovery call and then you got, okay, this is your recap,
> this is your follow-up email, this is your demo strategy, this is the suggested
> deck."

Then the pricing estimate from their own price book, and eventually an order form
written back into Salesforce. He said not to start any of that until the recap is
right, which is the correct sequence and should be held to.

## How to know it is done

Run the new recap on the Dunavant transcript. Put it beside his ChatGPT output.
If a reader cannot tell which is which, **and ours carries the three things his
cannot** — the qualification gaps, the history of prior calls on that deal, and
the CRM state — it passes. If ours is shorter, safer, or more structured than
his, it has failed.
