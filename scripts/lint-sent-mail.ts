/**
 * Run the draft lint over two corpora and compare them.
 *
 *   npx tsx scripts/lint-sent-mail.ts
 *   npx tsx scripts/lint-sent-mail.ts --show      # print the offending text
 *
 * READ ONLY. With --show it prints sentences from customer-facing mail, so
 * treat the output as transcript-class material: it stays local.
 *
 * TWO CORPORA, AND THE COMPARISON IS THE POINT.
 *
 *   THE REPS' OWN SENT MAIL (deal_messages, outbound, human, real body).
 *   The control group. A lint rule that fires here is not catching DealRipe's
 *   register, it is catching sales email, and it would push every draft into a
 *   regeneration loop that makes it worse. CLAUDE.md's rule about flags applies
 *   to lint rules: check the fire rate across the whole book before shipping
 *   one. A rule above a few percent here should be narrowed or deleted.
 *
 *   DEALRIPE'S OWN DRAFTS (sent_messages, kind='followup_draft').
 *   The thing being measured. Every row written before 2026-09-11 predates
 *   lib/draft-lint.ts and shows what the prompt produced with no enforcement
 *   behind it. Rows after it went through generate, lint, regenerate once.
 *
 * The gap between the two numbers is the whole claim. Near-zero on mail humans
 * chose to send, plus a real rate on our own unchecked drafts, is what says the
 * rules discriminate. Either figure alone proves nothing: a lint that fires on
 * nothing is inert, and one that fires on everything is noise.
 *
 * WHAT THIS CANNOT TEST. third_person_recipient needs the To line parsed into
 * first names, which sent_messages stores as a single address string. It is
 * skipped on both corpora rather than approximated, because guessing the
 * recipient names would decide the rule's own result. It is covered by
 * scripts/test-draft-lint.ts and exercised live by scripts/test-draft.ts.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { lintDraft, type DraftFinding } from "../lib/draft-lint";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

/**
 * The exact moment lib/draft-lint.ts reached production, in UTC.
 *
 * Commit bf8d401 at 12:56 PDT, Vercel production deployment ready 12:57 PDT.
 *
 * A DATE IS NOT PRECISE ENOUGH AND GETTING THAT WRONG INVERTS THE RESULT. The
 * first version of this split on the date "2026-09-11" and reported that the
 * LINTED drafts carried correction_invite at 42.9% against 1.7% before, which
 * reads as the lint having made things worse. sent_messages.sent_at is UTC, so
 * every draft written that morning Pacific carries an 18:xx or 19:xx stamp and
 * landed on the wrong side of a date-only comparison. All three offenders were
 * written before the deploy.
 */
const LINT_LIVE_FROM = "2026-09-11T19:57:00Z";

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

type Doc = { id: string; subject: string | null; body: string; at: string | null };

function audit(docs: ReadonlyArray<Doc>): { byRule: Map<string, DraftFinding[]>; hit: number } {
  const byRule = new Map<string, DraftFinding[]>();
  let hit = 0;
  for (const d of docs) {
    const f = lintDraft({ body: d.body, subject: d.subject ?? "" }).filter((x) => x.tier !== "fix");
    if (f.length) hit += 1;
    for (const x of f) byRule.set(x.rule, [...(byRule.get(x.rule) ?? []), x]);
  }
  return { byRule, hit };
}

function report(label: string, docs: ReadonlyArray<Doc>, show: boolean): void {
  if (docs.length === 0) {
    console.log(`\n  ${label}\n    (no documents)\n`);
    return;
  }
  const { byRule, hit } = audit(docs);
  const pct = (n: number) => `${((n / docs.length) * 100).toFixed(1)}%`;
  console.log(`\n  ${label}   n=${docs.length}`);
  console.log("  " + "-".repeat(56));
  if (byRule.size === 0) {
    console.log(`    (no rule fired)`);
  } else {
    for (const [rule, hits] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`    ${rule.padEnd(26)} ${String(hits.length).padStart(4)}   ${pct(hits.length).padStart(6)}`);
    }
  }
  console.log(`    ${"DOCUMENTS WITH A FINDING".padEnd(26)} ${String(hit).padStart(4)}   ${pct(hit).padStart(6)}`);
  if (show) {
    for (const [rule, hits] of byRule) {
      console.log(`\n    ${rule}:`);
      for (const h of hits.slice(0, 8)) console.log(`      ${h.detail}`);
    }
  }
}

async function main(): Promise<void> {
  const show = process.argv.includes("--show");
  const tenantId = await resolveTenantId("magaya");

  const msgs = await page<{
    id: string;
    direction: string | null;
    is_machine_sender: boolean | null;
    is_calendar_response: boolean | null;
    body_trimmed: string | null;
    subject: string | null;
    sent_at: string | null;
  }>(
    "deal_messages",
    "id, direction, is_machine_sender, is_calendar_response, body_trimmed, subject, sent_at",
    tenantId,
  );

  // A REAL rep message: outbound, human, not a calendar artifact, and long
  // enough to be prose rather than "sounds good".
  const repMail: Doc[] = msgs
    .filter(
      (m) =>
        m.direction === "outbound" &&
        !m.is_machine_sender &&
        !m.is_calendar_response &&
        (m.body_trimmed ?? "").length > 200,
    )
    .map((m) => ({ id: m.id, subject: m.subject, body: m.body_trimmed ?? "", at: m.sent_at }));

  const sent = await page<{ id: string; kind: string | null; subject: string | null; body_text: string | null; sent_at: string | null }>(
    "sent_messages",
    "id, kind, subject, body_text, sent_at",
    tenantId,
  );
  const ourDrafts: Doc[] = sent
    .filter((r) => r.kind === "followup_draft" && (r.body_text ?? "").length > 120)
    .map((r) => ({ id: r.id, subject: r.subject, body: r.body_text ?? "", at: r.sent_at }));

  const before = ourDrafts.filter((d) => (d.at ?? "") < LINT_LIVE_FROM);
  const after = ourDrafts.filter((d) => (d.at ?? "") >= LINT_LIVE_FROM);

  console.log(`\n  DRAFT REGISTER AUDIT`);
  report("THE REPS' OWN SENT MAIL   (control group)", repMail, show);
  report(`DEALRIPE DRAFTS, BEFORE ${LINT_LIVE_FROM}   (no lint)`, before, show);
  report(`DEALRIPE DRAFTS, ON OR AFTER ${LINT_LIVE_FROM}   (linted)`, after, show);

  console.log(
    `\n  Read it as a comparison, not three numbers. The control group is what\n` +
      `  sales email looks like; a rule that fires there is wrong. Our own\n` +
      `  pre-lint drafts are the defect being measured. The linted set is the\n` +
      `  claim, and it is only meaningful once it has rows in it.\n`,
  );
  if (after.length === 0) {
    console.log(
      `  NOTE: no drafts written since the lint went live yet, so the third\n` +
        `  figure is not evidence of anything. Re-run after a day of captures.\n`,
    );
  }
}

main().catch((e) => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
