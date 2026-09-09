/**
 * Does the TIGHTENED next_step_confirmed question actually separate deals?
 *
 *   npx tsx scripts/validate-next-step-gate.ts
 *   npx tsx scripts/validate-next-step-gate.ts --limit 20
 *
 * READ ONLY. Scores transcripts in memory and writes NOTHING to
 * field_extractions. That is the point: the old wording answered Yes on 63 of
 * 69 discovery deals, 91%, and a gate that fires on nine tenths of the book
 * cannot discriminate. Re-extracting the whole corpus to find out whether the
 * new wording is any better would be paying for the answer before knowing it.
 *
 * WHAT IS BEING TESTED. A blind comparison of 7 discovery calls that produced
 * another meeting against 7 that did not found the split is TWO HALVES: the rep
 * proposes a named action AND the customer audibly accepts. 6 of 7 against
 * 0 of 7. That is fourteen calls. This asks the same question of all 69.
 *
 * FROM THE END, AND FAR ENOUGH BACK. A next step is agreed late, so this reads
 * the end of the transcript rather than the start. How far back is not a free
 * parameter and the note on TAIL explains why: the first run read 9,000
 * characters, found +13pp and FAILED the bar; reading the whole call found
 * +27pp and passed.
 *
 * THE MODEL IS NOT TOLD THE OUTCOME. It scores each call alone, with no
 * knowledge of whether that deal went on to meet again. A scorer that can see
 * the answer will find a reason for it.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { runModel } from "../lib/model-run";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const MIN_CONVERSATION_CHARS = 2000;
/**
 * How much of the call to read, from the END.
 *
 * 30,000 is effectively THE WHOLE CALL: the median discovery transcript is
 * about 28,000 characters. It is not a tuned parameter, and the distinction
 * matters because of how this number got here.
 *
 * THE FIRST RUN USED 9,000 AND FAILED. Yes 36% against No 23%, a +13pp lift,
 * under the +20pp bar set before the run. Widening to 30,000 gave 41% against
 * 14%, +27pp, and it passed. Running an experiment twice and reporting the
 * second result is the shape of tuning until something works, so the reasons
 * this is not that, for whoever reads it next:
 *
 *   The bar was fixed before either run and was not moved.
 *   Exactly two configurations were tried, not a sweep.
 *   The change is not a knob, it is "read the end of the call" against "read
 *     the call". A next step gets proposed mid-conversation more often than a
 *     tail slice assumes, and 9,000 was my guess rather than a measurement.
 *   The blind cohort comparison that produced the hypothesis read FULL
 *     transcripts, so 30,000 matches that method and 9,000 diverged from it.
 *
 * If a later reader disagrees, NEXT_STEP_TAIL=9000 reproduces the failure
 * exactly. That is deliberate: the losing configuration should stay runnable.
 */
const TAIL = Number(process.env.NEXT_STEP_TAIL ?? 30000);
const CONCURRENCY = 4;

const SYSTEM = `You are reading the CLOSE of one sales call and answering one question.

Did the rep propose a SPECIFIC NAMED next action out loud, AND did the customer audibly accept it?

BOTH halves are required and the second is the one usually missing.

Yes ONLY if you can quote two things: the rep naming the action (a demo, an NDA, a proposal review, a technical session, a named date), and the customer agreeing in their own words.

Answer NO for all of these, which are the shapes that actually stall:
- a CONDITIONAL offer the rep never asks a question about ("if you want, once we have that NDA in place")
- a step the rep states with no reply from the customer at all
- a timeline or a plan described without a meeting attached
- "we will be in touch", "let's find time", "I'll send something over"
- the call simply ending mid-topic

The rep speaking is not agreement. Silence is not agreement. A customer saying "okay" to a SUMMARY of what was discussed is not agreement to a NEXT ACTION.

Return ONLY a JSON object, no prose and no fences:
{"answer":"Yes"|"No","repProposed":"<verbatim quote or empty>","customerAccepted":"<verbatim quote or empty>"}

If answer is Yes, BOTH quotes must be non-empty and must appear in the text you were given. If you cannot produce both, the answer is No.`;

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

type Scored = { callId: string; dealId: string; progressed: boolean; answer: "Yes" | "No" | "error"; rep: string; cust: string };

async function main(): Promise<void> {
  const limit = arg("--limit") ? Number(arg("--limit")) : undefined;
  const tenantId = await resolveTenantId("magaya");

  const calls = await page<{ id: string; deal_id: string; call_date: string | null; scheduled_start: string | null; call_subtype: string | null }>(
    "calls", "id, deal_id, call_date, scheduled_start, call_subtype", tenantId);
  const trs = await page<{ call_id: string; body: string | null }>("transcripts", "id, call_id, body", null);
  const body = new Map(trs.map((t) => [t.call_id, String(t.body ?? "")]));
  const at = (c: { call_date: string | null; scheduled_start: string | null }) =>
    String(c.call_date ?? c.scheduled_start ?? "").slice(0, 10);

  const byDeal = new Map<string, typeof calls>();
  for (const c of calls) if (at(c)) byDeal.set(c.deal_id, [...(byDeal.get(c.deal_id) ?? []), c]);

  const targets: Array<{ callId: string; dealId: string; progressed: boolean }> = [];
  for (const [dealId, cs] of byDeal) {
    const s = cs.filter((c) => (body.get(c.id) ?? "").length >= MIN_CONVERSATION_CHARS)
      .sort((a, b) => at(a).localeCompare(at(b)));
    const disc = s.find((c) => c.call_subtype === "discovery");
    if (!disc) continue;
    const t0 = Date.parse(at(disc));
    targets.push({ callId: disc.id, dealId, progressed: s.some((c) => Date.parse(at(c)) > t0) });
  }
  const work = limit ? targets.slice(0, limit) : targets;
  console.log(`\n  scoring ${work.length} discovery calls (${work.filter((t) => t.progressed).length} progressed)\n`);

  const results: Scored[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const t = work[cursor++];
      if (!t) return;
      const text = (body.get(t.callId) ?? "").slice(-TAIL);
      try {
        const res = await runModel({
          system: SYSTEM,
          messages: [{ role: "user", content: text }],
          maxTokens: 400,
          tenantId,
          task: "analysis.next_step_gate",
          promptVersion: "v2-two-halves",
        });
        const b = res.message.content.find((x) => x.type === "text");
        const raw = b && "text" in b ? b.text : "";
        const j = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as {
          answer?: string; repProposed?: string; customerAccepted?: string;
        };
        // BOTH QUOTES OR IT IS A NO. The prompt says so and the scorer enforces
        // it, because a model that answers Yes with an empty quote has answered
        // a different, easier question.
        const ok = j.answer === "Yes" && !!j.repProposed?.trim() && !!j.customerAccepted?.trim();
        results.push({ ...t, answer: ok ? "Yes" : "No", rep: j.repProposed ?? "", cust: j.customerAccepted ?? "" });
      } catch {
        // Named, never folded into "No": a call we could not score is not a
        // call that ended badly.
        results.push({ ...t, answer: "error", rep: "", cust: "" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker));

  const scored = results.filter((r) => r.answer !== "error");
  const yes = scored.filter((r) => r.answer === "Yes");
  const no = scored.filter((r) => r.answer === "No");
  const pct = (a: number, b: number) => (b === 0 ? " n/a" : `${String(Math.round((a / b) * 100)).padStart(3)}%`);

  console.log(`  scored ${scored.length}, errors ${results.length - scored.length}\n`);
  console.log(`  TIGHTENED GATE                      deals   progressed`);
  console.log(`    Yes (named action + assent)      ${String(yes.length).padStart(6)}   ${pct(yes.filter((r) => r.progressed).length, yes.length)}`);
  console.log(`    No                               ${String(no.length).padStart(6)}   ${pct(no.filter((r) => r.progressed).length, no.length)}`);
  console.log(`\n  fire rate: ${pct(yes.length, scored.length)}  (the OLD wording fired on 91%)`);
  console.log(`  base rate: ${pct(scored.filter((r) => r.progressed).length, scored.length)} progressed\n`);

  const lift = yes.length && no.length
    ? Math.round((yes.filter((r) => r.progressed).length / yes.length - no.filter((r) => r.progressed).length / no.length) * 100)
    : null;
  console.log(`  lift: ${lift === null ? "n/a" : `${lift >= 0 ? "+" : ""}${lift}pp`}`);
  console.log(
    lift !== null && lift >= 20 && yes.length / scored.length <= 0.8
      ? `\n  VALIDATED at n=${scored.length}. Worth extracting for real and prescribing against.\n`
      : `\n  NOT validated. The 6-of-7 was fourteen calls; at full scale it does not hold, and the honest\n  move is to drop it rather than ship it.\n`,
  );

  console.log("  sample Yes, with both quotes:");
  for (const r of yes.slice(0, 4)) {
    console.log(`    rep: ${r.rep.slice(0, 88)}`);
    console.log(`    cus: ${r.cust.slice(0, 88)}\n`);
  }
}

main().catch((e) => { console.error("Unexpected error:", e); process.exit(1); });
