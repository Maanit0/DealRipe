/**
 * Which linked opportunities can DealRipe write to, and which are still locked?
 *
 * PILOT_OPPORTUNITY_IDS is the fail-closed allowlist that decides whether
 * write-back may touch a customer's CRM record. It is hand-maintained, and on
 * 2026-08-10 that caught up with us: three reps were onboarded, thirteen deals
 * were linked to real Rolldog opportunities, and write-back silently no-opped
 * on every one of them because nobody had added the ids. Nothing errored. The
 * reps would simply have found an empty Rolldog after a week of calls.
 *
 * A pilot that runs to year-end will link new opportunities every week, so the
 * failure repeats unless someone remembers. This makes remembering unnecessary:
 * it diffs every confirmed link against the allowlist and prints a paste-ready
 * block for whatever is missing.
 *
 * It deliberately does NOT edit the allowlist itself. That file is the security
 * boundary for writing into someone else's CRM, and it stays under human review
 * in code, not something a nightly job can widen on its own. The cost of that
 * choice is one command a week. The cost of the alternative is a script that
 * can grant itself write access to any record it happens to match.
 *
 *   npx tsx scripts/sync-writeback-allowlist.ts
 *   npx tsx scripts/sync-writeback-allowlist.ts --days 30
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { PILOT_OPPORTUNITY_IDS } from "../lib/crm-scope";
import { formatMeetingTime } from "../lib/graph-time";
import { rolldogOppIdForDeal } from "../lib/pilot-config";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 14);
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const allowed = new Set(PILOT_OPPORTUNITY_IDS.map(String));

  const deals = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rep_email")
    .eq("tenant_id", tenantId);
  if (deals.error) throw new Error(deals.error.message);

  // Upcoming calls per deal, so the output is ordered by urgency rather than by
  // account name. A deal with a call on Tuesday matters more than one with none.
  const horizon = new Date(Date.now() + days * 86_400_000).toISOString();
  const calls = await db
    .from("calls")
    .select("deal_id, scheduled_start, title")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", new Date().toISOString())
    .lte("scheduled_start", horizon)
    .order("scheduled_start", { ascending: true });
  if (calls.error) throw new Error(calls.error.message);

  const nextCall = new Map<string, { when: string; title: string }>();
  for (const c of calls.data ?? []) {
    if (!c.deal_id || nextCall.has(c.deal_id)) continue;
    nextCall.set(c.deal_id, { when: c.scheduled_start ?? "", title: c.title ?? "" });
  }

  type Row = {
    opp: string;
    account: string;
    rep: string;
    when: string | null;
    title: string;
  };
  const missing: Row[] = [];
  const covered: Row[] = [];

  for (const d of deals.data ?? []) {
    const opp =
      d.rolldog_opportunity_id ??
      (d.external_id ? rolldogOppIdForDeal(d.external_id) : null) ??
      null;
    if (!opp) continue;
    const up = nextCall.get(d.id);
    const row: Row = {
      opp: String(opp),
      account: d.account ?? "(no name)",
      rep: (d.rep_email ?? "").split("@")[0] || "-",
      when: up?.when ?? null,
      title: up?.title ?? "",
    };
    (allowed.has(String(opp)) ? covered : missing).push(row);
  }

  // Soonest call first; deals with no upcoming call last.
  const byUrgency = (a: Row, b: Row): number => {
    if (a.when && b.when) return a.when.localeCompare(b.when);
    if (a.when) return -1;
    if (b.when) return 1;
    return a.account.localeCompare(b.account);
  };
  missing.sort(byUrgency);
  covered.sort(byUrgency);

  console.log("");
  console.log(`${covered.length} linked opportunities can be written to.`);
  console.log(`${missing.length} are linked but BLOCKED by the allowlist.`);

  if (missing.length > 0) {
    console.log("");
    console.log("BLOCKED. Write-back will silently no-op on these:");
    console.log("");
    for (const r of missing) {
      const when = r.when ? formatMeetingTime(r.when) : "no call scheduled";
      console.log(
        `  ${r.opp.padEnd(8)} ${r.account.slice(0, 26).padEnd(28)} ${r.rep.padEnd(11)} ${when}`,
      );
    }
    console.log("");
    console.log("Paste into PILOT_OPPORTUNITY_IDS in lib/crm-scope.ts, after");
    console.log("confirming each account is the customer you expect:");
    console.log("");
    for (const r of missing) {
      console.log(`  "${r.opp}", // ${r.account}${r.rep !== "-" ? ` (${r.rep})` : ""}`);
    }
  }

  const upcomingBlocked = missing.filter((r) => r.when).length;
  console.log("");
  if (upcomingBlocked > 0) {
    console.log(
      `${upcomingBlocked} of the blocked deals have a call in the next ${days} days.`,
    );
    console.log("Those calls will produce a recap and a draft but write nothing to Rolldog.");
  } else if (missing.length === 0) {
    console.log("Every linked opportunity is writable. Nothing to do.");
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
