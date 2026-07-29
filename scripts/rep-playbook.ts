/**
 * Rep playbook miner: reads every customer-facing call transcript DealRipe has
 * captured and distills HOW Juan and Eduardo sell — the questions they ask, how
 * they phrase and sequence them to unlock each piece of the deal, the discovery
 * techniques they lean on, and the specific moments that worked.
 *
 * Why this exists: today DealRipe's briefings and post-call actions run on
 * generic prompts. This script turns the team's own best-rep calls into a
 * concrete, evidence-grounded playbook we can fold into those prompts, so the
 * product's guidance reflects how Magaya's best reps actually sell instead of a
 * generic B2B template. It is analysis only: it writes nothing back to Rolldog
 * or Supabase.
 *
 * Two passes:
 *   1. Per call, Claude extracts a structured read of the rep's questions
 *      (grouped by what they were trying to uncover), phrasings, techniques,
 *      what worked, and how they handled objections and set the next step.
 *   2. Across all per-call reads, Claude synthesizes a per-rep + combined
 *      playbook: the recurring question patterns with real example phrasings,
 *      the winning motion, per-rep style differences, and distilled "plays"
 *      ready to drop into the briefing / action prompts.
 *
 * Usage (runs on your Mac with .env.local; needs Supabase + ANTHROPIC_API_KEY):
 *   npx tsx scripts/rep-playbook.ts                    # all customer calls since 2026-07-14
 *   npx tsx scripts/rep-playbook.ts --since 2026-07-16
 *   npx tsx scripts/rep-playbook.ts --since 30         # last 30 days
 *   npx tsx scripts/rep-playbook.ts --rep juan         # one rep only
 *   npx tsx scripts/rep-playbook.ts --include-customer # also mine existing-customer calls
 *   npx tsx scripts/rep-playbook.ts --out ./out        # where to write the two files
 *
 * Output: rep-playbook.md (the readable playbook) and rep-playbook.json (the raw
 * per-call extractions) in --out (default: current directory).
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAnthropicClient, getAnthropicModel } from "../lib/anthropic";
import { loadFramework } from "../lib/framework";
import { callSubtypeLabel } from "../lib/meeting-classify";
import { repName } from "../lib/display-names";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TRANSCRIPT_CHARS = 60_000; // generous slice; Sonnet handles long discovery calls

type Args = { since: string; rep: string | null; includeCustomer: boolean; out: string };

function parseArgs(): Args {
  const a = process.argv.slice(2);
  let since = "2026-07-14";
  let rep: string | null = null;
  let includeCustomer = false;
  let out = ".";
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v === "--since") {
      const n = a[++i];
      since = /^\d+$/.test(n) ? new Date(Date.now() - parseInt(n, 10) * 86_400_000).toISOString().slice(0, 10) : n;
    } else if (v === "--rep") {
      rep = (a[++i] ?? "").toLowerCase();
    } else if (v === "--include-customer") {
      includeCustomer = true;
    } else if (v === "--out") {
      out = a[++i] ?? ".";
    }
  }
  return { since, rep, includeCustomer, out };
}

function shortDate(iso: string | null): string {
  if (!iso) return "unknown";
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" });
  } catch {
    return "unknown";
  }
}

/** One call's structured read of how the rep sold. */
type CallRead = {
  callId: string;
  rep: string;
  account: string;
  subtype: string;
  date: string;
  /** Qualification gates actually confirmed on this call (ground truth for "what worked"). */
  gatesConfirmed: string[];
  analysis: Record<string, unknown> | null;
  error?: string;
};

const PER_CALL_SYSTEM = `You analyze a B2B sales call transcript to capture HOW THE REP SELLS. This is a real logistics-software sales call (Magaya). Focus ONLY on the rep's own behavior: what they asked, how they phrased it, how they sequenced discovery, and what worked. Ignore the mechanics of the product being sold except where it shows technique.

The rep's name is given. Attribute questions and moves to the REP, not the customer.

Return ONLY JSON in exactly this shape:
{
  "questionsByGoal": {
    "situation": [{"asked": "close paraphrase or quote of the rep's question", "why": "what it was trying to uncover"}],
    "whyNow": [...],
    "need_pain": [...],
    "competition": [...],
    "budget": [...],
    "decisionProcess_authority": [...],
    "timeline": [...],
    "other": [...]
  },
  "techniques": ["specific discovery techniques the rep used: e.g. quantifying pain in dollars, layered follow-ups, tie-downs, mirroring, silence, reframing, multi-threading, tying to the customer's stated goal"],
  "whatWorked": ["concrete moments where a question or move clearly unlocked useful info or moved the deal, with a short quote of the customer's reaction where possible. Ground these in the GATES CONFIRMED ON THIS CALL when provided: prefer moves that plausibly produced a confirmed gate, and do not claim a line of questioning worked if no related gate was confirmed"],
  "phrasings": ["the rep's most reusable exact phrasings, verbatim, that other reps could copy"],
  "objections": [{"objection": "what the customer pushed back on", "handling": "how the rep responded"}],
  "nextStepMove": "how the rep set (or failed to set) the next step and commitment at the end"
}

Rules: ground everything strictly in the transcript. Prefer the rep's actual words. If a category has nothing, use an empty array. Do not invent. Do not add commentary outside the JSON.`;

function synthSystem(reps: string[]): string {
  return `You are a sales-enablement analyst. You are given structured reads of many real sales calls from Magaya's top reps (${reps.join(
    " and ",
  )}), each read capturing the questions the rep asked (grouped by goal), techniques, what worked, reusable phrasings, objection handling, and next-step behavior.

Write a PLAYBOOK in Markdown that a sales leader (Mark, the CRO) and the DealRipe product could both use. Be concrete and evidence-grounded; quote the reps' real phrasings. No fluff, no generic sales-101 filler, no invented data. Do not use em-dashes anywhere; use commas or periods.

Structure:

# How Juan and Eduardo Sell

## The winning motion
3-6 sentences on the through-line: how these reps run a call, what they consistently do that works.

## By qualification goal
For each of: Situation, Why now, Need and pain, Competition, Budget, Decision process and authority, Timeline. Give the 2-4 best real questions they use (verbatim phrasing), and one line on how they ask it to actually get the answer.

## Techniques that recur
The discovery techniques that show up across calls, each with a one-line example from the calls.

## What clearly works
The specific moves that unlocked information or advanced the deal. Each read includes gatesConfirmed, the qualification fields that were actually filled on that call. Prioritize moves that produced a confirmed gate and treat those as the strongest evidence, above inferred customer reactions. Weight discovery calls most heavily for questioning craft; note when a play comes from a demo or proposal call rather than discovery, and disregard any read that is clearly an existing-customer or internal conversation.

## Objection handling
Real objections that came up and how they handled them.

## Where they leave value on the table
Honest gaps: goals they under-ask, next steps they fail to lock. Ground this in the reads.

## Per-rep differences
How Juan and Eduardo differ in style, if the reads show it.

## Distilled plays for DealRipe
A tight list of 8-15 concrete, reusable "plays" (each a single imperative sentence with the real phrasing in quotes) that we can fold directly into DealRipe's pre-call briefing and post-call action prompts so its guidance sounds like these reps. This is the section that matters most; make it copy-paste ready.`;
}

async function extractCall(read: Omit<CallRead, "analysis">, transcript: string): Promise<CallRead> {
  try {
    const resp = await getAnthropicClient().messages.create({
      model: getAnthropicModel(),
      max_tokens: 3000,
      temperature: 0.2,
      system: PER_CALL_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Rep: ${read.rep}\nAccount: ${read.account}\nCall type: ${read.subtype}\nGATES CONFIRMED ON THIS CALL (ground truth): ${
            read.gatesConfirmed.length ? read.gatesConfirmed.join(", ") : "none recorded"
          }\n\nTranscript:\n\n${transcript.slice(0, TRANSCRIPT_CHARS)}`,
        },
      ],
    });
    const text = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1) return { ...read, analysis: null, error: "no JSON in response" };
    const analysis = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    return { ...read, analysis };
  } catch (e) {
    return { ...read, analysis: null, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Add it to .env.local.");
    process.exit(1);
  }

  const db = supabaseAdmin();
  const tenantId = await resolveTenantId("magaya");

  // Framework, to turn confirmed field keys into human labels for the read.
  const framework = await loadFramework(tenantId);
  const labelByKey = new Map<string, string>(
    (framework?.fields ?? []).map((f) => [f.fieldKey, f.label] as const),
  );

  // Deals -> account + rep.
  const dealsRes = await db.from("deals").select("id, account, rep_email").eq("tenant_id", tenantId);
  const dealInfo = new Map(
    ((dealsRes.data ?? []) as Array<{ id: string; account: string; rep_email: string | null }>).map(
      (d) => [d.id, { account: d.account, rep: repName(d.rep_email) }] as const,
    ),
  );

  // Calls in window, customer-facing only.
  const callsRes = await db
    .from("calls")
    .select("id, deal_id, scheduled_start, call_date, meeting_type, call_subtype")
    .eq("tenant_id", tenantId);
  type CallRow = {
    id: string;
    deal_id: string | null;
    scheduled_start: string | null;
    call_date: string | null;
    meeting_type: string | null;
    call_subtype: string | null;
  };
  const allowedTypes = args.includeCustomer
    ? new Set(["new_opportunity", "existing_customer"])
    : new Set(["new_opportunity"]);

  const calls = ((callsRes.data ?? []) as CallRow[])
    .map((c) => ({ ...c, when: c.scheduled_start ?? c.call_date }))
    .filter((c) => c.when != null && c.when.slice(0, 10) >= args.since)
    // meeting_type defaults to new_opportunity when unset (matches classifier default)
    .filter((c) => allowedTypes.has(c.meeting_type ?? "new_opportunity"))
    .filter((c) => c.deal_id != null)
    .map((c) => {
      const info = dealInfo.get(c.deal_id!);
      return {
        id: c.id,
        rep: info?.rep ?? "the rep",
        account: info?.account ?? "(unknown)",
        subtype: callSubtypeLabel(c.call_subtype) ?? c.meeting_type ?? "call",
        date: shortDate(c.when),
      };
    })
    .filter((c) => (args.rep ? c.rep.toLowerCase() === args.rep : c.rep === "Juan" || c.rep === "Eduardo"))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  if (calls.length === 0) {
    console.error(`No matching customer calls found since ${args.since}. Nothing to analyze.`);
    process.exit(1);
  }

  // Transcripts for those calls.
  const ids = calls.map((c) => c.id);
  const tRes = await db.from("transcripts").select("call_id, body").eq("tenant_id", tenantId).in("call_id", ids);
  const bodyByCall = new Map(
    ((tRes.data ?? []) as Array<{ call_id: string; body: string | null }>).map((t) => [t.call_id, t.body ?? ""]),
  );

  // Ground truth for "what worked": which qualification gates each call actually
  // confirmed. extraction_runs.raw_response is that call's per-field extraction,
  // so a field marked "Yes" there is a gate this call filled. A call may have
  // several runs (re-ingests); union them.
  const erRes = await db
    .from("extraction_runs")
    .select("call_id, raw_response")
    .eq("tenant_id", tenantId)
    .in("call_id", ids);
  const confirmedByCall = new Map<string, string[]>();
  for (const row of (erRes.data ?? []) as Array<{ call_id: string; raw_response: unknown }>) {
    const rr = row.raw_response;
    if (!rr || typeof rr !== "object") continue;
    const labels: string[] = [];
    for (const [key, val] of Object.entries(rr as Record<string, unknown>)) {
      const st = (val as { status?: unknown } | null)?.status;
      if (st === "Yes") labels.push(labelByKey.get(key) ?? key);
    }
    if (labels.length) {
      const prev = confirmedByCall.get(row.call_id) ?? [];
      confirmedByCall.set(row.call_id, [...new Set([...prev, ...labels])]);
    }
  }

  console.log(`\nMining ${calls.length} customer call(s) since ${args.since}...\n`);

  const reads: CallRead[] = [];
  for (const c of calls) {
    const gatesConfirmed = confirmedByCall.get(c.id) ?? [];
    const body = bodyByCall.get(c.id) ?? "";
    if (body.trim().length < 200) {
      console.log(`  skip  ${c.date.padEnd(7)} ${c.account.slice(0, 22).padEnd(22)} ${c.rep} (no transcript)`);
      reads.push({ ...c, callId: c.id, gatesConfirmed, analysis: null, error: "no transcript" });
      continue;
    }
    const gc = gatesConfirmed.length ? ` [gates: ${gatesConfirmed.join(", ")}]` : "";
    process.stdout.write(`  read  ${c.date.padEnd(7)} ${c.account.slice(0, 22).padEnd(22)} ${c.rep}${gc} ... `);
    const read = await extractCall({ ...c, callId: c.id, gatesConfirmed }, body);
    console.log(read.analysis ? "ok" : `failed (${read.error})`);
    reads.push(read);
  }

  const good = reads.filter((r) => r.analysis);
  if (good.length === 0) {
    console.error("\nEvery call failed extraction. Not writing a playbook.");
    process.exit(1);
  }

  // Synthesis pass.
  const repsPresent = [...new Set(good.map((r) => r.rep))];
  console.log(`\nSynthesizing playbook from ${good.length} call read(s)...`);
  const synthInput = good.map((r) => ({
    rep: r.rep,
    account: r.account,
    type: r.subtype,
    date: r.date,
    gatesConfirmed: r.gatesConfirmed,
    read: r.analysis,
  }));

  let playbookMd = "";
  try {
    const resp = await getAnthropicClient().messages.create({
      model: getAnthropicModel(),
      max_tokens: 8000,
      temperature: 0.3,
      system: synthSystem(repsPresent),
      messages: [{ role: "user", content: `Per-call reads (JSON):\n\n${JSON.stringify(synthInput, null, 2)}` }],
    });
    playbookMd = resp.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  } catch (e) {
    console.error(`Synthesis failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // Write outputs.
  mkdirSync(args.out, { recursive: true });
  const header = `<!-- Generated by scripts/rep-playbook.ts on ${new Date().toISOString().slice(0, 10)} from ${good.length} calls (${repsPresent.join(
    ", ",
  )}) since ${args.since}. NDA: contains customer detail, keep local. -->\n\n`;
  const mdPath = join(args.out, "rep-playbook.md");
  const jsonPath = join(args.out, "rep-playbook.json");
  writeFileSync(mdPath, header + playbookMd + "\n");
  writeFileSync(
    jsonPath,
    JSON.stringify({ generatedAt: new Date().toISOString(), since: args.since, reps: repsPresent, reads }, null, 2),
  );

  const failed = reads.filter((r) => !r.analysis).length;
  console.log(`\nDone.`);
  console.log(`  Playbook : ${mdPath}`);
  console.log(`  Raw reads: ${jsonPath}`);
  console.log(`  Calls analyzed: ${good.length}  |  skipped/failed: ${failed}  |  reps: ${repsPresent.join(", ")}`);
  console.log("");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
