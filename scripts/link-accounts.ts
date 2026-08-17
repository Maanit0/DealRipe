/**
 * Link deals to Salesforce accounts the way Eduardo described.
 *
 *   npx tsx scripts/link-accounts.ts                 # every unlinked deal, read only
 *   npx tsx scripts/link-accounts.ts --all           # re-check linked ones too
 *   npx tsx scripts/link-accounts.ts --rep ebencomo
 *   npx tsx scripts/link-accounts.ts --apply         # WRITES the confirmed ones
 *   npx tsx scripts/link-accounts.ts --apply --include-review
 *
 * DRY RUN BY DEFAULT.
 *
 * --apply writes only rungs that produce 'confirmed' (contact_email, activity).
 * --include-review also stores the weaker rungs, which land at confidence
 * 'review': correctly linked, and correctly refusing to write into the
 * customer's CRM until a person confirms them. That is the fail-closed
 * behaviour of salesforce_link_confidence and it is deliberate.
 *
 * Imports matchAccountForMeeting rather than restating the ladder. A checker
 * that can disagree with the code it checks will.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  describeMatch,
  matchAccountForMeeting,
  type AccountMatchResult,
} from "../lib/salesforce-account-match";
import { escalateUnlinkedDeals, type UnlinkedDeal } from "../lib/link-escalation";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(name);
}

type Deal = {
  id: string;
  account: string;
  external_id: string | null;
  rep_email: string | null;
  salesforce_account_id: string | null;
  salesforce_link_confidence: string | null;
};

async function main(): Promise<void> {
  const apply = flag("--apply");
  const includeReview = flag("--include-review");
  const all = flag("--all");
  const rep = (arg("--rep") ?? "").toLowerCase();
  const days = Number(arg("--days") ?? 45);

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rep_email, salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(`deals read failed: ${dealsRes.error.message}`);
  let deals = (dealsRes.data ?? []) as Deal[];

  if (!all) deals = deals.filter((d) => !d.salesforce_account_id);
  if (rep) deals = deals.filter((d) => (d.rep_email ?? "").toLowerCase().includes(rep));

  console.log(
    `\n${apply ? "APPLY" : "DRY RUN"}  matching ${deals.length} deal(s) to Salesforce accounts` +
      `${apply && includeReview ? ", storing review-grade links too" : ""}\n`,
  );
  if (deals.length === 0) {
    console.log("Nothing to do.\n");
    return;
  }

  // The attendees and the date come from the deal's calls. Both past and
  // future: the ten deals Eduardo could not get linked all have their history
  // behind them, and an upcoming-only sweep is exactly why they stayed
  // unlinked.
  const callsRes = await db
    .from("calls")
    .select("deal_id, participants, scheduled_start, call_date, title")
    .eq("tenant_id", tenantId)
    .in("deal_id", deals.map((d) => d.id))
    .gte("scheduled_start", new Date(Date.now() - days * 86_400_000).toISOString())
    .order("scheduled_start", { ascending: false });
  if (callsRes.error) throw new Error(`calls read failed: ${callsRes.error.message}`);

  const callsByDeal = new Map<string, Array<(typeof callsRes.data)[number]>>();
  for (const c of callsRes.data ?? []) {
    if (!c.deal_id) continue;
    callsByDeal.set(c.deal_id, [...(callsByDeal.get(c.deal_id) ?? []), c]);
  }

  const tally: Record<string, number> = {};
  const unresolved: UnlinkedDeal[] = [];
  let written = 0;

  for (const d of deals) {
    const calls = callsByDeal.get(d.id) ?? [];
    if (calls.length === 0) {
      tally["no calls in window"] = (tally["no calls in window"] ?? 0) + 1;
      console.log(`  ${d.account.padEnd(26)} SKIP   no calls in the last ${days} days to match on`);
      continue;
    }

    // Try each call, newest first, and stop at the first confident answer. A
    // deal with five calls has five chances to find the BDR's activity, and the
    // activity rung is date-specific so one call per deal would throw four away.
    let best: AccountMatchResult | null = null;
    for (const c of calls) {
      const emails = Array.isArray(c.participants)
        ? (c.participants as Array<{ email?: string | null }>)
            .map((p) => (p?.email ?? "").trim())
            .filter(Boolean)
        : [];
      const date = (c.scheduled_start ?? c.call_date ?? "").slice(0, 10) || null;
      const r = await matchAccountForMeeting({
        attendeeEmails: emails,
        meetingDate: date,
        accountName: d.account,
      });
      if (r.status === "matched" && r.match.confidence === "confirmed") {
        best = r;
        break;
      }
      // Keep the best weaker answer, but keep looking for a confirmed one.
      if (!best || best.status !== "matched") best = r;
    }

    const r = best!;
    const label =
      r.status === "matched" ? `${r.match.rung}/${r.match.confidence}` : r.status;
    tally[label] = (tally[label] ?? 0) + 1;
    console.log(`  ${d.account.padEnd(26)} ${label.padEnd(24)} ${describeMatch(r)}`);

    // Anything a person has to settle: ambiguous, nothing found, a failed
    // lookup, or a review-grade match that will not write.
    if (r.status !== "matched" || r.match.confidence !== "confirmed") {
      const newest = calls[0];
      unresolved.push({
        dealId: d.id,
        account: d.account,
        repEmail: d.rep_email,
        meetingTitle: newest?.title ?? null,
        meetingDate: (newest?.scheduled_start ?? newest?.call_date ?? "").slice(0, 10) || null,
        result: r,
      });
    }

    if (!apply || r.status !== "matched") continue;
    if (r.match.confidence !== "confirmed" && !includeReview) continue;

    // Always set the confidence alongside the id. Setting the id alone produces
    // a deal that is correctly linked and refuses every write, silently.
    const upd = await db
      .from("deals")
      .update({
        salesforce_account_id: r.match.accountId,
        salesforce_link_confidence: r.match.confidence,
      })
      .eq("id", d.id);
    if (upd.error) {
      console.log(`      WRITE FAILED: ${upd.error.message}`);
      continue;
    }
    written += 1;
  }

  console.log(`\n${"-".repeat(70)}`);
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(26)} ${v}`);
  }
  if (apply) console.log(`\n  links written              ${written}`);
  else console.log(`\n  Dry run. Re-run with --apply to store the confirmed links.`);

  // Eduardo's last rung: if we cannot resolve it, ask the rep, once.
  if (flag("--escalate") && unresolved.length > 0) {
    const repCount = new Set(
      unresolved.map((u) => (u.repEmail ?? "").trim().toLowerCase()).filter(Boolean),
    ).size;
    // Deals and reps are different numbers once the mail is batched per rep.
    // Printing the deal count as "rep(s)" said 3 reps for one email.
    console.log(
      `\n  ${apply ? "EMAILING" : "WOULD EMAIL"} ${repCount} rep(s) about ${unresolved.length} unresolved deal(s)\n`,
    );
    const counts = await escalateUnlinkedDeals({
      tenantId,
      deals: unresolved,
      dryRun: !apply,
      onDecision: (dec) => {
        const label = dec.kind === "sent" ? "email" : dec.kind === "failed" ? "FAILED" : "skip ";
        console.log(
          `    ${label}  ${dec.account.padEnd(24)} ${dec.kind === "sent" ? dec.to : dec.reason}`,
        );
      },
    });
    console.log(
      `\n    sent ${counts.sent}, on cooldown ${counts.onCooldown}, no rep ${counts.noRep}, failed ${counts.failed}`,
    );
  } else if (unresolved.length > 0) {
    console.log(`\n  ${unresolved.length} deal(s) need a person. Add --escalate to ask each rep by email.`);
  }

  const stuck = Object.entries(tally)
    .filter(([k]) => k === "none" || k === "ambiguous" || k === "unavailable")
    .reduce((n, [, v]) => n + v, 0);
  if (stuck > 0) {
    console.log(
      `\n  ${stuck} deal(s) could not be resolved. Eduardo's fallback is to email the account\n` +
        `  owner naming which step failed, rather than guessing. 'unavailable' means a query\n` +
        `  failed and must be retried, not that the account is absent.`,
    );
  }
  console.log("");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
