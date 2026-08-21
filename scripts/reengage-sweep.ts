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
const DEFAULT_PER_REP = 3;

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
  const onlyRep = arg("--rep")?.toLowerCase();
  const onlyDeal = arg("--deal")?.toLowerCase();
  const limit = Number(arg("--limit") ?? Number.MAX_SAFE_INTEGER);
  const perRep = Number(arg("--per-rep") ?? DEFAULT_PER_REP);

  const tenantId = await resolveTenantId(SLUG);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`${apply ? "DRAFTING" : "DRY RUN"}: re-engagement, triggered by flags rather than by calls`);
  console.log(`${"=".repeat(80)}\n`);

  const rows = await loadPortfolioRead({ tenantId });
  const draftableIds = new Set(DRAFTABLE.map((d) => d.id));

  let candidates = rows.filter((r) => r.flags.some((f) => draftableIds.has(f.id)));
  if (onlyRep) candidates = candidates.filter((r) => (r.repEmail ?? "").toLowerCase().includes(onlyRep));
  if (onlyDeal) candidates = candidates.filter((r) => r.account.toLowerCase().includes(onlyDeal));

  // Best deal first, so a capped rep gets their three biggest rather than
  // whichever three sorted first. loadPortfolioRead orders by what needs a
  // person; within a rep that is the right order to spend the cap on.
  const perRepCount = new Map<string, number>();
  const capped: typeof candidates = [];
  let cappedOut = 0;
  for (const r of candidates) {
    const key = (r.repEmail ?? "?").toLowerCase();
    const n = perRepCount.get(key) ?? 0;
    if (n >= perRep) {
      cappedOut += 1;
      continue;
    }
    perRepCount.set(key, n + 1);
    capped.push(r);
  }

  console.log(
    `  ${rows.length} open deals, ${candidates.length} carrying a flag worth writing about, ` +
      `${capped.length} inside the ${perRep}-per-rep cap\n`,
  );
  if (cappedOut > 0) {
    // Said out loud rather than silently truncated. A sweep that quietly drops
    // 66 deals reads as "everything is handled", which it is not.
    console.log(`  ${cappedOut} more are flagged and were NOT drafted this run, held back by the cap.\n`);
  }
  candidates = capped;

  const skips: Array<{ account: string; why: string }> = [];
  let drafted = 0;
  let would = 0;
  let failed = 0;
  let seen = 0;

  for (const r of candidates) {
    if (seen >= limit) break;
    const flag = r.flags.find((f) => draftableIds.has(f.id))!;

    if (!r.repEmail) {
      skips.push({ account: r.account, why: "no rep email on the deal, so there is no mailbox to draft into" });
      continue;
    }
    // NEVER WRITE TO A CUSTOMER WHOSE DEAL IS OVER.
    //
    // loadPortfolioRead drops deals carrying an outcome_label, but a label only
    // exists once outcome-sync --apply has run, and it runs once a day at 06:00.
    // A deal that closed since then is still "open" to this sweep. Caught for
    // real on 2026-08-20: this script generated a re-engagement draft for
    // Aeronet offering to send workflow videos, and Salesforce had marked that
    // opportunity Closed Lost that same day, reason Executive Alignment.
    //
    // no_open_opportunity is the live read and means every opportunity on the
    // account is closed. It is exactly the state that used to render as "the
    // rep set no forecast band", and here it is the difference between a useful
    // draft and one that would embarrass a rep in front of a customer.
    if (r.crmRead?.status === "no_open_opportunity") {
      skips.push({
        account: r.account,
        why: "every opportunity on the Salesforce account is closed, so this deal is over",
      });
      continue;
    }
    if (r.crmRead?.status === "unavailable") {
      // Fail closed. Not knowing whether the deal is still live is a reason not
      // to mail the customer, not a reason to assume it is.
      skips.push({ account: r.account, why: `could not read Salesforce to confirm the deal is live (${r.crmRead.error})` });
      continue;
    }
    if (await recentlyDrafted(r.dealId, flag.id)) {
      skips.push({ account: r.account, why: `already drafted for '${flag.id}' inside the cooldown` });
      continue;
    }
    const customerEmails = await customerEmailsFor(tenantId, r.dealId);
    if (customerEmails.length === 0) {
      skips.push({ account: r.account, why: "no customer attendee on any captured call, so nobody to write to" });
      continue;
    }

    seen += 1;
    const draft = await generateReengageDraft({
      tenantId,
      dealId: r.dealId,
      account: r.account,
      mailbox: r.repEmail,
      customerEmails,
      signals: r.signals,
      flags: r.flags,
    });
    if (!draft) {
      failed += 1;
      console.log(`  FAILED  ${r.account}: generation returned nothing usable`);
      continue;
    }

    const res = await createReengageDraft(draft, { apply });
    if (res.status === "drafted") {
      drafted += 1;
      console.log(`\n  DRAFTED ${r.account}  ->  ${draft.mailbox}`);
    } else if (res.status === "would_draft") {
      would += 1;
      console.log(`\n  ${"-".repeat(76)}`);
      console.log(`  ${r.account}  (${draft.mailbox})`);
      console.log(`  why: ${flag.title}`);
      console.log(`  to:  ${draft.to.join(", ")}`);
      console.log(`  ${draft.replyToMessageId ? "replies onto the live thread" : "fresh email, no live thread found"}`);
      console.log(`  subject: ${draft.subject}`);
      console.log(``);
      for (const line of draft.body.split("\n")) console.log(`    ${line}`);
    } else {
      failed += 1;
      console.log(`  FAILED  ${r.account}: ${res.why}`);
    }
  }

  if (skips.length > 0) {
    console.log(`\n${"-".repeat(80)}`);
    console.log(`NOT DRAFTED (${skips.length}) - each says why`);
    console.log(`${"-".repeat(80)}`);
    const byWhy = new Map<string, string[]>();
    for (const s of skips) (byWhy.get(s.why) ?? byWhy.set(s.why, []).get(s.why)!).push(s.account);
    for (const [why, list] of [...byWhy.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n  ${list.length}x  ${why}`);
      console.log(`      ${list.slice(0, 8).join(", ")}${list.length > 8 ? `, and ${list.length - 8} more` : ""}`);
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  if (apply) console.log(`drafted ${drafted}, failed ${failed}. Nothing was sent.`);
  else console.log(`DRY RUN. ${would} draft(s) generated and shown, nothing written. Re-run with --apply.`);
  console.log(`${"=".repeat(80)}\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
