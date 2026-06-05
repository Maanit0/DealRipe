# DealRipe Technical Audit for External Security Review

**Audience:** External security reviewer (e.g. Magaya IT, prospective customer InfoSec)
**Repo state as of:** June 3, 2026 (refresh of the May 15, 2026 snapshot)
**Audit method:** Direct file inspection only. Every claim cites a file path and line range. Nothing in this document was assumed from documentation.

This audit answers a single question per section. Where a feature is mocked rather than functional, that fact is called out explicitly so the reviewer does not over-credit the product. Where a control is real, the file enforcing it is cited.

### Changes since the May 15 snapshot

The deltas are concentrated in §1, §2, §4, §5, §6, §8, and §9. The substantive changes since the May 15 audit:

- The legacy auth shell (`lib/auth.ts`, `app/login`, `app/dashboard`, `app/onboarding` legacy variant) and the six legacy API routes (`score-call`, `coaching`, `persona`, `questions`, `activity-basis`, `scores`) have been deleted. The recommended cleanup from §6 and §9 of the May 15 audit is done. Zero hardcoded credentials remain in the source tree.
- `/api/debug/extract-lumora` is now env-gated behind `ENABLE_DEBUG_ROUTES` and returns 404 unless that flag is set.
- The extraction pipeline has been refactored: all transcript handling now flows through a single chokepoint at `lib/transcript-ingest.ts` (`ingestTranscript()`). The route handler at `/api/extract-scotsman` is a thin HTTP wrapper. The DPA section 3.6 commitments are documented in the file header.
- A CRM access enforcement layer (`lib/crm-scope.ts`, `lib/rolldog.ts`, Supabase `crm_access_log` table) now exists. Frozen field allowlists, fail-closed empty pilot ID set, append-only audit log. Rolldog HTTP code is stubbed pending credentials from Jeff (June 9 call). See §5.

---

## 1. Stack and architecture

### Framework

- **Next.js 14.2.15** (App Router) ([package.json:14](package.json#L14))
- **React 18.3.1**, **TypeScript 5.6.3**, **Tailwind CSS 3.4.13**
- **Node runtime** is pinned on every API route via `export const runtime = "nodejs"`. Verified in [app/api/extract-scotsman/route.ts:14](app/api/extract-scotsman/route.ts#L14), [app/api/prepare-briefing/route.ts:17](app/api/prepare-briefing/route.ts#L17). No Edge runtime, no streaming.

### Database

- **Supabase Postgres**, accessed via `@supabase/supabase-js ^2.105.3` ([package.json:13](package.json#L13)).
- Two client roles in code:
  - **anon** client via `supabaseClient()` ([lib/supabase.ts:13](lib/supabase.ts#L13)). All queries subject to RLS.
  - **service role** client via `supabaseAdmin()` ([lib/supabase.ts:29](lib/supabase.ts#L29)). Lazy-initialized, throws if called from the browser (`typeof window !== "undefined"` guard at line 30). Bypasses RLS by Supabase convention.
- The service role key is intentionally **not** prefixed `NEXT_PUBLIC_`, so it is not inlined into the browser bundle ([.env.local.example](.env.local.example)).

### Hosting

- **Vercel.** `.vercel/project.json` is present; the Next.js routes are configured with `maxDuration = 60` for LLM round-trips ([app/api/extract-scotsman/route.ts:15](app/api/extract-scotsman/route.ts#L15)).
- No Docker, no separate worker, no queue, no message broker, no Kubernetes config in the tree.

### Structural overview

```
app/                # Next.js App Router pages + API routes
  api/
    extract-scotsman/route.ts       Active demo path. Thin HTTP wrapper that
                                      calls lib/transcript-ingest.ts.
    prepare-briefing/route.ts       Active demo path. Calls Anthropic.
    debug/extract-lumora/route.ts   Debug route. Returns 404 unless
                                      ENABLE_DEBUG_ROUTES=true.
  forecast/, demo/aware/, pipeline/,
    deals/, onboarding/, rep-*/     Demo surfaces.
components/        Presentational React components.
lib/
  transcript-ingest.ts              Single chokepoint for transcript ingest
                                      (LLM call + audit). DPA §3.6 commitments
                                      documented in the file header.
  crm-scope.ts                      CRM access enforcement (allowlists,
                                      assertScopedRead/Write, audit hook).
  rolldog.ts                        Rolldog client scaffold (asserts before
                                      any network code; HTTP stubbed pending
                                      credentials).
  (other lib files: anthropic, supabase, seed-data, scotsman, etc.)
scripts/           Operator-run scripts (tsx). Not part of deployed runtime.
supabase/          schema.sql, rls.sql, RLS-POLICIES.md
deletion-confirmations/  Tamper-evidence records (SHA-256 signed). One file today.
```

### Request lifecycle for the wedge feature (post-call extraction)

1. Client `<ExtractView>` posts `{ transcript, callId }` to `/api/extract-scotsman` ([components/ExtractView.tsx:66](components/ExtractView.tsx#L66)).
2. Route handler is a thin HTTP wrapper: parses the body and calls `ingestTranscript({ source: "manual_paste", externalCallId, transcript })` ([app/api/extract-scotsman/route.ts:33-43](app/api/extract-scotsman/route.ts#L33-L43)).
3. `ingestTranscript` ([lib/transcript-ingest.ts](lib/transcript-ingest.ts)) validates the source enum (closed allowlist `"manual_paste" | "recall_ai"`), validates transcript length, and **resolves the deal server-side** from the call id (the client cannot specify the deal — the server determines it).
4. `extractAndStore` wraps the transcript in `<transcript>…</transcript>` delimiters and sends it as the user message of an Anthropic `messages.create` call. System prompt assembled from [lib/extraction-prompt.ts](lib/extraction-prompt.ts).
5. Parses the model output (strips markdown fences, brace-bounded JSON extraction) and validates every field against a discriminated union (`validateFieldExtraction` in [lib/transcript-ingest.ts](lib/transcript-ingest.ts)).
6. Writes audit rows to Supabase via `writeAuditTrail()` using the service role client (`extraction_runs` + `field_extractions` upsert). The raw transcript is never persisted.
7. Returns the validated extraction to the client.

---

## 2. External API integrations

### Anthropic — **production-functional**

- **SDK:** `@anthropic-ai/sdk ^0.32.1` ([package.json:11](package.json#L11)).
- **Client construction:** [lib/anthropic.ts:3-5](lib/anthropic.ts#L3-L5). Uses `process.env.ANTHROPIC_API_KEY`.
- **Default model:** `claude-sonnet-4-6` (overridable via `ANTHROPIC_MODEL`) ([lib/anthropic.ts:8](lib/anthropic.ts#L8)).
- **Call sites (every code path that invokes Claude):**
  | Code path | File | Purpose | Status |
  |---|---|---|---|
  | `extractAndStore` (called by `/api/extract-scotsman` via `ingestTranscript`) | [lib/transcript-ingest.ts](lib/transcript-ingest.ts) | Scotsman extraction from transcript | Active |
  | `/api/prepare-briefing` | [app/api/prepare-briefing/route.ts](app/api/prepare-briefing/route.ts) | Pre-call briefing | Active |

  The six legacy LLM routes called out in the May 15 audit (`score-call`, `coaching`, `persona`, `questions`, `activity-basis`, `scores`) and the legacy lib helpers that backed them have been deleted. `grep -rn "anthropic.messages" app lib` returns exactly the two active call sites above.
- **Timeout:** 45 s `AbortController` per call ([lib/transcript-ingest.ts](lib/transcript-ingest.ts), constant `REQUEST_TIMEOUT_MS`). Vercel function `maxDuration` set to 60 s.

### Supabase — **production-functional**

- Two clients as described in §1.
- Used from server-side route handlers and migration scripts only.

### Salesforce — **NOT integrated. Mock UI only. Read field allowlist now declared.**

- The only Salesforce-named surface is [components/aware/SalesforceSyncButton.tsx](components/aware/SalesforceSyncButton.tsx).
- The "sync" is a `setTimeout(setPhase("synced"), 1700)` ([components/aware/SalesforceSyncButton.tsx:18](components/aware/SalesforceSyncButton.tsx#L18)). No HTTP request, no OAuth, no SDK import.
- `SALESFORCE_FIELD_MAP` ([lib/aware-data.ts:497](lib/aware-data.ts#L497)) is a static `Record<DuctKey, string>` of decorative Aware-demo field names.
- **New since May 15:** `SALESFORCE_READ_FIELDS` ([lib/crm-scope.ts](lib/crm-scope.ts)) is a frozen allowlist of `["StageName", "IsClosed", "IsWon"]`, scoped to closed-won/closed-lost reads only. No writes. When real Salesforce reads are wired, they will pass through `assertScopedRead`.
- The Salesforce integration card in onboarding ([lib/onboarding-data.ts:22](lib/onboarding-data.ts#L22)) is one of the simulated connection cards; clicking it triggers a 1.5 s spinner client-side (no network call).

### Rolldog — **Enforcement layer built, credentials pending (June 9 Jeff call).**

- Client scaffold at [lib/rolldog.ts](lib/rolldog.ts). Two functions: `readOpportunity(id, fields)` and `writeOpportunity(id, updates)`. Each one calls the corresponding `assertScopedRead` / `assertScopedWrite` **before any network code runs**, then throws `RolldogPendingError("Rolldog credentials pending (Swagger docs expected from Jeff, June 9 call)")` until `ROLLDOG_BASE_URL` / `ROLLDOG_CLIENT_ID` / `ROLLDOG_CLIENT_SECRET` are populated and the Swagger lands.
- The asserts live in [lib/crm-scope.ts](lib/crm-scope.ts): see §5 for the full enforcement model.
- Not yet wired into any route. The integration handler that calls `readOpportunity` / `writeOpportunity` lands when credentials arrive.
- Onboarding card at [lib/onboarding-data.ts:23](lib/onboarding-data.ts#L23) is still a simulated connection card; it is not yet the real OAuth path.

### Microsoft Graph — **NOT integrated.**

- Grep `microsoft.graph|graph.microsoft|@microsoft/microsoft-graph-client` across the source tree returns zero results.
- The "Microsoft Teams" card in [lib/onboarding-data.ts:18](lib/onboarding-data.ts#L18) is a simulated connection card. No SDK installed, no OAuth flow, no HTTP call.

### Recall.ai — **NOT integrated. Typed stub for delete-after-pull.**

- The only Recall-named code is `deleteSourceRecording(externalCallId)` in [lib/transcript-ingest.ts](lib/transcript-ingest.ts), which is a typed stub that documents the eventual `DELETE https://us-west-2.recall.ai/api/v1/bot/{bot_id}/delete_media/` call. The stub honors the DPA section 3.6 delete-after-pull commitment by making the call path visible in the chokepoint module before credentials arrive.
- No SDK installed, no fetch call, no webhook route.

### Gong, Granola, Google Calendar, Gmail, Slack — **NOT integrated.**

- All present only as onboarding cards in [lib/onboarding-data.ts](lib/onboarding-data.ts). No SDKs in `package.json`. No fetch calls. No OAuth.

### Apollo.io MCP server — **announced as a connectable MCP tool to the agent; not used by the deployed app.**

- `grep -rn "apollo" --include="*.ts"` returns zero results across `app`, `lib`, `components`, `scripts`.
- The Apollo.io tools surfaced via MCP are available to the agent that maintains this repo, not to the running product.

### Summary

**Two external services are actually wired:** Anthropic and Supabase. **One enforcement scaffold is in place pending credentials:** Rolldog (lib/rolldog.ts asserts before any network code; HTTP stubbed). Everything else named in the UI is a simulation. The onboarding flow at `/onboarding/connect` is explicitly UI scaffolding ("Connection simulation" comments in [app/onboarding/connect/page.tsx](app/onboarding/connect/page.tsx)).

---

## 3. Multi-tenancy and data isolation

### Schema-level tenant scoping

- Every Postgres table other than `tenants` itself carries a `tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE` column. Verified in [supabase/schema.sql](supabase/schema.sql) at:
  - `deals` line 26
  - `contacts` line 48
  - `calls` line 68
  - `transcripts` line 89
  - `field_extractions` line 102
  - `extraction_runs` line 138
  - `briefing_runs` line 159
- Indexes on `tenant_id` exist for every table (lines 41, 61, 82, 95, 115, 151, 171 in the same file).

### Database-level enforcement (fires for every connection, including service role)

Two trigger families enforce tenant integrity at the database level. Critically, these triggers apply even when RLS is bypassed by the service role.

1. **`enforce_tenant_alignment`** ([supabase/schema.sql:196-235](supabase/schema.sql#L196-L235)). Before any INSERT or UPDATE, looks up the parent row's `tenant_id` and rejects if the child's `tenant_id` does not match. Example failure mode: a `contacts` row whose `tenant_id = X` references a `deals` row whose `tenant_id = Y` is rejected with a clear error.
2. **`prevent_tenant_id_change`** ([supabase/schema.sql:278-322](supabase/schema.sql#L278-L322)). Before any UPDATE, raises an exception if `OLD.tenant_id IS DISTINCT FROM NEW.tenant_id`. Tenant assignment is therefore immutable once written.

### RLS policies (filter every request through the public PostgREST API)

- All 8 tables have `ALTER TABLE … ENABLE ROW LEVEL SECURITY` applied (verified in [supabase/rls.sql](supabase/rls.sql)).
- **22 policies total** ([supabase/rls.sql](supabase/rls.sql)):
  - `tenants`: SELECT for authenticated users only.
  - 7 tenant-bearing tables × {SELECT, INSERT, UPDATE} = 21 policies.
  - **DELETE has no policies on any table.** Deletes are not allowed through the public API for any role. Only the service role (used by the operator-run `delete-tenant-data.ts` script) can issue deletes.
- Tenant scoping for authenticated users uses the JWT claim:
  ```sql
  (auth.jwt() ->> 'tenant_id') = tenant_id::text
  ```
  See e.g. `deals_select` ([supabase/rls.sql:74-83](supabase/rls.sql#L74-L83)).

### Demo-time fallback (must be removed before real auth lands)

- Every SELECT policy includes a temporary anon-role fallback:
  ```sql
  OR ((auth.jwt() ->> 'tenant_id') IS NULL
      AND tenant_id = demo_topsort_tenant_id())
  ```
- The function `demo_topsort_tenant_id()` is `SECURITY DEFINER` ([supabase/rls.sql](supabase/rls.sql)) so the fallback resolves without giving anon a SELECT on `tenants`.
- **Removal path is documented** in [supabase/RLS-POLICIES.md](supabase/RLS-POLICIES.md) under "Temporary anon fallback". This is the one item a reviewer will flag, and it is owned and documented.

### Where tenant context is enforced in code

- **Server-side writes** (`/api/extract-scotsman`, `/api/prepare-briefing`) resolve the tenant slug to a UUID via `resolveTenantId('topsort')` in [lib/tenant-deal-lookup.ts:15-36](lib/tenant-deal-lookup.ts#L15-L36) and pass it explicitly into every Supabase insert. There is no path in code that writes without setting `tenant_id`.
- **The slug `'topsort'` is hardcoded** in both routes ([app/api/extract-scotsman/route.ts](app/api/extract-scotsman/route.ts) constant `TENANT_SLUG = "topsort"`, [app/api/prepare-briefing/route.ts:14](app/api/prepare-briefing/route.ts#L14)). This is correct for the single-tenant demo; routes must be parameterized by the authenticated user's tenant claim before a second customer is loaded into production.

### Layered defense summary for reviewer

| Layer | What it enforces | Bypassable by | Where |
|---|---|---|---|
| Triggers | Cross-tenant FK consistency and `tenant_id` immutability | Nothing in normal SQL flow | [supabase/schema.sql:196-322](supabase/schema.sql) |
| RLS | Per-row tenant filter on read/write | Service role | [supabase/rls.sql](supabase/rls.sql) |
| App code | Service role only used server-side, browser-guard on admin client | Misuse of `supabaseAdmin()` in a client component | [lib/supabase.ts:30](lib/supabase.ts#L30) |

---

## 4. Transcript lifecycle

### Entry points

A call transcript can enter the system through exactly **two** code paths today, both of which funnel through a single chokepoint at [lib/transcript-ingest.ts](lib/transcript-ingest.ts) — the function `ingestTranscript()`. No other code in the tree calls the Anthropic SDK with a transcript payload (verified by `grep -rn "anthropic.messages" app lib`).

1. **User-pasted via the extract page.**
   - Client state in [components/ExtractView.tsx:46-66](components/ExtractView.tsx#L46-L66). The textarea's value is held in React state and posted to `/api/extract-scotsman` as the JSON body field `transcript`.
   - The route handler is a thin HTTP wrapper that calls `ingestTranscript({ source: "manual_paste", externalCallId, transcript })` ([app/api/extract-scotsman/route.ts](app/api/extract-scotsman/route.ts)).
   - The transcript travels over HTTPS in the request body. Standard Next.js / Vercel TLS termination.

2. **Hardcoded seed transcript loaded server-side** for the Lumora demo deal.
   - Defined as a TypeScript string literal in [lib/seed-transcript.ts](lib/seed-transcript.ts).
   - Retrieved by `getTranscriptById()` in [lib/seed-transcript.ts](lib/seed-transcript.ts), called from the extract page server component at [app/deals/[id]/extract/page.tsx:24](app/deals/[id]/extract/page.tsx#L24). Once posted by the client it goes through the same `ingestTranscript` path.
   - This is a single demo string. There is no upload, no file storage, no S3, no Blob.

Future Recall.ai webhook ingest will arrive as a third code path that also calls `ingestTranscript({ source: "recall_ai", ... })`, validated by the same closed source enum.

### Where the transcript is stored

- **Not stored.** The `transcripts` table exists in the schema ([supabase/schema.sql:87-95](supabase/schema.sql#L87-L95)) but is **empty in production today**. No code path writes to it. Confirmed by:
  - `grep -rn 'from("transcripts")' app lib scripts` returns zero results.
  - The migration script at [scripts/migrate-extractions-to-supabase.ts](scripts/migrate-extractions-to-supabase.ts) explicitly skips `transcripts`, `contacts`, and `calls` (see the script header).

### What is written to Supabase from the extraction flow

The `writeAuditTrail` function ([lib/transcript-ingest.ts](lib/transcript-ingest.ts)) writes:

1. One row to `extraction_runs` containing `raw_response: extraction` (the **parsed, validated structured output**, not the raw transcript). Token counts, duration, model name, prompt version.
2. Zero-to-many rows to `field_extractions` containing per-field `status` and, for Yes fields, the `evidence` (which is a **verbatim quote** the model extracted from the transcript, enforced by prompt rule 3 in [lib/extraction-prompt.ts](lib/extraction-prompt.ts) to be a single customer sentence, not the full transcript).

The full transcript is **never persisted**. This is commitment #1 in the DPA section 3.6 block at the top of [lib/transcript-ingest.ts](lib/transcript-ingest.ts).

### What is sent to Anthropic

- The full transcript is sent **once per extraction call**, wrapped in `<transcript>…</transcript>` delimiters inside `extractAndStore` ([lib/transcript-ingest.ts](lib/transcript-ingest.ts)).
- Anthropic's retention policy for inputs applies. The application has no control over this. If the customer requires Zero Data Retention (ZDR) on Anthropic, the API key must be provisioned on a ZDR-enabled account; the application does not toggle it.

### Logging audit (does any console statement capture transcript content?)

A direct grep on every `console.*` statement in `app/api` and `lib`:

- **Zero** statements log `transcript`, `body.transcript`, the request body, or anything containing transcript content. Verified by `grep -rEn 'console\..*transcript' app lib` (zero hits).
- Log statements record only: `dealId`, `duration`, `inputTokens`, `outputTokens`, `raw_length` (a number), and Supabase error objects.
- Example representative log line in [lib/transcript-ingest.ts](lib/transcript-ingest.ts):
  ```ts
  console.log(`[transcript-ingest] dealId=${args.dealExternalId} ok duration=${duration}ms in=${inputTokens} out=${outputTokens}`);
  ```
- This is commitment #3 in the DPA section 3.6 block at the top of [lib/transcript-ingest.ts](lib/transcript-ingest.ts).

### Cache / disk

- No filesystem writes in the request path. No `fs.writeFile`, no temporary file creation. (Confirmed by grep for `writeFile|createWriteStream|fs\.write` in `app/api` and `lib` — zero results.)
- The migration script and deletion script use `mkdirSync` / `writeFileSync` to write deletion confirmation receipts to `deletion-confirmations/` — these contain **summary counts and a SHA-256 hash**, not transcripts.
- Vercel function logs may retain `console.log` output per Vercel's log retention policy. Per the audit above, those logs do not contain transcript content.

### Discard timing

- In-flight transcript lives in the local `transcript` variable inside `extractAndStore` ([lib/transcript-ingest.ts](lib/transcript-ingest.ts)) only for the duration of the request (~17 s LLM round-trip plus a few ms of overhead). When the function returns, the variable goes out of scope and is garbage-collected by V8 on the next GC cycle.
- Client-side, the transcript lives in React state ([components/ExtractView.tsx:46](components/ExtractView.tsx#L46)) for the page session. A full page refresh clears it (by design — see project notes on no-localStorage decision).
- For Recall.ai-sourced transcripts, the source recording will be deleted from Recall's storage via `deleteSourceRecording(externalCallId)` ([lib/transcript-ingest.ts](lib/transcript-ingest.ts)) immediately after extraction returns. Currently a typed stub pending Recall credentials. This is commitment #4 in the DPA section 3.6 block.

---

## 5. CRM access scoping

### Status

- **Real CRM read/write code paths still do not execute** — no Rolldog or Salesforce HTTP call ships today.
- **The enforcement layer that gates those code paths is built**, fails closed, and is exercised by a script that runs live during code review. The reviewer recommendation from the May 15 audit is implemented in [lib/crm-scope.ts](lib/crm-scope.ts).

### Enforcement model

A single module at [lib/crm-scope.ts](lib/crm-scope.ts) holds the entire authority surface for CRM access. The module exports:

- `PILOT_OPPORTUNITY_IDS` — frozen, **currently empty**. Until Mark Buman confirms the three pilot opportunity ids at kickoff, every assert call fails closed. There is no runtime "add another opportunity" path; the array is `Object.freeze`-d.
- `ROLLDOG_READ_FIELDS` — frozen allowlist of 17 fields the Rolldog integration may read (stage gates, opportunity score, the four tabs, the three narrative fields, next step, interactions, close date, stage, amount, age, owner, last updated).
- `ROLLDOG_WRITE_FIELDS` — frozen allowlist of 7 fields it may write (stage-gate checklist items, next step, timeline + timeline notes, people, budget, competitors). Strict subset semantics: a field present in READ but not in WRITE is read-only.
- `SALESFORCE_READ_FIELDS` — frozen allowlist of `["StageName", "IsClosed", "IsWon"]`, scoped to closed-won/closed-lost outcome reads only. No writes.
- `assertScopedRead(opportunityId, fields)` / `assertScopedWrite(opportunityId, fields)` — synchronous validators. Throw `ScopeViolationError` (named class, includes opportunity id, offending field, operation) unless the opportunity id is in `PILOT_OPPORTUNITY_IDS` AND every field is in the corresponding allowlist.
- Every assert call — pass or fail — appends one row to the Supabase `crm_access_log` table (see below) via an injectable audit hook. Failures don't block the operation outcome; the in-memory allowlist decision is authoritative.

### Client scaffold (Rolldog)

[lib/rolldog.ts](lib/rolldog.ts) exposes `readOpportunity(id, fields)` and `writeOpportunity(id, updates)`. Each function follows a three-step pattern, documented at the top of the file and repeated as `STEP 1 / STEP 2 / STEP 3` comments in every function body:

1. Call the assert from `lib/crm-scope`. **Before any network code.**
2. Read `ROLLDOG_BASE_URL` / `ROLLDOG_CLIENT_ID` / `ROLLDOG_CLIENT_SECRET` — the credential path is visible here, secret values stay in Vercel env.
3. Throw `RolldogPendingError("Rolldog credentials pending (Swagger docs expected from Jeff, June 9 call)")`. The real HTTP code lives as a commented-out block at the assert site so a reviewer can see exactly what the call will do when credentials land.

The asserts cannot be bypassed by the network code because they precede it in source order, and the function does not branch around them.

### Audit table

[supabase/schema.sql](supabase/schema.sql) defines `crm_access_log`: tenant-scoped, columns for `operation` (`read`/`write`), `opportunity_external_id`, `fields jsonb`, `allowed boolean`, `violation_reason text`, `created_at`. Three indexes for tenant lookups, opportunity lookups, and time-ranged queries. RLS in [supabase/rls.sql](supabase/rls.sql): SELECT + INSERT tenant-scoped. **No UPDATE policy, no DELETE policy** — the log is append-only at the database layer. Only the service role can issue any modification.

### Test surface

[scripts/test-crm-scope.ts](scripts/test-crm-scope.ts) runs four scenarios with clear output and exit code:

1. Allowed opportunity + allowed fields → passes.
2. Unknown opportunity id → throws `ScopeViolationError`.
3. Off-allowlist field (`email_body`) → throws.
4. Write to a field that is in READ but not in WRITE (`stage`) → throws.

The test prints the in-memory audit log at the end so a reviewer sees that allowed and denied entries are recorded identically. Run with `npm run test:crm-scope`. Today the test passes 4 of 4. Because `PILOT_OPPORTUNITY_IDS` is empty by design, scenario 1 uses a test-only helper `__setPilotOpportunityIdsForTesting` that throws if `NODE_ENV=production`.

### What is not yet wired

- No route in `app/api/` imports `lib/rolldog.ts` or `lib/crm-scope.ts`. The integration handler that calls `readOpportunity` / `writeOpportunity` lands when credentials arrive from the June 9 Jeff call.
- `PILOT_OPPORTUNITY_IDS` is empty until Mark Buman confirms the three pilot deals at kickoff.
- `crm_access_log` exists in `supabase/schema.sql` but the table must be created in any existing Supabase project by applying the delta DDL block (the schema file is self-consistent for fresh projects).
- The Magaya tenant row must exist for audit writes to land. Created idempotently by `npm run seed:magaya` ([scripts/seed-magaya-tenant.ts](scripts/seed-magaya-tenant.ts)).

---

## 6. Secrets and encryption

### Environment variables

[.env.local.example](.env.local.example) declares the complete set of required variables:

```
ANTHROPIC_API_KEY              (server-only; gives full access to Claude billing account)
ANTHROPIC_MODEL                (optional override)
NEXT_PUBLIC_SUPABASE_URL       (public; safe in browser bundle)
NEXT_PUBLIC_SUPABASE_ANON_KEY  (public; gated by RLS)
SUPABASE_SERVICE_ROLE_KEY      (server-only; bypasses RLS)
ROLLDOG_BASE_URL               (server-only; pending Jeff, June 9)
ROLLDOG_CLIENT_ID              (server-only; pending Jeff, June 9)
ROLLDOG_CLIENT_SECRET          (server-only; pending Jeff, June 9)
```

The three Rolldog vars are intentionally not `NEXT_PUBLIC_*`-prefixed. `lib/rolldog.ts` reads them server-side only.

### Hardcoded credentials check

- `grep -rEn "sk-[a-zA-Z0-9_-]{10,}|password\s*[:=]\s*['\"]|secret\s*[:=]\s*['\"]|token\s*[:=]\s*['\"]"` across `app`, `lib`, `components`, `scripts` — **zero results outside of `process.env` references.**
- **The May 15 exception is resolved.** `lib/auth.ts` (which contained two hardcoded `"demo123"` demo passwords) has been deleted, along with the legacy `/login`, `/dashboard`, and legacy `/onboarding` routes it backed. Zero hardcoded credentials remain in the source tree.

### Browser bundle leakage check

- `SUPABASE_SERVICE_ROLE_KEY` and `ANTHROPIC_API_KEY` are not `NEXT_PUBLIC_*`-prefixed. Next.js will not inline non-`NEXT_PUBLIC_` env vars into the client bundle.
- `supabaseAdmin()` has a runtime guard at [lib/supabase.ts:30-34](lib/supabase.ts#L30-L34) that throws if called from the browser, providing defense in depth.

### Encryption at rest

- **Supabase Postgres**: encrypted at rest by Supabase (AES-256 via AWS). This is a property of the hosting provider, not the application. Verify with the customer's account plan on Supabase.
- **Vercel logs**: encrypted at rest by Vercel. Same property-of-provider note.
- **deletion-confirmations/*.txt** files are written to the local repo or operator workstation; they contain row counts and a SHA-256 hash, not customer data. They are not encrypted by the application.

### Encryption in transit

- All Supabase calls use HTTPS (the `createClient` URL is `https://*.supabase.co`).
- All Anthropic calls use HTTPS (SDK default).
- Vercel terminates TLS at the edge for incoming client → server traffic.

### `.gitignore` and key hygiene

- [.gitignore](.gitignore) excludes `.env.local`, `.env*.local`, `.vercel`. `git log --all -- .env.local` returns no commits (verifiable by reviewer).
- `.env.local` exists locally (operator's machine) and on Vercel as project env vars.

---

## 7. Data deletion

### Capability

A signed-confirmation deletion script ships in the repo: [scripts/delete-tenant-data.ts](scripts/delete-tenant-data.ts).

### What it does

1. Takes a tenant slug as a positional argument and an optional `--dry-run` flag.
2. Resolves the slug to a UUID via the service role client.
3. Counts and (if not dry-run) deletes rows in FK-safe leaf-to-root order: `extraction_runs → briefing_runs → field_extractions → transcripts → calls → contacts → deals → tenants` ([scripts/delete-tenant-data.ts:32-40](scripts/delete-tenant-data.ts#L32-L40)).
4. Writes a deletion confirmation file at `deletion-confirmations/{slug}-{ISO timestamp}.txt` containing per-table row counts and a **SHA-256 hash of the summary text** as tamper evidence.

### What it does **not** do

- It does not delete the tenant's transcripts from Anthropic. Anthropic input retention is governed by the API account's settings.
- It does not delete Vercel function logs.
- It does not delete the deletion-confirmation file itself (intentional — confirmation is evidence).
- It is operator-run via `npm run delete:tenant -- <slug>` — there is no in-product "Delete my data" button. For a DPA-compliant workflow, a customer request would be processed manually by the operator.

### Reviewer evidence file

The repo contains one historical confirmation at [deletion-confirmations/topsort-2026-05-04T20-54-32-709Z-dryrun.txt](deletion-confirmations/) showing the format and SHA-256 hash construction.

---

## 8. Authentication

### Active demo path

**There is no authentication on the active demo path.** All of `/`, `/forecast`, `/forecast?tenant=aware`, `/pipeline`, `/deals/lumora-2026-q2`, `/demo/aware`, `/onboarding`, `/rep-experience`, `/rep-onboarding` are publicly reachable without a login.

### Legacy auth shell

- **Deleted since the May 15 audit.** `lib/auth.ts` (which contained the hardcoded demo passwords flagged in §6 of the prior audit) is gone, along with `/login`, `/dashboard`, and the legacy `/onboarding` variant it backed. Confirmed by `ls lib/auth.ts app/login app/dashboard` returning "No such file or directory" for all three.

### OAuth flows

- **None.** No OAuth integration is implemented for any provider. The onboarding "Connect" buttons simulate authorization with a 1.5 s spinner client-side ([app/onboarding/connect/page.tsx](app/onboarding/connect/page.tsx)).
- No NextAuth, Clerk, Auth0, Supabase Auth UI wiring, or SAML / OIDC bridge.

### Path to real auth

Once Supabase Auth (or a SAML bridge that issues a Supabase-shaped JWT) is wired:

1. Issuing JWTs must include a `tenant_id` claim at the top level.
2. The temporary anon-key SELECT fallback in [supabase/rls.sql](supabase/rls.sql) (the `demo_topsort_tenant_id()` clause) must be removed.
3. The hardcoded `TENANT_SLUG = "topsort"` constant in `/api/extract-scotsman` and `/api/prepare-briefing` must be replaced with a value read from the user's session.

Until those three steps land, the system is single-tenant by configuration even though the database is multi-tenant by design.

---

## 9. Demo-mocked vs functional

This section is the most important one for a reviewer evaluating the maturity of the product.

### Actually functional (works end-to-end with real services)

| Capability | Real services it touches |
|---|---|
| Scotsman extraction from a transcript (via single chokepoint `ingestTranscript`) | Anthropic (Claude Sonnet 4.6), Supabase Postgres |
| Pre-call briefing generation | Anthropic, Supabase Postgres |
| Audit trail of every LLM call | Supabase Postgres (extraction_runs, briefing_runs) |
| CRM access enforcement (asserts, allowlists, append-only audit log) | Supabase Postgres (crm_access_log). No outbound HTTP yet; asserts run in-process. |
| Tenant deletion with signed confirmation | Supabase Postgres, local filesystem (operator-run) |
| Idempotent tenant/deal migration to Supabase | Supabase Postgres (operator-run) |
| Idempotent Magaya tenant seed | Supabase Postgres (operator-run via `npm run seed:magaya`) |

### Demo-mocked (UI present, no real service behind it)

| Surface | What is actually happening |
|---|---|
| "Connect Gong / Teams / Granola" cards in onboarding | `setTimeout(1500)` then a green checkmark. No OAuth, no API. |
| "Connect Salesforce / Roll Dog / Einstein Activity Capture" | Same. No CRM SDK. |
| "Connect Slack / Google Calendar / Gmail / Outlook" | Same. |
| "Sync to Salesforce" button on Aware deal pages | `setTimeout(1700)` then a confirmation pill. No SObject write. |
| Slack DM mockups at `/rep-onboarding` and `/rep-experience` | Pure HTML/CSS that resembles a Slack thread. Buttons set local React state. No Slack workspace, no bot. |
| "Authorize Gmail" and "Authorize Calendar" buttons on `/rep-onboarding` | `setTimeout(1500)` per button. No OAuth. |
| Forecast Room tenant data (TopSort and Aware) | Static TypeScript constants in [lib/forecast-tenants.ts](lib/forecast-tenants.ts). No real pipeline read. |
| Aware Blind Spot deals (Customs, Banco, Pinnacle) | Static TypeScript constants in [lib/aware-data.ts](lib/aware-data.ts). |
| TopSort pipeline (Lumora, Kestrel, etc.) | Static TypeScript constants in [lib/seed-data.ts](lib/seed-data.ts). |
| Rep performance table on `/demo/aware` | Static numbers in [lib/aware-data.ts](lib/aware-data.ts) `REPS` constant. |
| 247-deals-trained-on calibration stat in Forecast Room | Static number in [lib/forecast-tenants.ts](lib/forecast-tenants.ts). |
| Healthy paranoia / convince me scores | Per-deal hardcoded `convinceMeScore` field, falls back to a 4-line formula over DUCT gate counts. Not a trained model. |
| `/api/debug/extract-lumora` | Returns 404 unless `ENABLE_DEBUG_ROUTES=true`. Behind that flag, it hits the real extract endpoint with the hardcoded seed transcript. The env flag is not declared in `.env.local.example`, so production deploys do not enable it by default. |

### Code paths the agent should know about that are not on the demo

The May 15 audit listed a handful of legacy routes and lib helpers for recommended deletion. **Those have all been deleted as of June 3, 2026.** `grep -rn "lib/auth" app lib components` returns zero results; `ls app/login app/dashboard app/api/score-call app/api/coaching app/api/persona app/api/questions app/api/activity-basis app/api/scores` returns "No such file or directory" for every entry.

The only code path that exists today but is not yet exercised by a route is the CRM enforcement layer (`lib/crm-scope.ts`, `lib/rolldog.ts`). It is deliberately not wired pending the June 9 Jeff call. See §5.

### Single-line honest summary

> **DealRipe today is a Claude Sonnet 4.6 pipeline with a Supabase audit trail, wrapped in a Next.js UI that demonstrates how a future Gong + Salesforce + Rolldog + Slack integration will feel. The CRM access enforcement layer (frozen allowlists, fail-closed pilot ID set, append-only audit log) is in place pending Rolldog credentials. The non-Anthropic, non-Supabase services named in the UI are not yet wired.**

---

## Appendix A: Quick reference for re-running this audit

The following commands reproduce every claim in this document (run from repo root):

```bash
# §1 Stack
cat package.json | grep -E '"(next|react|@anthropic|@supabase)"'

# §2 External APIs actually called
grep -rEn "anthropic\.messages|supabaseAdmin\(\)|supabaseClient\(\)" app/api lib --include='*.ts'

# §2 External APIs NOT integrated (real HTTP)
grep -rEi "salesforce|jsforce|microsoft.graph" --include="*.ts" \
  | grep -v node_modules | grep -v onboarding-data.ts | grep -v SalesforceSyncButton | grep -v crm-scope
# (expect: zero meaningful hits)

# §5 CRM enforcement layer present
ls lib/crm-scope.ts lib/rolldog.ts scripts/test-crm-scope.ts
grep -c "create policy crm_access_log" supabase/rls.sql
# (expect: all four files exist; policy count = 2)

# §5 Run the live enforcement demo
npm run test:crm-scope
# (expect: Cases: 4 of 4 passed)

# §3 RLS policy count
grep -c "^create policy" supabase/rls.sql
# (expect: 22)

# §4 Any logging that touches transcript content?
grep -rEn 'console\..*transcript' app lib --include='*.ts'
# (expect: zero hits)

# §6 Hardcoded secrets
grep -rEn "sk-[a-zA-Z0-9_-]{10,}|password\s*[:=]\s*['\"]|secret\s*[:=]\s*['\"]" \
  app lib components scripts --include='*.ts'
# (expect: zero)

# §6 Legacy auth shell deleted
ls lib/auth.ts app/login app/dashboard 2>&1 | grep -c 'No such file'
# (expect: 3)

# §7 Deletion procedure exists
ls scripts/delete-tenant-data.ts deletion-confirmations/

# §8 No real auth
grep -rE "next-auth|@clerk|@auth0|@supabase/auth-helpers" package.json
# (expect: zero)
```

If any of the above commands return surprising results, the claim in this document is wrong and the reviewer should flag it.
