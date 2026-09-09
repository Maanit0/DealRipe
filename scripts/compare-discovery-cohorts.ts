/**
 * What was actually SAID on discovery calls that progressed, versus ones that did not.
 *
 *   npx tsx scripts/compare-discovery-cohorts.ts
 *   npx tsx scripts/compare-discovery-cohorts.ts --per 8
 *
 * READ ONLY. Output goes to stdout and to .previews/, which is gitignored:
 * every quote in it is a customer speaking under NDA.
 *
 * WHY A MODEL AND NOT A REGEX. Every deterministic pass in this session found
 * the same thing: nothing separates the cohorts. Transcript length is
 * near-identical (28.0k against 25.8k median), pain articulation is measurable
 * but weak on its own, and the gate answers cluster. Whatever the difference
 * is, it is in what was said and how, which is what a model reads and a pattern
 * does not.
 *
 * THE COHORTS. A captured discovery call, then: another captured meeting
 * followed (20 deals), or none did (49). That is the biggest, cleanest contrast
 * available at this sample size, and it is deliberately NOT "won versus lost",
 * which is 10 against 20 with five of the losses one hygiene sweep.
 *
 * HOW THIS IS KEPT HONEST, because a model asked to find differences will
 * always find some:
 *
 *   Both cohorts are UNLABELLED in the prompt. The model is told there are two
 *   groups and not which is which, so it cannot pattern-match to what it
 *   expects a good sales call to look like. It has to say which group it thinks
 *   progressed and why, and being wrong is a real outcome.
 *
 *   Every claim must carry a verbatim quote and which group it came from. A
 *   difference nobody said out loud is not a finding.
 *
 *   It is told explicitly that "no clear difference" is a permitted and
 *   expected answer. Generic sales advice that would survive any call is named
 *   as the failure mode to avoid.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runModel } from "../lib/model-run";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const MIN_CONVERSATION_CHARS = 2000;
/** Per transcript. Enough for the shape of the call without a 400k prompt. */
const SLICE = 18_000;

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(n);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function page<T>(table: string, cols: string, tenantId: string | null): Promise<T[]> {
  const db = supabaseAdmin() as unknown as { from: (t: string) => { select: (c: string) => unknown } };
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: unknown = db.from(table).select(cols);
    if (tenantId) q = (q as { eq: (a: string, b: string) => unknown }).eq("tenant_id", tenantId);
    q = (q as { order: (c: string, o: unknown) => unknown }).order("id", { ascending: true });
    q = (q as { range: (a: number, b: number) => unknown }).range(from, from + 999);
    const res = (await (q as Promise<{ data: T[] | null; error: { message: string } | null }>));
    if (res.error) throw new Error(`${table} read failed: ${res.error.message}`);
    const rows = res.data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

const SYSTEM = `You are comparing two sets of sales discovery-call transcripts from the same company, the same six reps, and the same product.

One set is from deals where another meeting followed. The other is from deals where nothing followed. YOU ARE NOT TOLD WHICH IS WHICH. Part of your job is to say which you think is which, and why.

WHAT TO LOOK FOR: differences in what was actually said and done on the call. The rep's questions and their order. What the customer volunteered against what had to be pulled. Whether a specific next step was proposed out loud and whether the customer agreed to it. Who was on the call. How objections were handled. What was promised. How the call ended.

RULES, and the analysis is worthless without them:

1. EVERY claim carries a VERBATIM QUOTE and the group it came from (A or B). A difference nobody said out loud is not a finding, it is a guess.
2. "No clear difference" is a permitted and expected answer. Say it plainly where it is true. These are 20 calls against 49 from the same team; most things will not separate.
3. NO GENERIC SALES ADVICE. If a sentence would survive being written about any sales team anywhere ("build rapport", "confirm next steps", "understand their pain"), delete it. The test: could this observation have been made without reading these transcripts? If yes, it is noise.
4. Do not assume the longer or more detailed call is the better one. Median length is near-identical between the groups.
5. Count things where you can. "In 5 of 8 group A calls the rep proposed a specific date out loud, against 1 of 8 in group B" is worth more than an adjective.
6. If your reading of which group progressed turns out to rest on one or two calls, say so.

Return plain prose with short sections. No markdown headers beyond simple labels. Be concrete and be brief where there is nothing to say.`;

async function main(): Promise<void> {
  const per = Number(arg("--per") ?? 7);
  const tenantId = await resolveTenantId("magaya");

  const calls = await page<{ id: string; deal_id: string; call_date: string | null; scheduled_start: string | null; call_subtype: string | null }>(
    "calls", "id, deal_id, call_date, scheduled_start, call_subtype", tenantId);
  const trs = await page<{ call_id: string; body: string | null }>("transcripts", "id, call_id, body", null);
  const body = new Map(trs.map((t) => [t.call_id, String(t.body ?? "")]));
  const at = (c: { call_date: string | null; scheduled_start: string | null }) =>
    String(c.call_date ?? c.scheduled_start ?? "").slice(0, 10);

  const byDeal = new Map<string, typeof calls>();
  for (const c of calls) if (at(c)) byDeal.set(c.deal_id, [...(byDeal.get(c.deal_id) ?? []), c]);

  const progressed: string[] = [];
  const stalled: string[] = [];
  for (const [, cs] of byDeal) {
    const s = cs.filter((c) => (body.get(c.id) ?? "").length >= MIN_CONVERSATION_CHARS)
      .sort((a, b) => at(a).localeCompare(at(b)));
    const disc = s.find((c) => c.call_subtype === "discovery");
    if (!disc) continue;
    const t0 = Date.parse(at(disc));
    (s.some((c) => Date.parse(at(c)) > t0) ? progressed : stalled).push(disc.id);
  }

  // Longest first in each group, so the sample is calls with enough substance
  // to compare rather than whichever ids sorted first.
  const pick = (ids: string[]) =>
    [...ids].sort((a, b) => (body.get(b) ?? "").length - (body.get(a) ?? "").length).slice(0, per);
  const A = pick(progressed);
  const B = pick(stalled);

  const render = (ids: string[], label: string) =>
    ids.map((id, i) => `----- GROUP ${label}, CALL ${i + 1} -----\n${(body.get(id) ?? "").slice(0, SLICE)}`).join("\n\n");

  console.log(`\n  group A: ${A.length} of ${progressed.length} that progressed`);
  console.log(`  group B: ${B.length} of ${stalled.length} that stalled`);
  console.log(`  sending ~${Math.round((A.concat(B).reduce((n, id) => n + Math.min(SLICE, (body.get(id) ?? "").length), 0)) / 1000)}k chars\n`);

  const res = await runModel({
    system: SYSTEM,
    messages: [{ role: "user", content: `${render(A, "A")}\n\n${render(B, "B")}` }],
    maxTokens: 4000,
    tenantId,
    // The dimension model_runs groups by. Not optional: the trace insert has a
    // NOT NULL on it, and passing an unknown key instead made the analysis run
    // fine while recording nothing.
    task: "analysis.discovery_cohorts",
    promptVersion: "v1-blind-cohorts",
  });
  const block = res.message.content.find((b) => b.type === "text");
  const text = block && "text" in block ? block.text : "(no output)";

  console.log(text);
  mkdirSync(".previews", { recursive: true });
  const p = resolve(".previews/discovery-cohort-comparison.txt");
  writeFileSync(p, `A = progressed (${A.length}/${progressed.length}), B = stalled (${B.length}/${stalled.length})\n\n${text}\n`, "utf8");
  console.log(`\n  written to ${p}  (gitignored, NDA material)\n`);
  console.log(`  GROUND TRUTH, for checking the model's guess: A progressed, B stalled.\n`);
}

main().catch((e) => { console.error("Unexpected error:", e); process.exit(1); });
