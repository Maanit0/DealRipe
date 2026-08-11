/**
 * Which deals can write back to Rolldog, and which cannot?
 *
 * The first version of this script got the authorization model wrong and
 * reported four healthy deals as BLOCKED, including Ztransportation, which had
 * written Situation and Timeline to Rolldog that same afternoon. Worth stating
 * plainly, because a diagnostic that invents problems is worse than none.
 *
 * There are TWO ways a write is authorized, not one:
 *
 *   1. Hand-seeded pilot deals, via the static PILOT_OPPORTUNITY_IDS allowlist.
 *   2. Auto-linked deals, via the confirmed/high match stored on the deal row,
 *      authorized for the duration of one write by runWithAuthorizedOpportunities.
 *
 * Route 2 is how most deals write, and it needs no allowlist entry at all. So
 * the real risk is not "linked but not allowlisted". It is a deal that HAS an
 * opportunity whose link confidence is 'review' or null, because that fails
 * closed silently and no amount of allowlisting fixes it: the link itself has
 * to be confirmed.
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
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence, rep_email")
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
    /** Link confidence, which is what actually decides most of these. */
    why: string;
  };
  const blocked: Row[] = [];
  const writable: Row[] = [];

  for (const d of deals.data ?? []) {
    const staticOpp = d.external_id ? rolldogOppIdForDeal(d.external_id) : null;
    const opp = staticOpp ?? d.rolldog_opportunity_id ?? null;
    if (!opp) continue;
    const conf = d.rolldog_link_confidence;
    const up = nextCall.get(d.id);
    const row: Row = {
      opp: String(opp),
      account: d.account ?? "(no name)",
      rep: (d.rep_email ?? "").split("@")[0] || "-",
      when: up?.when ?? null,
      title: up?.title ?? "",
      why: conf ?? "none",
    };
    // Mirror rolldog-writeback exactly. Any other rule here and this script
    // starts disagreeing with the code it is supposed to be checking.
    const authorized =
      Boolean(staticOpp) ||
      allowed.has(String(opp)) ||
      conf === "confirmed" ||
      conf === "high";
    (authorized ? writable : blocked).push(row);
  }

  // Soonest call first; deals with no upcoming call last.
  const byUrgency = (a: Row, b: Row): number => {
    if (a.when && b.when) return a.when.localeCompare(b.when);
    if (a.when) return -1;
    if (b.when) return 1;
    return a.account.localeCompare(b.account);
  };
  blocked.sort(byUrgency);
  writable.sort(byUrgency);

  console.log("");
  console.log(`${writable.length} deals with an opportunity CAN write back.`);
  console.log(`${blocked.length} have an opportunity but CANNOT.`);

  if (blocked.length > 0) {
    console.log("");
    console.log("CANNOT WRITE. Each of these has an opportunity on the deal but a");
    console.log("link confidence that fails closed, so the recap and draft go out");
    console.log("and Rolldog stays untouched:");
    console.log("");
    for (const r of blocked) {
      const when = r.when ? formatMeetingTime(r.when) : "no call scheduled";
      console.log(
        `  ${r.opp.padEnd(8)} ${r.account.slice(0, 24).padEnd(26)} ${r.rep.padEnd(11)} link=${r.why.padEnd(10)} ${when}`,
      );
    }
    console.log("");
    console.log("The fix is to confirm the LINK, not to allowlist the id:");
    console.log("  npx tsx scripts/link-deal.ts --deal <account> --opp <id> --apply");
    console.log("");
    console.log("Allowlisting an id whose link is unconfirmed would authorize a");
    console.log("write to an opportunity nobody has verified belongs to this deal.");
  }

  const upcomingBlocked = blocked.filter((r) => r.when).length;
  console.log("");
  if (upcomingBlocked > 0) {
    console.log(`${upcomingBlocked} of them have a call within ${days} days.`);
  } else if (blocked.length === 0) {
    console.log("Every deal with an opportunity can write back. Nothing to do.");
  } else {
    console.log("None of them have a call scheduled, so nothing is at risk this week.");
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
