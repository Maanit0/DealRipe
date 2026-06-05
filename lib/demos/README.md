# Demos vs. Pilots

This folder holds **prospect demos**: static, in-repo pitch artifacts shown in
(gated) demo / discovery calls. They contain NO live data and NO database
access. Each demo is self-contained and registered in `index.ts`.

**Production pilots** (real customers like Magaya, with live Salesforce / Teams /
Rolldog integrations and Supabase-backed data) do NOT live here. Those are
resolved via `lib/tenant-deal-lookup.ts` and `lib/pilot-config.ts`. Never mix
real customer data into this folder.

## Add a new prospect demo (3 steps)
1. `cp -r _template <prospect>`  (e.g. `northwind`)
2. Edit `<prospect>/index.ts`: rename the export, fill in the company, deals
   (`movements`), prescriptive actions (`leverage`), and numbers. Pull realistic
   figures from that prospect's discovery-call transcript.
3. Register it in `index.ts`: add `import { NORTHWIND } from "./northwind";` and
   a line in `DEMOS`.

The gated `/forecast` route reads the registry, so the new demo shows up at
`/forecast?tenant=<slug>` automatically.

## Privacy rule
A prospect must never see another prospect's data. Demos sit behind the access
gate (`middleware.ts`), and the public site links to "Book a demo", not a
self-serve demo.
