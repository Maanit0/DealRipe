---
name: Extraction UI pacing principle
description: For DealRipe extraction flows, the "computation time" users perceive is the actual API call, not a post-response animation. Single simultaneous reveal, no staggered setTimeouts.
type: feedback
---

For DealRipe's Scotsman extraction flow (and similar AI-call-driven reveals), the user-perceived "computation time" is the actual Anthropic API call, not a post-response animation. All changed fields reveal simultaneously with a single 1.5s fade. If the API returns in under 4s, hold the loading state with a UI floor so the spinner is visible for at least 4s before reveal.

**Why:** User explicitly rejected the staggered setTimeout reveal I proposed. Staggering 120ms across 18 fields feels like theatrical padding; the honest beat is the real latency of the model call. An artificial floor preserves the "something happened" signal without faking computation.

**How to apply:** When designing reveal/loading UX for AI-driven features in this project, put perceived delay in the API call itself. Use a minimum-duration floor on the loading state if the call returns too fast. Reveal all changed items at once, not in sequence.
