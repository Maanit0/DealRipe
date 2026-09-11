/**
 * Run the draft lint over the reps' OWN sent mail.
 *
 *   npx tsx scripts/lint-sent-mail.ts
 *   npx tsx scripts/lint-sent-mail.ts --show           # print every hit
 *
 * READ ONLY. Prints counts and, with --show, sentences from customer mail, so
 * treat the output as transcript-class material: it stays local.
 *
 * WHY THIS EXISTS. lintDraft is a flag, so CLAUDE.md's rule governs it: check
 * the fire rate across the whole book before shipping it. A lint rule that
 * fires on what the six reps actually send is not catching DealRipe's register,
 * it is catching sales email, and it would send every draft into a
 * regeneration loop that makes it worse.
 *
 * The reps' sent mail is the right control group precisely because it is the
 * thing the draft is imitating. Near-zero here plus a hit on the drafts a human
 * complained about is the evidence that a rule discriminates. Either half alone
 * proves nothing.
 *
 * A rule that fires above a few percent here should be narrowed or deleted, not
 * kept because it feels right.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { lintDraft, type DraftFinding } from "../lib/draft-lint";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

/** PostgREST silently caps a plain select at 1000. Five bugs in this repo. */
async function page<T>(table: string, cols: string, tenantId: string): Promise<T[]> {
  const db = supabaseAdmin() as unknown as { from: (t: string) => { select: (c: string) => unknown } };
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    let q: unknown = db.from(table).select(cols);
    q = (q as { eq: (a: string, b: string) => unknown }).eq("tenant_id", tenantId);
    q = (q as { order: (c: string, o: unknown) => unknown }).order("id", { ascending: true });
    q = (q as { range: (a: number, b: number) => unknown }).range(from, from + 999);
    const res = await (q as Promise<{ data: T[] | null; error: { message: string } | null }>);
    if (res.error) throw new Error(`${table} read failed: ${res.error.message}`);
    const rows = res.data ?? [];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

type Row = {
  id: string;
  direction: string | null;
  is_machine_sender: boolean | null;
  is_calendar_response: boolean | null;
  body_trimmed: string | null;
  subject: string | null;
};

async function main(): Promise<void> {
  const show = process.argv.includes("--show");
  const tenantId = await resolveTenantId("magaya");

  const msgs = await page<Row>(
    "deal_messages",
    "id, direction, is_machine_sender, is_calendar_response, body_trimmed, subject",
    tenantId,
  );

  // A REAL rep message: outbound, written by a human, not a calendar artifact,
  // and long enough to be prose rather than "sounds good".
  const sent = msgs.filter(
    (m) =>
      m.direction === "outbound" &&
      !m.is_machine_sender &&
      !m.is_calendar_response &&
      (m.body_trimmed ?? "").length > 200,
  );

  const byRule = new Map<string, DraftFinding[]>();
  let anyHit = 0;
  for (const m of sent) {
    // No recipientNames: the third_person_recipient rule needs the To line,
    // which this table does hold, but a rep naming a colleague of the customer
    // is legal under rule 9a and the sent corpus cannot distinguish the two.
    // Excluding it here is honest rather than convenient, and it is why the
    // rule is validated on drafts instead.
    const f = lintDraft({ body: m.body_trimmed ?? "", subject: m.subject ?? "" }).filter((x) => x.tier !== "fix");
    if (f.length) anyHit += 1;
    for (const x of f) byRule.set(x.rule, [...(byRule.get(x.rule) ?? []), x]);
  }

  const pct = (n: number) => `${((n / sent.length) * 100).toFixed(1)}%`;
  console.log(`\n  ${sent.length} real outbound rep messages with a stored body.\n`);
  console.log(`  RULE                          fires   of corpus`);
  console.log("  " + "-".repeat(50));
  for (const [rule, hits] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${rule.padEnd(28)} ${String(hits.length).padStart(5)}   ${pct(hits.length).padStart(6)}`);
  }
  if (byRule.size === 0) console.log(`  (none fired)`);
  console.log(`\n  messages with at least one finding: ${anyHit}  (${pct(anyHit)})`);
  console.log(
    `\n  A rule above a few percent here is catching sales email rather than\n` +
      `  DealRipe's register. Narrow it or delete it.\n`,
  );

  if (show) {
    for (const [rule, hits] of byRule) {
      console.log(`\n  ${rule}:`);
      for (const h of hits.slice(0, 10)) console.log(`    ${h.detail}`);
    }
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
