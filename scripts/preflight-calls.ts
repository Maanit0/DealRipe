/**
 * Pre-flight readiness for upcoming calls: one table answering "is everything
 * set" per scheduled meeting. For each upcoming call it checks the four things
 * DealRipe needs to handle it end to end:
 *   Bot       - is a Recall bot scheduled to auto-join? (recall_bot_id set)
 *   Rep       - which rep gets the briefing + recap (mapped, or the deal's rep_email)
 *   Briefing  - will the pre-call briefing generate? (framework present, not already sent)
 *   Writes to - where the qualification lands: a Rolldog opportunity, a Salesforce
 *               account, or nowhere
 *
 * Two things this got wrong until 2026-08-11, both worth not repeating.
 *
 * It only ever looked at Rolldog, and printed "N/A (not linked)" for everything
 * else. Salesforce write-back went live the same day, so a deal with a linked
 * Salesforce account and no Rolldog opportunity was reported as writing nowhere
 * when it writes fine. Reading that table would send you chasing links that
 * already exist.
 *
 * And it decided authorization by restating the confirmed/high rule inline
 * rather than asking the code that enforces it. A checker that can disagree with
 * production will, and it will be confident. It now calls resolveWriteTarget and
 * resolveSalesforceWriteTarget, which are the same functions the writers use.
 *
 * Read-only. Prints warnings for anything that would stop DealRipe acting.
 *
 *   npx tsx scripts/preflight-calls.ts            # next 48 hours
 *   npx tsx scripts/preflight-calls.ts --hours 24
 *   npx tsx scripts/preflight-calls.ts --why      # why each unwritable deal is unwritable
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { repEmailForDeal } from "../lib/pilot-config";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { resolveSalesforceWriteTarget } from "../lib/salesforce-scope";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TZ = "America/Chicago";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function pad(s: string, n: number): string {
  return (s.length > n ? s.slice(0, n - 1) + "…" : s).padEnd(n);
}
function fmt(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: TZ });
  } catch {
    return "—";
  }
}

async function main(): Promise<void> {
  const hours = Number(arg("--hours") ?? "48");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const now = new Date();
  const until = new Date(now.getTime() + hours * 3600000);

  const callsRes = await db
    .from("calls")
    .select("id, deal_id, title, scheduled_start, recall_bot_id, briefing_sent_at, outcome")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", now.toISOString())
    .lte("scheduled_start", until.toISOString())
    .order("scheduled_start", { ascending: true });
  const calls = (callsRes.data ?? []) as Array<{
    id: string;
    deal_id: string | null;
    title: string | null;
    scheduled_start: string | null;
    recall_bot_id: string | null;
    briefing_sent_at: string | null;
    outcome: string | null;
  }>;

  if (calls.length === 0) {
    console.log(`\nNo calls scheduled in the next ${hours} hours.`);
    return;
  }

  const dealIds = Array.from(new Set(calls.map((c) => c.deal_id).filter(Boolean))) as string[];
  const dealsRes = dealIds.length
    ? await db
        .from("deals")
        .select(
          "id, account, external_id, framework_id, rep_email, rolldog_opportunity_id, rolldog_link_confidence, salesforce_account_id, salesforce_link_confidence",
        )
        .in("id", dealIds)
    : { data: [] as unknown[] };
  const dealById = new Map(
    ((dealsRes.data ?? []) as Array<Record<string, unknown>>).map((d) => [String(d.id), d] as const),
  );

  console.log(`\nPre-flight for the next ${hours}h (${calls.length} calls)\n`);
  console.log(pad("When", 16), pad("Deal", 20), pad("Rep", 24), pad("Bot", 14), pad("Briefing", 16), pad("Writes to", 30));
  console.log("-".repeat(122));

  const warnings: string[] = [];
  const unwritable: Array<{ account: string; rolldog: string; salesforce: string }> = [];
  let writesSomewhere = 0;
  for (const c of calls) {
    const d = c.deal_id ? dealById.get(c.deal_id) : undefined;
    const account = (d?.account as string) ?? c.title ?? "unmatched";
    const ext = (d?.external_id as string) ?? "";
    const rep = repEmailForDeal(ext) ?? (d?.rep_email as string) ?? "—";

    const bot = c.recall_bot_id ? "scheduled" : "NOT scheduled";
    if (!c.recall_bot_id) warnings.push(`${account}: no Recall bot scheduled (it will not auto-join).`);

    let briefing: string;
    if (!d) briefing = "no deal";
    else if (!d.framework_id) briefing = "no framework";
    else if (c.briefing_sent_at) briefing = "already sent";
    else briefing = "ready";
    if (d && !d.framework_id) warnings.push(`${account}: no framework, briefing will not generate.`);

    // Ask the code that actually enforces this, for both systems. Rolldog is
    // the system of record where an opportunity exists, so it is reported first
    // and Salesforce only when Rolldog cannot take the write, which mirrors the
    // precedence in salesforce-writeback-run.
    const dealForResolve = (d ?? {}) as {
      external_id?: string | null;
      rolldog_opportunity_id?: string | null;
      rolldog_link_confidence?: string | null;
      salesforce_account_id?: string | null;
      salesforce_link_confidence?: string | null;
    };
    const rd = resolveWriteTarget(dealForResolve);
    const sf = resolveSalesforceWriteTarget(dealForResolve);

    let target: string;
    if (rd.authorized) {
      target = `Rolldog opp ${rd.opportunityId}`;
      writesSomewhere += 1;
    } else if (sf.authorized) {
      target = `Salesforce ${sf.accountId}`;
      writesSomewhere += 1;
    } else {
      target = "NOWHERE";
      unwritable.push({ account, rolldog: rd.reason, salesforce: sf.reason });
    }

    console.log(pad(fmt(c.scheduled_start), 16), pad(account, 20), pad(rep, 24), pad(bot, 14), pad(briefing, 16), pad(target, 30));
  }

  if (warnings.length > 0) {
    console.log(`\nWarnings:`);
    for (const w of warnings) console.log(`  - ${w}`);
  } else {
    console.log(`\nEvery call has a bot scheduled and a rep to notify.`);
  }

  console.log(
    `\n${writesSomewhere} of ${calls.length} call(s) have somewhere to write. ${unwritable.length} do not.`,
  );
  if (unwritable.length > 0) {
    console.log(`\nThese will capture, extract, recap and draft. The qualification then stops`);
    console.log(`inside DealRipe and reaches neither CRM:\n`);
    const why = process.argv.includes("--why");
    for (const u of unwritable) {
      console.log(`  ${u.account}`);
      if (why) {
        console.log(`      rolldog:    ${u.rolldog}`);
        console.log(`      salesforce: ${u.salesforce}`);
      }
    }
    if (!why) console.log(`\n  Run with --why to see the reason each one fails, per system.`);
    console.log(`\nThree different situations hide behind "nowhere", and they need different fixes:`);
    console.log(`  a Rolldog opportunity exists but was not matched   -> rolldog-opp-detail.ts, then link-deal.ts --apply`);
    console.log(`  no opportunity, but a Salesforce account exists    -> sync-salesforce-links.ts --apply`);
    console.log(`  neither exists, a genuinely new prospect           -> only the rep knows; ask them`);
    console.log(`Do not guess between them. Linking a deal to the wrong record writes a`);
    console.log(`customer's qualification onto another customer's account.`);
  }
  console.log(`\nAlso confirm your Recall credit balance covers these bots (a low balance is what lost the IFF call).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
