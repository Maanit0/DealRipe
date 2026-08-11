# DealRipe

## What this is
DealRipe is a qualification execution layer for B2B SaaS sales teams.
Reps run discovery calls. We extract answers to the company's specific
qualification framework (Scotsman, MEDDIC, custom) from call transcripts
and write them back to the CRM as structured field updates, so pipeline
data becomes trustworthy without depending on rep discipline.

The wedge: Gong and similar tools generate notes and activity records
from calls. They don't write to qualification fields. DealRipe does.

## The constraint that overrides everything else
Demo with Paul Foreman, CRO at TopSort, on Friday April 24, 2026.
The commercial ask at the end of the demo is a 90-day pilot.

Every product decision filters through one question: does this make
the April 24 demo stronger? If no, defer. No exceptions.

## Stack
- Next.js 14 (app router)
- Tailwind CSS
- TypeScript
- Anthropic API (model: claude-sonnet-4-6)
- No database. Seed data lives in /lib/seed-data.ts as TypeScript objects.
- Scotsman framework definition lives in /lib/scotsman.ts.
- Data structures include a `tenantId` field set to "topsort" everywhere,
  so the eventual multi-tenant refactor is a day of work, not a week.
  Never hardcode "Paul" or "TopSort" inside data, only as the tenantId value.

## Design language
Modern B2B SaaS. Inter font. Color palette:
- Navy #0F172A (primary text, headers)
- Green #10B981 (answered fields, positive states, CTAs)
- Red/coral #EF4444 (gaps, at-risk states)
- Amber #F59E0B (partial fields, warnings)
- White / light gray backgrounds, card-based layout

The visual reference is a polished modern CRM, not a dashboard tool.
Think Linear or Attio, not Salesforce.

## Paul's framework (hard-coded for the demo)
Scotsman is Paul's qualification framework. Eight categories with 18
total sub-questions. Each sub-question has an associated SPIN question
that a rep can ask to fill the gap.

The eight Scotsman categories:
- Scope: what they want, in their language
- Competition: who else is in the deal
- Originality: why us, why now, why this approach
- Timescale: when they need it live
- Size: deal value and contract structure
- Money: budget confirmed, source of funds
- Authority: economic buyer engaged, decision process mapped
- Need: quantified business pain

Full sub-question list and SPIN mappings live in /lib/scotsman.ts.
This file is the source of truth, never hardcode questions elsewhere.

## The seeded demo deal
Lumora Marketplace, mid-market online marketplace for home & lifestyle
brands. $340K ACV opportunity. Champion is Marcus Chen, VP Monetization
(ex-Wayfair). The deal looks healthy on rep forecast (70%) but has two
critical Scotsman gaps: no conversation with the CFO (Money) and the
CEO has never been engaged (Authority). DealRipe's adjusted forecast
is 40% probability with a Q3 (not Q2) close date.

Lumora is in TopSort's exact ICP shape: a marketplace ready to
"become a media company" by monetizing seller traffic. Comparable
to Poshmark or Trade Me at an earlier stage.

The demo moment: paste a transcript of Marcus's last call with the
rep, watch DealRipe extract the Scotsman fields, and see the gaps
flagged with the SPIN questions Paul has approved to address them.

## The three demo capabilities (build order)
1. Post-call extraction (the wedge)
   - Page: /deals/[id]/extract
   - Paste transcript, Claude extracts answers to all 18 Scotsman
     sub-questions, returns structured JSON, Opportunity Control
     sheet updates with green-highlighted fills and red-flagged gaps.

2. Pre-call briefing (builds on #1)
   - Action on the deal page: "Prepare next call"
   - Generates: call objective, top 3 SPIN questions to fill the
     highest-value gaps, suggested next-step commitment, one-line
     "what's at risk if this call goes badly."

3. Pipeline triage view (the closer)
   - Page: /pipeline
   - Dashboard with 5-7 seeded deals showing Scotsman completion %,
     days in stage, rep forecast vs DealRipe adjusted forecast.
     At-risk deals (stage progression > Scotsman completion) flagged red.
   - Lumora is the live one. Others are static visual context.

## Integration theater (fakes that look real on demo day)
Paul will ask "how does this connect to my actual workflow?" These
fakes exist to answer that question without burning days on real OAuth.

### Google Sheets import (matches Paul's actual workflow)
Paul keeps his Opportunity Control sheet in Google Sheets, not Salesforce.
The onboarding flow at /onboarding shows a fake "Connect Google Sheets"
button. On click, simulate a 1.5-second OAuth-style loading state, then
display "Synced 7 deals from Opportunity Control" and route to /pipeline.
No real OAuth, no real Sheets API. The seed data was always there.

### Gong "connected" UI state (closes the "reps won't paste transcripts" objection)
On the deal page, show a "Recent calls from Gong" section listing 3-4
seeded calls. The Marcus Chen call is the most recent. Clicking it
opens the same extraction flow as the paste-transcript page, but
pre-fills the textarea with the seeded transcript. UI says "Synced
from Gong 2 minutes ago" with a Gong logo.

This is a 30-minute UI fake. No Gong OAuth, no Gong API. The objection
gets neutralized at demo time without the integration cost.

## Conventions
- No em-dashes in any user-facing copy. Ever. Use commas, periods,
  or rephrase. (Paul flagged em-dashes as AI-generated.)
- Use simple, direct language. Paul's words, not marketing words.
- "Opportunity Control" is what Paul calls his sheet. Use that exact
  phrase wherever the Scotsman sheet is referenced in the UI.
- The product name is DealRipe. Never "Deal Ripe", "DealRipe.ai",
  or "Deal Ripe AI". One word, capital D, capital R.
- Avoid sycophantic copy. No "Great call!" or "Awesome insights!"
  Paul's CRO brain treats that as noise.

## Anthropic API usage
- Model: claude-sonnet-4-6 (the current balanced production model
  as of April 2026, $3/$15 per million tokens, supports 1M context)
- For Scotsman extraction, prompt should request structured JSON
  output with one entry per sub-question ID, marking each as either:
    { answered: true, answer: string, confidence: number, evidence: string }
    { answered: false }
- Use temperature 0.1 for extraction tasks (we want deterministic,
  evidence-grounded outputs, not creative ones).
- Include the full Scotsman sub-question definitions in the system
  prompt so Claude knows exactly what to look for.
- The ANTHROPIC_API_KEY env var lives in .env.local and must be
  in .gitignore. Never log it, never commit it.

## Demo day mechanics
- Friday April 24, 2026
- Walk Paul through the flows in this order:
  1. Onboarding view, fake Sheets connect (5 seconds, "this is how
     I'd connect your Opportunity Control")
  2. Pipeline view (5 seconds of context, then click into Lumora)
  3. Lumora deal page (recognition: "this is my Opportunity Control")
  4. Click the Marcus Chen call from Gong, watch extraction (the
     magic moment)
  5. Click "Prepare next call" (the operational value)
  6. Back to pipeline view (the scaling moment)
- Total demo runtime target: 12-15 minutes, leaving 15+ for the
  pilot conversation.

## What's explicitly out of scope before April 24
- Real Salesforce or HubSpot integration (Paul uses Sheets, not
  Salesforce, for deal inspection)
- Real Google Sheets OAuth or API (the fake import flow is enough
  for demo recognition)
- Real Gong OAuth or API (the fake "Recent calls from Gong" UI
  closes the integration objection without the engineering cost)
- Authentication / login (single demo user on your laptop)
- True multi-tenant data isolation (tenantId field exists but
  isolation is not enforced)
- Mobile responsive (demo is on Paul's laptop)
- Email notifications, Slack notifications, anything async
- Settings pages, admin panels, billing
- Anything that requires a database
- Adding new capabilities not in the three above