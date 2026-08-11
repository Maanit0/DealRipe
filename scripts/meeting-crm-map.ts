/**
 * One row per upcoming meeting: is Rolldog connected, is Salesforce, will the
 * write land?
 *
 * The Meetings screen shows what DealRipe will join. It does not show whether
 * anything will come back out the other side, and those are different
 * questions: a call can be recorded, recapped and drafted perfectly and still
 * write nothing to Rolldog, because the deal has no opportunity to write to.
 *
 * WRITE is answered by resolveWriteTarget, the same function rolldog-writeback
 * calls. Not a copy of its rules, the function itself. A checker that
 * reimplements the logic it checks will drift, and when it drifts it reports
 * healthy deals as broken, which is exactly what happened here on 2026-08-10.
 *
 *   npx tsx scripts/meeting-crm-map.ts
 *   npx tsx scripts/meeting-crm-map.ts --days 3
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { isFreeMailDomain } from "../lib/pilot-config";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { getAccountContextByDomain } from "../lib/salesforce-context";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function pad(s: string, n: number): string {
  return (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 7);
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const horizon = new Date(Date.now() + days * 86_400_000).toISOString();
  const calls = await db
    .from("calls")
    .select("id, deal_id, scheduled_start, title, recall_bot_id")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", new Date().toISOString())
    .lte("scheduled_start", horizon)
    .order("scheduled_start", { ascending: true });
  if (calls.error) throw new Error(calls.error.message);
  if (!calls.data?.length) {
    console.log(`\nNo calls scheduled in the next ${days} days.\n`);
    return;
  }

  const dealIds = [...new Set(calls.data.map((c) => c.deal_id).filter(Boolean))] as string[];
  const deals = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence, rep_email")
    .in("id", dealIds);
  if (deals.error) throw new Error(deals.error.message);
  const byId = new Map((deals.data ?? []).map((d) => [d.id, d]));

  // Salesforce is looked up once per domain, not once per meeting: EWI and ILS
  // each appear twice this week and the account does not change between them.
  const sfCache = new Map<string, string | null>();
  async function salesforceFor(externalId: string | null): Promise<string> {
    const tail = (externalId ?? "").replace(/^auto:/, "");
    const domain = tail.includes("@") ? (tail.split("@")[1] ?? "") : tail;
    if (!domain) return "-";
    if (isFreeMailDomain(domain)) return "n/a (consumer mail)";
    if (sfCache.has(domain)) return sfCache.get(domain) ?? "none";
    try {
      const sf = await getAccountContextByDomain(domain, []);
      const name = sf?.accountName ?? null;
      sfCache.set(domain, name);
      return name ?? "none";
    } catch (e) {
      // Never render a failed lookup as an absent account. They mean opposite
      // things and collapsing them is the bug that started all of this.
      return `LOOKUP FAILED (${e instanceof Error ? e.message.slice(0, 30) : "error"})`;
    }
  }

  console.log("");
  console.log(
    `${pad("WHEN", 18)}${pad("DEAL", 22)}${pad("REP", 11)}${pad("BOT", 6)}${pad("ROLLDOG", 24)}${pad("SALESFORCE", 26)}WRITE-BACK`,
  );
  console.log("-".repeat(130));

  let willWrite = 0;
  let willNot = 0;
  const problems: string[] = [];

  for (const c of calls.data) {
    const d = c.deal_id ? byId.get(c.deal_id) : undefined;
    if (!d) continue;

    const target = resolveWriteTarget(d);
    const sf = await salesforceFor(d.external_id);

    const rolldog = target.authorized
      ? `${target.opportunityId} (${target.route})`
      : target.opportunityId
        ? `${target.opportunityId} unconfirmed`
        : "none";

    const write = target.authorized ? "YES" : `NO: ${target.reason}`;
    if (target.authorized) willWrite += 1;
    else {
      willNot += 1;
      problems.push(
        `${formatMeetingTime(c.scheduled_start)}  ${d.account}: ${target.reason}`,
      );
    }

    console.log(
      `${pad(formatMeetingTime(c.scheduled_start), 18)}${pad(d.account ?? "-", 22)}${pad((d.rep_email ?? "").split("@")[0] || "-", 11)}${pad(c.recall_bot_id ? "yes" : "NO", 6)}${pad(rolldog, 24)}${pad(sf, 26)}${write}`,
    );
  }

  console.log("");
  console.log(`${willWrite} meetings will write back to Rolldog. ${willNot} will not.`);

  if (problems.length > 0) {
    console.log("");
    console.log("These calls will produce a briefing, a recap and a draft, and");
    console.log("leave Rolldog untouched:");
    console.log("");
    for (const p of problems) console.log(`  ${p}`);
    console.log("");
    console.log("'no Rolldog opportunity' is not something DealRipe can fix. The");
    console.log("opportunity has to exist before a call can be written to it, so");
    console.log("that one belongs to the rep. An unconfirmed link is ours:");
    console.log("  npx tsx scripts/link-deal.ts --deal <account> --opp <id> --apply");
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
