---
name: DealRipe demo constraint
description: Friday April 24, 2026 demo with Paul Foreman (CRO, TopSort). Every product decision filters through "does this make the demo stronger?"
type: project
---

The DealRipe project has a single hard deadline: Friday April 24, 2026, demo with Paul Foreman, CRO at TopSort. The commercial ask at the end of the demo is a 90-day pilot. Three demo capabilities in build order: (1) post-call Scotsman extraction at /deals/[id]/extract, (2) pre-call briefing action, (3) pipeline triage view.

**Why:** Paul is the anchor customer. Everything that doesn't land on his laptop on April 24 is waste before that date. The constraint is in CLAUDE.md but worth surfacing here because it governs scope judgment calls on every task.

**How to apply:** Before proposing new scope, features, refactors, infrastructure, or polish, ask: does this make the April 24 demo stronger? If no, defer. Specifically explicit out-of-scope before April 24: real Salesforce/HubSpot/Gong/Sheets OAuth, auth, database, mobile responsive, async notifications, settings, billing, multi-tenant isolation. Fakes are fine if they read as real for 12-15 minutes.
