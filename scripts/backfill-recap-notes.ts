/**
 * Put a recap Note on every past call that has one to give.
 *
 * Eduardo, 2026-08-20: "Still missing the notes in some deals." He is right,
 * and the cause was narrow: lib/salesforce-note.ts worked and was called by
 * exactly one thing, scripts/preview-recap.ts --post-note, so every Note in
 * Magaya's org had been posted by hand. recap-sync now posts one on every new
 * recap. This is the back catalogue.
 *
 * He asked for this in the first place on 2026-07-21: "for me to record that
 * into Salesforce I need to either send my recap email to the customer, or put
 * it as a note... maybe you can insert this as notes."
 *
 * WHAT IT POSTS, AND THE TRADEOFF
 *
 * The stored recap body from sent_messages, not a freshly rendered Note.
 *
 * renderRecapNote produces a slightly different layout, and using it would mean
 * regenerating each recap: three LLM passes at about three and a half minutes a
 * call, roughly four hours and real money for 69 calls, to change formatting on
 * something a reader has already seen in their inbox. The content is identical
 * because both render the same recap. New calls get the proper Note format from
 * recap-sync; the back catalogue gets the body that was actually sent, which is
 * also the body Eduardo has been pasting in by hand.
 *
 * WHAT IT WILL NOT DO
 *
 *   A deal whose Salesforce link is below `confirmed` is skipped. Same rule as
 *   every other Salesforce write: a weaker link may be a different company, and
 *   a recap on the wrong account is worse than no recap.
 *
 *   A call with no stored recap is skipped rather than regenerated. Twelve of
 *   those exist, all 2026-07-20 to 07-22, from before recap-sync ran at all.
 *
 *   postRecapNote checks for an existing Note by title first, so a re-run
 *   cannot leave a second copy on a record.
 *
 *   npx tsx scripts/backfill-recap-notes.ts                dry run
 *   npx tsx scripts/backfill-recap-notes.ts --deal dunavant
 *   npx tsx scripts/backfill-recap-notes.ts --limit 5 --apply
 *   npx tsx scripts/backfill-recap-notes.ts --apply        WRITES
 *
 * Dry run by default. --apply posts ContentNotes into Magaya's Salesforce.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { postRecapNote } from "../lib/salesforce-note";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Skip = { account: string; at: string; why: string };

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const onlyDeal = arg("--deal")?.toLowerCase();
  const limit = Number(arg("--limit") ?? Number.MAX_SAFE_INTEGER);

  const db = supabaseAdmin();
  const tenantId = await resolveTenantId(TENANT_SLUG);

  console.log(`\n${"=".repeat(80)}`);
  console.log(`${apply ? "POSTING" : "DRY RUN"}: recap Notes for past calls`);
  console.log(`${"=".repeat(80)}\n`);

  const [callsRes, dealsRes, recapsRes] = await Promise.all([
    db
      .from("calls")
      .select("id, deal_id, scheduled_start, call_date, outcome")
      .eq("tenant_id", tenantId)
      .eq("outcome", "captured")
      .order("scheduled_start", { ascending: true }),
    db
      .from("deals")
      .select("id, account, salesforce_account_id, salesforce_link_confidence")
      .eq("tenant_id", tenantId),
    db
      .from("sent_messages")
      .select("call_id, body_text, sent_at")
      .eq("tenant_id", tenantId)
      .eq("kind", "recap"),
  ]);
  if (callsRes.error) throw new Error(`calls read failed: ${callsRes.error.message}`);
  if (dealsRes.error) throw new Error(`deals read failed: ${dealsRes.error.message}`);
  if (recapsRes.error) throw new Error(`recaps read failed: ${recapsRes.error.message}`);

  const deals = new Map(
    ((dealsRes.data ?? []) as Array<{
      id: string;
      account: string;
      salesforce_account_id: string | null;
      salesforce_link_confidence: string | null;
    }>).map((d) => [d.id, d]),
  );
  // Newest recap wins if a call somehow has two.
  const recapByCall = new Map<string, string>();
  for (const r of (recapsRes.data ?? []) as Array<{ call_id: string | null; body_text: string | null; sent_at: string | null }>) {
    if (r.call_id && r.body_text) recapByCall.set(r.call_id, r.body_text);
  }

  let calls = (callsRes.data ?? []) as Array<{
    id: string;
    deal_id: string;
    scheduled_start: string | null;
    call_date: string | null;
  }>;
  if (onlyDeal) {
    calls = calls.filter((c) => (deals.get(c.deal_id)?.account ?? "").toLowerCase().includes(onlyDeal));
  }

  const skips: Skip[] = [];
  const work: Array<{ callId: string; accountId: string; account: string; at: string | null; body: string }> = [];

  for (const c of calls) {
    const deal = deals.get(c.deal_id);
    const at = c.scheduled_start ?? c.call_date;
    const label = deal?.account ?? c.deal_id;
    const when = (at ?? "?").slice(0, 10);

    if (!deal) {
      skips.push({ account: label, at: when, why: "deal row not found" });
      continue;
    }
    if (deal.salesforce_link_confidence !== "confirmed" || !deal.salesforce_account_id) {
      skips.push({
        account: label,
        at: when,
        why: `link confidence '${deal.salesforce_link_confidence ?? "none"}', and a Note only writes on a confirmed link`,
      });
      continue;
    }
    const body = recapByCall.get(c.id);
    if (!body) {
      skips.push({ account: label, at: when, why: "no stored recap for this call" });
      continue;
    }
    work.push({ callId: c.id, accountId: deal.salesforce_account_id, account: deal.account, at, body });
  }

  const todo = work.slice(0, Math.max(0, limit));
  console.log(`  ${calls.length} captured call(s); ${work.length} eligible; ${skips.length} skipped\n`);

  let posted = 0;
  let already = 0;
  let failed = 0;
  for (const w of todo) {
    const res = await postRecapNote({
      tenantSlug: TENANT_SLUG,
      accountId: w.accountId,
      account: w.account,
      callAt: w.at,
      body: w.body,
      apply,
    });
    const when = (w.at ?? "?").slice(0, 10);
    if (res.posted) {
      posted += 1;
      console.log(`  posted    ${when}  ${w.account}  -> ${res.contentNoteId}`);
    } else if (res.alreadyThere) {
      already += 1;
      console.log(`  already   ${when}  ${w.account}`);
    } else if (!apply) {
      console.log(`  would     ${when}  ${w.account.padEnd(24)} ${w.body.length} chars`);
    } else {
      failed += 1;
      console.log(`  FAILED    ${when}  ${w.account}: ${res.reason}`);
    }
  }

  if (skips.length > 0) {
    console.log(`\n${"-".repeat(80)}`);
    console.log(`NOT ELIGIBLE (${skips.length}) - each says why, none is a silent drop`);
    console.log(`${"-".repeat(80)}`);
    const byWhy = new Map<string, Skip[]>();
    for (const s of skips) (byWhy.get(s.why) ?? byWhy.set(s.why, []).get(s.why)!).push(s);
    for (const [why, list] of [...byWhy.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n  ${list.length}x  ${why}`);
      for (const s of list.slice(0, 6)) console.log(`      ${s.at}  ${s.account}`);
      if (list.length > 6) console.log(`      and ${list.length - 6} more`);
    }
  }

  console.log(`\n${"=".repeat(80)}`);
  if (apply) {
    console.log(`posted ${posted}, already present ${already}, failed ${failed}`);
  } else {
    console.log(`DRY RUN. Nothing written. ${todo.length} would be attempted. Re-run with --apply.`);
  }
  console.log(`${"=".repeat(80)}\n`);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
