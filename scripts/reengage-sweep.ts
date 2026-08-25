/**
 * Sweep the open book and draft a re-engagement email for every deal a flag
 * says has gone quiet.
 *
 * This is the proactive half of the product. Everything DealRipe drafts today
 * is triggered by an event that already happened: a call ended, a meeting was a
 * no-show. A deal that stops moving in week three of a three-month cycle
 * produces no event at all, and Magaya's dominant recorded loss reason is No
 * Decision / Non-Responsive. The trigger here is the flag engine over the whole
 * book, which fires on the ABSENCE of things.
 *
 * It reuses loadPortfolioRead rather than recomputing, so a rep reading /read
 * and this sweep can never disagree about which deals are quiet.
 *
 *   npx tsx scripts/reengage-sweep.ts                dry run, prints every draft
 *   npx tsx scripts/reengage-sweep.ts --per-rep 5
 *   npx tsx scripts/reengage-sweep.ts --rep juan
 *   npx tsx scripts/reengage-sweep.ts --deal corelogistics
 *   npx tsx scripts/reengage-sweep.ts --limit 3 --apply
 *   npx tsx scripts/reengage-sweep.ts --apply        WRITES into reps' Drafts
 *
 * Dry run by default. Nothing is ever SENT: the app holds Mail.ReadWrite and
 * deliberately not Mail.Send.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { loadPortfolioRead } from "../lib/deal-read-portfolio";
import { domainOf } from "../lib/graph-mail";
import {
  createReengageDraft,
  DRAFTABLE,
  generateReengageDraft,
  recentlyDrafted,
} from "../lib/reengage-draft";
import { DEFAULT_PER_REP, runReengageSweep } from "../lib/reengage-sweep";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const SLUG = "magaya";
const INTERNAL_DOMAIN = "magaya.com";

/**
 * How many drafts one rep may receive from one sweep.
 *
 * 79 of 116 open deals carry a draftable flag, which is the honest count and
 * also completely unusable: a rep who opens Outlook to thirteen drafted emails
 * reads none of them, and the next week reads none again. The cap is what makes
 * this a morning routine rather than a mailbox event.
 *
 * Three is deliberately small. Anya's pitch is "read the drafts, edit one or
 * two, send", and that only works if the number is small enough to finish.
 * Raise it once reps ask for more, never before.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * Who to write to, from the people who were actually in the meetings.
 *
 * The invite roster, not the mailbox. A thread can pick up a forwarded
 * colleague or a shared alias; the roster is who sat in the room, which is who
 * a re-engagement is for.
 */
async function customerEmailsFor(tenantId: string, dealId: string): Promise<string[]> {
  const res = await supabaseAdmin()
    .from("calls")
    .select("participants, scheduled_start")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId)
    .eq("outcome", "captured")
    .order("scheduled_start", { ascending: false })
    .limit(4);
  if (res.error) return [];
  const out = new Set<string>();
  for (const row of (res.data ?? []) as Array<{ participants: unknown }>) {
    const people = Array.isArray(row.participants)
      ? (row.participants as Array<{ email?: string | null }>)
      : [];
    for (const p of people) {
      const e = (p?.email ?? "").toLowerCase().trim();
      if (e.includes("@") && domainOf(e) !== INTERNAL_DOMAIN) out.add(e);
    }
  }
  return [...out];
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const tenantId = await resolveTenantId(SLUG);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`${apply ? "DRAFTING" : "DRY RUN"}: re-engagement, triggered by flags rather than by calls`);
  console.log(`${"=".repeat(80)}\n`);

  // The work lives in lib/reengage-sweep.ts so the cron runs the same guards.
  const r = await runReengageSweep({
    tenantId,
    apply,
    perRep: Number(arg("--per-rep") ?? DEFAULT_PER_REP),
    limit: arg("--limit") ? Number(arg("--limit")) : undefined,
    onlyRep: arg("--rep") ?? undefined,
    onlyDeal: arg("--deal") ?? undefined,
  });

  console.log(`  ${r.openDeals} open deals, ${r.flagged} carrying a flag worth writing about\n`);
  if (r.cappedOut > 0) {
    console.log(`  ${r.cappedOut} more are flagged and were NOT drafted this run, held back by the per-rep cap.\n`);
  }

  for (const p of r.previews) {
    if (apply) {
      console.log(`  DRAFTED ${p.account}  ->  ${p.mailbox}`);
      continue;
    }
    console.log(`\n  ${"-".repeat(76)}`);
    console.log(`  ${p.account}  (${p.mailbox})`);
    console.log(`  why: ${p.why}`);
    console.log(`  to:  ${p.to.join(", ")}`);
    console.log(`  ${p.onThread ? "replies onto the live thread" : "fresh email, no live thread found"}`);
    console.log(`  subject: ${p.subject}`);
    console.log(``);
    for (const line of p.body.split("\n")) console.log(`    ${line}`);
  }

  if (r.skips.length > 0) {
    console.log(`\n${"-".repeat(80)}`);
    console.log(`NOT DRAFTED (${r.skips.length}) - each says why`);
    console.log(`${"-".repeat(80)}`);
    const byWhy = new Map<string, string[]>();
    for (const s of r.skips) (byWhy.get(s.why) ?? byWhy.set(s.why, []).get(s.why)!).push(s.account);
    for (const [why, list] of [...byWhy.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n  ${list.length}x  ${why}`);
      console.log(`      ${list.slice(0, 8).join(", ")}${list.length > 8 ? `, and ${list.length - 8} more` : ""}`);
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  if (apply) console.log(`drafted ${r.drafted}, failed ${r.failed}. Nothing was sent.`);
  else console.log(`DRY RUN. ${r.would} draft(s) generated and shown, nothing written. Re-run with --apply.`);
  console.log(`${"=".repeat(80)}\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
