/**
 * Who each deal's artifacts are routed to, checked against who actually ran the
 * calls.
 *
 * deals.rep_email decides the briefing recipient, the recap recipient, the
 * mailbox the follow-up draft is written INTO, the no-show mail, link-escalation
 * and the prescription ledger's rep attribution. It is set once at auto-creation
 * from whichever calendar calendar-sync read the invite off first, and nothing
 * has ever revisited it.
 *
 * Imports lib/deal-rep.ts rather than restating the rule, because a checker that
 * can disagree with production will.
 *
 * Dry run by default. --apply WRITES rep_email.
 *
 *   npx tsx scripts/fix-deal-rep.ts
 *   npx tsx scripts/fix-deal-rep.ts --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { resolveDealRep, type DealRepVerdict } from "../lib/deal-rep";
import { supabaseAdmin } from "../lib/supabase";

const APPLY = process.argv.includes("--apply");

async function main(): Promise<void> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("deals")
    .select("id, account, external_id, rep_email, rep_notes, rolldog_opportunity_id, outcome_label")
    .is("outcome_label", null);
  if (error) throw new Error(error.message);

  const counts = new Map<DealRepVerdict["status"], number>();
  const wrong: Array<{ id: string; account: string; from: string | null; to: string; source: string; detail: string }> = [];
  const coSold: string[] = [];

  for (const d of data ?? []) {
    const v = await resolveDealRep({
      dealId: d.id as string,
      externalId: (d.external_id as string | null) ?? null,
      currentRepEmail: (d.rep_email as string | null) ?? null,
      rolldogOpportunityId: (d.rolldog_opportunity_id as string | null) ?? null,
    });
    counts.set(v.status, (counts.get(v.status) ?? 0) + 1);
    if (v.status === "disagrees") {
      wrong.push({ id: d.id as string, account: d.account as string, from: v.current, to: v.repEmail, source: v.source, detail: v.detail });
    }
    if (v.status === "co_sold") {
      coSold.push(`${String(d.account).padEnd(22)} on the deal: ${v.current ?? "(none)"}, organizing calls: ${v.reps.join(", ")}`);
    }
  }

  console.log(`\n${data?.length ?? 0} live deals\n`);
  for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${k}`);
  }

  // "no_rep_organizer" is the normal BDR-booked case and is NOT a problem. It is
  // printed as its own line rather than folded into agreement, because reporting
  // it as agreement would claim verifications that never happened.
  console.log(
    `\n  no_rep_organizer means every call was booked by a BDR or the customer, so there is nothing to check rep_email against. Normal, not a fault.`,
  );

  if (coSold.length > 0) {
    console.log(`\nCO-SOLD, a person decides (never changed automatically):`);
    for (const line of coSold) console.log(`  ${line}`);
  }

  if (wrong.length === 0) {
    console.log(`\nNo deal routes its artifacts to a rep who organizes none of its calls.\n`);
    return;
  }

  console.log(`\n${wrong.length} deals route to a rep who organizes NONE of their calls:`);
  for (const w of wrong) {
    console.log(`  ${w.account.padEnd(22)} ${String(w.from ?? "(none)").padEnd(24)} -> ${w.to.padEnd(24)} [${w.source}] ${w.detail}`);
  }

  if (!APPLY) {
    console.log(`\nDry run. Re-run with --apply to write these.\n`);
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  for (const w of wrong) {
    const { data: row } = await db.from("deals").select("rep_notes").eq("id", w.id).maybeSingle();
    const note = `${String(row?.rep_notes ?? "").trim()} Rep corrected to ${w.to} on ${stamp}: ${w.detail}. rep_email had been set from whichever calendar calendar-sync read the invite off first.`.trim();
    const { error: upErr } = await db.from("deals").update({ rep_email: w.to, rep_notes: note }).eq("id", w.id);
    if (upErr) throw new Error(`update failed for ${w.account}: ${upErr.message}`);
    console.log(`  wrote ${w.account} -> ${w.to}`);
  }
  console.log(`\n${wrong.length} deals updated.\n`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
