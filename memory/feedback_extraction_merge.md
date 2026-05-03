---
name: Scotsman extraction merge semantics
description: Extraction results merge with prior state; they cannot demote a Yes. Visible motion is always toward more answers.
type: feedback
---

When new extraction results come back from a call, merge them with the deal's prior extraction state. A new extraction can promote Unknown → Yes/No or No → Yes, but cannot demote a Yes back to Unknown or No.

**Why:** User explicitly chose merge over replace. The demo's before/after dynamic depends on the user seeing partial qualification from prior calls before clicking Extract, then watching gaps fill in. Demotion would create visual regressions (green fields going gray) that contradict the product story: DealRipe is accumulating qualification evidence across calls, not re-running discovery from scratch on each call.

**How to apply:** Any code that writes new extraction results to a deal must merge, not overwrite. Preserve existing Yes fields. Upgrade Unknowns and Nos when new evidence supports it. If you're tempted to use `deal.extraction = newExtraction` directly, stop and write a merge helper.
