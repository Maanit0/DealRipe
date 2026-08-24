# How Magaya actually sells, from 90 captured calls

Measured 2026-08-24. This exists because Eduardo asked for a deck generated from
the recap and the first question is which deck: one artifact, or a different one
per stage. The calls answer it, and the answer is two.

## The call types, and their weight

    discovery   40   44%
    proposal    16   18%
    demo        16   18%
    customer    11   12%   existing customer, not new business
    follow_up    7    8%

## Demo and proposal are different events, and the reps' own titles prove it

Demos are named after the product being shown:

    Demo All Square Logistics | Magaya ABI
    GHY Entry View Audit Session
    TOC Inbond Additional Session | Magaya ABI
    Luke Rousselle <> Magaya; Software Demo

Proposals are named after money:

    Magaya estimate for Dunavant
    Zas By JMC (Cost Budget)
    Magaya (Discussion / Cost Budget)
    Proposal Review All Square Logistics | Magaya ABI

So a demo deck and a proposal deck are not the same document. A demo deck maps
what the customer said hurts onto what they are about to be shown. A proposal
carries scope, pricing and terms, and Eduardo's Dunavant artifact is literally
titled an estimate. Building one artifact for both produces something that is
too commercial for a demo and too thin for a negotiation, which is exactly the
mistake the follow-up draft was making until the call-type routing landed.

## The sequence is NOT discovery, demo, proposal

Of the 14 deals with two or more captured calls:

    4x  discovery -> proposal
    3x  demo -> proposal
    2x  customer -> customer
    2x  discovery -> demo
    1x  demo -> demo -> follow_up
    1x  discovery -> demo -> proposal
    1x  demo -> follow_up

Exactly ONE deal ran the textbook discovery, demo, proposal. The most common
path skips the demo entirely.

And across all 16 proposal calls:

    4   followed a captured demo
    12  had no captured demo before them

## Read that number carefully, because it has two explanations

**Either** Magaya prices before demoing on most deals, which is a real motion
for a customs-filing product a broker already understands.

**Or** the demo happened and we did not capture it. That is not hypothetical:
19 of the last 24 lobby timeouts were on MAGAYA-organised meetings, and a demo
is a Magaya-organised meeting. So an unknown share of those 12 are demos we were
locked out of rather than demos that never happened.

Do not build on the 12 as though it were a finding about their process. It is
partly a finding about our capture rate. Getting Ernesto to change the Teams
lobby policy would resolve the ambiguity as a side effect, which is one more
reason it is the highest-leverage thing not currently being built.

## What this means for the deck

1. Two artifacts, not one, keyed on `call_subtype` the way the recap and the
   follow-up draft already are.
2. The demo deck is the one to build first. Eduardo asked for demo strategy
   specifically, `buildDemoStrategy` already produces the content, and
   `docs/recap-target-eduardo.md` is his own spec for it.
3. The proposal artifact needs pricing from Magaya's price book, which DealRipe
   does not have. Eduardo named that sequence himself: demo strategy, then
   branded deck, then pricing estimate. Follow it.

## Limits

14 deals with more than one captured call, and 16 proposal calls. Every
proportion here is small-n. The direction is clear and the exact ratios are not,
and nothing in this file should be quoted as a rate.
