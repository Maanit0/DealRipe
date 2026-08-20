-- =====================================================================
-- One row per model call.
--
-- WHY, measured 2026-08-20:
--
-- DealRipe makes 17 model calls across 13 modules: join-gate,
-- meeting-classify (4), extraction, briefing, the three recap passes,
-- follow-up draft, no-show draft, contacts-extract, digest-synthesis,
-- prescription-scoring (2), tasks, call-quarantine, post-call-summary.
--
-- Exactly ONE of them writes a trace row: transcript-ingest, into
-- extraction_runs. briefing_runs exists with token_input, token_output,
-- duration_ms, prompt_version and raw_response, and nothing in lib/ has
-- ever written it: 61 rows, all on the demo tenant, zero for Magaya
-- against 89 briefings actually delivered.
--
-- So sixteen of seventeen calls leave no trace, and the following are
-- currently unanswerable: what a briefing costs, which call site burns
-- the most tokens, how often a call fails, how long any of it takes, and
-- whether a prompt change improved anything.
--
-- The root cause is structural rather than an oversight. lib/anthropic.ts
-- exposes getAnthropicClient() and getAnthropicModel() and nothing else,
-- so there is no choke point. Model name is centralised; max_tokens,
-- retries, error handling and tracing are copy-pasted per site. This
-- table is the other half of runModel(), which becomes that choke point.
--
-- WHAT IS DELIBERATELY NOT STORED: the prompt and the response.
--
-- Magaya is under NDA and these payloads carry customer transcripts. The
-- questions this table exists to answer, cost, latency, failure rate and
-- prompt-version comparison, are all answerable from metadata. Where a
-- payload genuinely matters it already has a home with domain meaning:
-- extraction_runs.raw_response keeps the extraction, briefing_runs keeps
-- the briefing. Duplicating them here would double the NDA surface for
-- no signal.
--
-- An error MESSAGE is stored, because a failure nobody can read is the
-- exact shape of bug this codebase keeps paying for.
--
-- Apply by hand in the Supabase SQL editor, or:
--   psql "$SUPABASE_DB_URL" -f supabase/add-model-runs.sql
--
-- Additive and idempotent. Safe to re-run.
-- =====================================================================

begin;

create table if not exists public.model_runs (
  id             uuid        primary key default gen_random_uuid(),

  -- Nullable on purpose. join-gate and meeting-classify run BEFORE a deal
  -- or call row exists, and refusing to trace them because they cannot
  -- name a deal would blind exactly the cheap high-volume calls whose
  -- cost is easiest to miss.
  tenant_id      uuid        references public.tenants(id) on delete cascade,
  deal_id        uuid        references public.deals(id)   on delete set null,
  call_id        uuid        references public.calls(id)   on delete set null,

  -- Stable slug for the call site: "extraction", "briefing",
  -- "recap.narrative", "recap.demo_strategy", "followup_draft". Dotted so
  -- a family can be rolled up without parsing.
  task           text        not null,
  -- Bumped when the prompt changes. Without this a prompt is v1 forever
  -- and no before/after comparison is possible.
  prompt_version text        not null default 'v1',
  model          text        not null,

  input_tokens   integer,
  output_tokens  integer,
  -- Cache hits are most of the cost story on repeated prompts, and the
  -- SDK reports them separately from input_tokens.
  cache_read_tokens    integer,
  cache_write_tokens   integer,

  duration_ms    integer     not null,
  -- "end_turn", "max_tokens", "stop_sequence". max_tokens is a truncated
  -- answer, which is a quality fact rather than an error, and several
  -- callers already check for it by hand.
  stop_reason    text,

  ok             boolean     not null,
  error          text,

  created_at     timestamptz not null default now()
);

comment on table public.model_runs is
  'One row per Anthropic call, written by runModel() in lib/model-run.ts. Metadata only: prompts and responses are deliberately not stored, since Magaya is under NDA and cost, latency, failure rate and prompt-version comparison are all answerable without them.';

comment on column public.model_runs.task is
  'Stable slug for the call site. Dotted for families ("recap.narrative"), so a family rolls up without parsing.';

comment on column public.model_runs.prompt_version is
  'Bumped when the prompt changes. The dimension that makes an A/B possible at all; before this table every prompt was v1 forever.';

comment on column public.model_runs.stop_reason is
  'max_tokens means the answer was truncated, which is a quality fact rather than a failure. ok stays true and the caller decides.';

-- The three questions this table answers: what does a task cost, what did
-- this deal cost, and what happened lately.
create index if not exists model_runs_task_created_idx on public.model_runs (task, created_at desc);
create index if not exists model_runs_tenant_created_idx on public.model_runs (tenant_id, created_at desc);
create index if not exists model_runs_deal_idx on public.model_runs (deal_id, created_at desc);

-- Service role only, the same shape as crm_token_cache and deal_messages.
-- RLS on with no policies denies everything the service key does not do.
alter table public.model_runs enable row level security;

commit;
