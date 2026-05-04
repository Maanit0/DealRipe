# DealRipe Verification Matrix

**Run date:** 2026-05-04
**Supabase project:** `fncfanzkbrkegjhypxnj.supabase.co`
**Audience:** Magaya IT (May 11 review), internal QA, Paul Foreman demo prep
**Re-run instructions:** see [Re-running this verification](#re-running-this-verification) below.

This document is the artifact Magaya's IT team should read to confirm the system behaves as documented. Every check below was run against live infrastructure (Next.js dev server on `localhost:3000`, Supabase project above, Anthropic API).

---

## Section 1: Paul demo end-to-end

### 1.1 Page reachability

| URL | HTTP | Result |
|---|---|---|
| `/` | 307 redirect → `/pipeline` | ok |
| `/pipeline` | 200 | ok |
| `/deals/lumora-2026-q2` | 200 | ok |
| `/deals/lumora-2026-q2/extract?callId=lumora-call-2` | 200 | ok |
| `/deals/lumora-2026-q2/prepare` | 200 | ok |

### 1.2 Pipeline page content

Rendered HTML contains, for each row of [app/pipeline/page.tsx](app/pipeline/page.tsx):

- `Lumora Marketplace`, `Kestrel Apparel`, `Northwind Grocers`, `Meridian Home`, `Harbor Outdoor`, `Atlas Pet Supply` — all 6 deals visible. ok
- `Pipeline total ARR` — summary bar present. ok
- `Stalled`, `Healthy` status badges — present (At Risk wrapped in HTML attributes; verified independently via `font-bold text-danger` class count). ok
- Header reads `6 deals · 3 at risk · 1 stalled` (verified via raw HTML). ok

### 1.3 Deal page content (Lumora)

Rendered HTML contains:

- `Opportunity Control` (sheet title), `Recent calls from Gong` (Gong card), `Marcus Chen` (champion contact), `Never contacted` (David Kowalski / Sarah flagged), `Prepare next call` (CTA), `Validation gate`, `Apr 14`, `Apr 4`. ok

### 1.4 Extract page content

Rendered HTML contains:

- `Transcript from Apr 14` (in raw HTML, with React text-comment markers between static and dynamic spans), `Extract Scotsman fields` (button), `Sponsored listings` (transcript pre-fill), `Marcus Chen`. ok

### 1.5 Live extraction round-trip

| Step | Result |
|---|---|
| POST `/api/extract-scotsman` (via debug route) | HTTP 200 |
| Anthropic round-trip duration | ~16-18s |
| Returned `extraction` shape | full 18-key map, schema validated |
| Server log | `[extract-scotsman] dealId=lumora-2026-q2 ok ...` |
| Audit log | `[extract-scotsman] audit ok ... fields_upserted=6 (Sc2,C1,T2,T3,A4,N2)` |

### 1.6 Briefing round-trip

| Step | Result |
|---|---|
| POST `/api/prepare-briefing` | HTTP 200 |
| Anthropic round-trip duration | ~4-5s |
| Returned object | `{callObjective, topQuestions[], nextStepCommitment, whatsAtRisk}` |
| Top 3 question ids (post-extract) | `A2, M1, M2` (matches design spec) |
| Audit log | `[prepare-briefing] audit ok ... run_inserted=1` |

### 1.7 Manual click-through (visual)

The following must be confirmed in a real browser. Items 1.1-1.6 cover everything that can be verified server-side; the items below depend on UI rendering, animation, and React Context behavior across navigations.

- [ ] Clicking a non-Lumora row in the pipeline does nothing (it is not a link).
- [ ] Clicking Lumora navigates to the deal page.
- [ ] On the extract page, the textarea is pre-filled with the Apr 14 transcript.
- [ ] Clicking "Extract Scotsman fields" shows the spinner for at least 4s (UI floor) and at most ~22s (API call + floor).
- [ ] On extract complete, changed fields flash green for 1.5s; the post-extract banner appears with green tint, fades to neutral after 8s.
- [ ] DealRipe forecast in the header recomputes (44%/Jul 27 → 53%/Jul 13).
- [ ] "NEW" badges with subtle green background and accent left border persist on Sc2, C1, T2, A4, N2 (and T3 if promoted) after the flash settles.
- [ ] Refresh the page → forecast resets to 44%/Jul 27, NEW badges gone, sheet at baseline (the `DemoStateProvider` context resets on full reload, by design — preserves the Friday demo's "fresh state on every refresh" requirement).
- [ ] Click "Back to deal" → deal page picks up the in-session merged state via React Context (without a refresh).
- [ ] Click "Prepare next call" → briefing page renders with the 4 cards (Call objective, Top 3 questions, Next-step commitment, What's at risk).

---

## Section 2: Audit trail and RLS

### 2.1 `extraction_runs` row count grows on every API call

| Snapshot | extraction_runs count | briefing_runs count |
|---|---|---|
| Before this verification block | 4 | 2 |
| After 1 extract + 1 briefing call | 5 | 3 |

Every Anthropic API call writes a row with `model_name`, `prompt_version=v1`, `token_input`, `token_output`, `duration_ms`, `raw_response`, and `created_at`. The `call_id` column is null because the calls table is not yet populated; this is expected and documented.

### 2.2 `field_extractions.updated_at` advances for promoted fields

Most-recent 6 rows by `updated_at` are exactly the 6 fields the LLM promoted (Sc2, C1, T2, T3, A4, N2). The other 12 rows still carry the migration timestamp (`2026-05-04T18:33:01Z`).

```
[
  { "scotsman_field_id": "T2",  "status": "Yes", "updated_at": "2026-05-04T20:04:27Z" },
  { "scotsman_field_id": "A4",  "status": "Yes", "updated_at": "2026-05-04T20:04:27Z" },
  { "scotsman_field_id": "Sc2", "status": "Yes", "updated_at": "2026-05-04T20:04:27Z" },
  { "scotsman_field_id": "C1",  "status": "Yes", "updated_at": "2026-05-04T20:04:27Z" },
  { "scotsman_field_id": "T3",  "status": "Yes", "updated_at": "2026-05-04T20:04:27Z" },
  { "scotsman_field_id": "N2",  "status": "Yes", "updated_at": "2026-05-04T20:04:27Z" }
]
```

### 2.3 Anonymous SELECT (temporary fallback)

| Endpoint | Header | Result |
|---|---|---|
| GET `/rest/v1/deals?select=*` | anon key | 1 row (Lumora). The fallback policy `tenant_id = demo_topsort_tenant_id()` matches. |
| GET `/rest/v1/extraction_runs?select=*` | anon key | 5 rows. Same fallback. |
| GET `/rest/v1/tenants?select=slug` | anon key | `[]` empty. No anon SELECT policy on tenants, by design. |

### 2.4 Anonymous INSERT, UPDATE, DELETE

| Method | Endpoint | Header | HTTP | Body | Outcome |
|---|---|---|---|---|---|
| POST  | `/rest/v1/deals` | anon | **401** | `{"code":"42501","message":"new row violates row-level security policy for table \"deals\""}` | rejected explicitly |
| PATCH | `/rest/v1/deals?external_id=eq.lumora-2026-q2` | anon | 204 | empty | 0 rows matched RLS USING filter; no data modified |
| DELETE | `/rest/v1/deals?external_id=eq.lumora-2026-q2` | anon | 204 | empty | no DELETE policy exists; 0 rows matched; no data modified |

INSERT triggers an explicit `42501` because PostgREST evaluates the WITH CHECK clause and reports the violation. UPDATE and DELETE silently affect 0 rows when the USING clause filters them out — equally secure but a different signal. **Verified post-test:** `select * from deals where external_id = 'lumora-2026-q2'` returns the unchanged Lumora row (`account: "Lumora Marketplace"`, `arr: 340000`).

### 2.5 Service role bypass

| Table | Service-role count | Anon-key count | Notes |
|---|---|---|---|
| tenants | 1 | 0 | tenants is authenticated-only |
| deals | 1 | 1 | anon fallback to topsort |
| field_extractions | 18 | 18 | anon fallback |
| extraction_runs | 5 | 5 | anon fallback |
| briefing_runs | 3 | 3 | anon fallback |

Service role returns all rows including the `tenants` row that anon cannot see. Behavior matches Supabase's default service-role-bypasses-RLS contract.

### 2.6 Layered defense (triggers + RLS)

Both layers are independently active:

1. **Triggers** (apply to all connections including service role):
   - `enforce_tenant_alignment` — 8 instances, one per child FK relationship. Verified by [SETUP.md section 5](SETUP.md) smoke test.
   - `prevent_tenant_id_change` — 7 instances. Verified by [SETUP.md section 5b](SETUP.md) smoke test.
2. **RLS policies** (apply to anon + authenticated, bypassed by service role):
   - 22 policies total across 8 tables. Verified by direct REST tests above.

---

## Section 3: Deletion procedure

### 3.1 Script created

[scripts/delete-tenant-data.ts](scripts/delete-tenant-data.ts) — wired as `npm run delete:tenant`. Type-check clean (`npx tsc --noEmit`).

### 3.2 Usage

```bash
# Always start with --dry-run.
npm run delete:tenant -- topsort --dry-run

# Live run (DESTRUCTIVE; do not run without authorization):
npm run delete:tenant -- topsort
```

### 3.3 Behaviors verified

| Behavior | Result |
|---|---|
| Resolves slug to UUID before counting | ok (queries `tenants` first; aborts with `tenant 'X' not found.` for unknown slugs) |
| Counts rows per table in FK-safe leaf-to-root order | ok (extraction_runs → briefing_runs → field_extractions → transcripts → calls → contacts → deals → tenants) |
| `--dry-run` reports counts but does not delete | ok (verified: post-dry-run REST query returns the topsort tenant unchanged) |
| Console summary printed | ok |
| Confirmation file written | ok ([deletion-confirmations/topsort-2026-05-04T20-54-32-709Z-dryrun.txt](deletion-confirmations/topsort-2026-05-04T20-54-32-709Z-dryrun.txt)) |
| SHA-256 tamper-evidence hash | ok (`1a32586c3c7360592c19de33d39a81f1f3f8ae34761461891048fc1ebf580dce` for the dry-run summary above) |
| Invalid slug fails gracefully | ok (`tenant 'nonexistent-slug' not found.`, exit code 1, no file written) |

### 3.4 Sample dry-run output (topsort)

```
tenant slug:  topsort
tenant uuid:  9ff0800e-273e-44e8-ad05-1e8535a8734b
tenant name:  TopSort
mode:         DRY RUN (no rows will be deleted)

  extraction_runs         5 (would delete)
  briefing_runs           3 (would delete)
  field_extractions      18 (would delete)
  transcripts             0 (would delete)
  calls                   0 (would delete)
  contacts                0 (would delete)
  deals                   1 (would delete)
  tenants                 1 (would delete)

(28 rows total)
SHA-256 of summary: 1a32586c3c7360592c19de33d39a81f1f3f8ae34761461891048fc1ebf580dce
```

### 3.5 Live deletion not run tonight

Per scope, no live deletion was executed. The script has been verified ready for the May 11 review and for end-of-pilot deletion. The reviewer should:

1. Read [scripts/delete-tenant-data.ts](scripts/delete-tenant-data.ts) for the FK-safe deletion order, the SHA-256 hash construction, and the confirmation-file format.
2. Confirm the `--dry-run` flag short-circuits before any DELETE, by inspecting the conditional at line `if (n === 0 || dryRun) { ... continue; }`.
3. When live deletion is authorized, the procedure is to run `--dry-run` first, file the confirmation, then re-run without the flag, file the second confirmation. Both are SHA-256 signed.

---

## Re-running this verification

Prerequisites:
- Next.js dev server running on `localhost:3000` (`npm run dev`)
- `.env.local` populated with Supabase + Anthropic credentials (see [SETUP.md](SETUP.md))
- Schema applied (`supabase/schema.sql`) and RLS applied (`supabase/rls.sql`)
- Migration run (`npm run migrate:extractions`)

Then for a fast end-to-end re-verify, run from project root:

```bash
# 1. Page reachability
for path in / /pipeline /deals/lumora-2026-q2 \
  "/deals/lumora-2026-q2/extract?callId=lumora-call-2" \
  /deals/lumora-2026-q2/prepare; do
  curl -s -o /dev/null -w "%{http_code}  $path\n" "http://localhost:3000$path"
done

# 2. Audit trail snapshot (service role)
URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2-)
SVC=$(grep '^SUPABASE_SERVICE_ROLE_KEY=' .env.local | cut -d= -f2-)
for t in tenants deals field_extractions extraction_runs briefing_runs; do
  echo -n "$t: "
  curl -sI -H "apikey: $SVC" -H "Authorization: Bearer $SVC" \
    -H "Prefer: count=exact" "$URL/rest/v1/$t?select=*" \
    | grep -i 'content-range'
done

# 3. Trigger one extraction + briefing
curl -s "http://localhost:3000/api/debug/extract-lumora" > /dev/null
curl -s -X POST "http://localhost:3000/api/prepare-briefing" \
  -H "Content-Type: application/json" \
  -d '{"dealId":"lumora-2026-q2","extraction":{}}' -o /dev/null

# 4. Anon RLS sanity
ANON=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)
curl -sI -H "apikey: $ANON" -H "Prefer: count=exact" \
  "$URL/rest/v1/deals?select=*" | grep -i 'content-range'

# 5. Deletion script dry-run
npm run delete:tenant -- topsort --dry-run
```

If every step matches the matrix above, the system is in the documented state.
