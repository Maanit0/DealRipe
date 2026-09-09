/**
 * Does the CUSTOMER quantifying their pain separate outcomes at Magaya?
 *
 *   npx tsx scripts/probe-pain-quantification.ts
 *   npx tsx scripts/probe-pain-quantification.ts --examples
 *
 * READ ONLY. Prints counts and rates. --examples prints short customer-spoken
 * fragments, which are NDA material: read them, do not paste them anywhere.
 *
 * THE QUESTION. Standard qualification methodology says a buyer must articulate
 * pain and quantify its cost before they will change. If that holds at Magaya
 * it should be visible: deals where the customer put a number on the problem
 * should behave differently from deals where they only described it.
 *
 * That is a claim about Magaya's book, and Magaya's book is sitting in 222
 * transcripts. Testing it beats importing it.
 *
 * THE MEASUREMENT ONLY COUNTS THE CUSTOMER. A rep saying "this saves you four
 * hours a week" is our pitch, not their pain, and it appears in almost every
 * demo. Speaker side comes from the invite roster via lib/speaker-match.ts,
 * never from the model. Attribution is crude (transcript labels matched to
 * invite names) and is stated as crude: it is a ratio, not an attribution.
 *
 * WHAT IT CANNOT TELL YOU. Whether quantifying CAUSED the outcome. A customer
 * who has done the arithmetic is already further along, so this measures what
 * accompanies progress. And n is small on the macro outcomes: 9 won, 17 lost,
 * five of the losses one hygiene sweep. The micro outcomes are where the n is.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { detectMicroOutcomes } from "../lib/micro-outcomes";
import { readParticipants, sellerDirectory, sideOfSpeaker, type Participant } from "../lib/speaker-match";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const MIN_CONVERSATION_CHARS = 2000;

/**
 * Language that puts a NUMBER on something that hurts, versus language that
 * merely describes it. Deliberately separate lists: the question is whether
 * quantification adds anything over articulation.
 */
const QUANTIFIED = [
  /\$\s?\d[\d,.]*/,                                   // a dollar figure
  /\b\d+\s*(hours?|hrs?|days?|weeks?|months?)\b/i,    // time spent
  /\b\d+\s*(people|persons?|staff|employees|headcount|FTEs?)\b/i,
  /\b\d+\s*(percent|%)/i,
  /\b(costs?|costing|spend(ing)?|paying|lose|losing|wasted?)\s+(us\s+)?(about\s+|around\s+|roughly\s+)?[\$\d]/i,
  /\b\d+[\d,.]*\s*(shipments?|entries|files|containers?|invoices?|transactions?)\s*(a|per)\s*(day|week|month|year)/i,
];

const ARTICULATED = [
  /\b(problem|issue|pain|struggle|struggling|frustrat\w*|bottleneck|headache)\b/i,
  /\b(manual(ly)?|double[- ]?key|re-?key|re-?type|by hand|spreadsheet)\b/i,
  /\b(takes (too )?long|slow(s| us)?|delays?|backlog|behind)\b/i,
  /\b(error|mistake|wrong|inaccura\w*|missed?)\b/i,
  /\bcan'?t\b.{0,40}\b(scale|handle|keep up|do)\b/i,
];

type Call = { id: string; deal_id: string; participants: unknown; call_subtype: string | null; meeting_type: string | null };

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

async function main(): Promise<void> {
  const tenantId = await resolveTenantId("magaya");
  const showExamples = process.argv.includes("--examples");

  const calls = await page<Call>("calls", "id, deal_id, participants, call_subtype, meeting_type", tenantId);
  const transcripts = await page<{ call_id: string; body: string | null }>("transcripts", "id, call_id, body", null);
  const bodyByCall = new Map(transcripts.map((t) => [t.call_id, String(t.body ?? "")]));

  // Seller directory across the whole window, so a colleague who joined without
  // being on this invite is still recognised as our side.
  const allRosters: Participant[][] = [];
  for (const c of calls) {
    const r = readParticipants(c.participants);
    if (r.status === "ok") allRosters.push(r.participants);
  }
  const directory = sellerDirectory(allRosters);

  type DealSignal = { quantified: boolean; articulated: boolean; examples: string[] };
  const byDeal = new Map<string, DealSignal>();
  let linesScanned = 0;
  let customerLines = 0;
  let unknownSide = 0;

  for (const c of calls) {
    const body = bodyByCall.get(c.id) ?? "";
    if (body.length < MIN_CONVERSATION_CHARS) continue;
    const r = readParticipants(c.participants);
    const roster = r.status === "ok" ? r.participants : [];

    const sig = byDeal.get(c.deal_id) ?? { quantified: false, articulated: false, examples: [] };
    for (const line of body.split("\n")) {
      const m = /^([^:]{2,60}):\s*(.+)$/.exec(line.trim());
      if (!m) continue;
      linesScanned += 1;
      const side = sideOfSpeaker(roster, m[1], directory);
      // "unknown" is its own answer and is NOT counted as the customer. The
      // seller side is routinely joined by someone who was never on the invite,
      // and crediting them to the buyer would inflate exactly the number this
      // probe exists to test.
      if (side !== "customer") {
        if (side === "unknown") unknownSide += 1;
        continue;
      }
      customerLines += 1;
      const text = m[2];
      const q = QUANTIFIED.some((re) => re.test(text));
      const a = ARTICULATED.some((re) => re.test(text));
      if (q) {
        sig.quantified = true;
        if (sig.examples.length < 3) sig.examples.push(text.slice(0, 150));
      }
      if (a) sig.articulated = true;
    }
    byDeal.set(c.deal_id, sig);
  }

  console.log(`\n  transcript lines scanned:        ${linesScanned}`);
  console.log(`  attributed to the CUSTOMER:      ${customerLines}`);
  console.log(`  speaker side unknown (excluded): ${unknownSide}`);
  console.log(`  deals with a captured conversation: ${byDeal.size}\n`);

  const outcomes = await detectMicroOutcomes(tenantId);
  const dealsWith = (kind: string) => new Set(outcomes.filter((o) => o.kind === kind).map((o) => o.dealId));

  const universe = [...byDeal.keys()];
  const rate = (ids: Set<string>, pick: (s: DealSignal) => boolean) => {
    const inSet = universe.filter((d) => ids.has(d));
    if (inSet.length === 0) return { n: 0, pct: 0 };
    return { n: inSet.length, pct: inSet.filter((d) => pick(byDeal.get(d)!)).length / inSet.length };
  };
  const pct = (x: number) => `${String(Math.round(x * 100)).padStart(3)}%`;

  console.log("  outcome                   n     articulated a pain   QUANTIFIED it");
  console.log("  " + "-".repeat(72));
  const kinds = ["closed_won", "closed_lost", "nda_executed", "quote_executed", "demo_after_discovery", "meeting_booked_demo"];
  for (const k of kinds) {
    const ids = dealsWith(k);
    const a = rate(ids, (s) => s.articulated);
    const q = rate(ids, (s) => s.quantified);
    if (a.n === 0) {
      console.log(`  ${k.padEnd(24)} 0     (no deal with a captured conversation)`);
      continue;
    }
    const warn = a.n < 8 ? "   <- too few to conclude" : "";
    console.log(`  ${k.padEnd(24)} ${String(a.n).padStart(3)}        ${pct(a.pct)}              ${pct(q.pct)}${warn}`);
  }
  const all = new Set(universe);
  const ba = rate(all, (s) => s.articulated);
  const bq = rate(all, (s) => s.quantified);
  console.log("  " + "-".repeat(72));
  console.log(`  ${"ALL DEALS (base rate)".padEnd(24)} ${String(ba.n).padStart(3)}        ${pct(ba.pct)}              ${pct(bq.pct)}`);
  console.log(
    `\n  Read every row against the base rate, not against 100%. A signal present on\n` +
      `  most of the book separates nothing, however sensible it sounds.`,
  );

  if (showExamples) {
    console.log("\n  CUSTOMER-SPOKEN QUANTIFICATION, a few examples. NDA material.\n");
    let shown = 0;
    for (const [dealId, s] of byDeal) {
      if (!s.quantified || s.examples.length === 0 || shown >= 12) continue;
      shown += 1;
      console.log(`    deal ${dealId.slice(0, 8)}  ${s.examples[0]}`);
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
