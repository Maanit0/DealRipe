/**
 * Pre-flight readiness for upcoming calls: one table answering "is everything
 * set" per scheduled meeting. For each upcoming call it checks the four things
 * DealRipe needs to handle it end to end:
 *   Bot       - is a Recall bot scheduled to auto-join? (recall_bot_id set)
 *   Rep       - which rep gets the briefing + recap (mapped, or the deal's rep_email)
 *   Briefing  - will the pre-call briefing generate? (framework present, not already sent)
 *   Rolldog   - will the write-back land, or is the deal not linked (N/A, expected
 *               for a not-yet-qualified prospect)
 *
 * Read-only. Prints warnings for anything that would stop DealRipe acting.
 *
 *   npx tsx scripts/preflight-calls.ts            # next 48 hours
 *   npx tsx scripts/preflight-calls.ts --hours 24
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { repEmailForDeal, rolldogOppIdForDeal } from "../lib/pilot-config";
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
    ? await db.from("deals").select("id, account, external_id, framework_id, rep_email, rolldog_opportunity_id, rolldog_link_confidence").in("id", dealIds)
    : { data: [] as unknown[] };
  const dealById = new Map(
    ((dealsRes.data ?? []) as Array<Record<string, unknown>>).map((d) => [String(d.id), d] as const),
  );

  console.log(`\nPre-flight for the next ${hours}h (${calls.length} calls)\n`);
  console.log(pad("When", 16), pad("Deal", 20), pad("Rep", 24), pad("Bot", 14), pad("Briefing", 16), pad("Rolldog write", 22));
  console.log("-".repeat(112));

  const warnings: string[] = [];
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

    const opp = (ext ? rolldogOppIdForDeal(ext) : null) ?? (d?.rolldog_opportunity_id as string | null);
    const conf = d?.rolldog_link_confidence as string | null;
    const linked = !!opp && (!!(ext && rolldogOppIdForDeal(ext)) || ["confirmed", "high"].includes(conf ?? ""));
    const rolldog = linked ? `writes -> opp ${opp}` : "N/A (not linked)";

    console.log(pad(fmt(c.scheduled_start), 16), pad(account, 20), pad(rep, 24), pad(bot, 14), pad(briefing, 16), pad(rolldog, 22));
  }

  if (warnings.length > 0) {
    console.log(`\nWarnings:`);
    for (const w of warnings) console.log(`  - ${w}`);
  } else {
    console.log(`\nAll set: every call has a bot scheduled and a rep to notify.`);
  }
  console.log(`\nNote: "Rolldog N/A" is expected for a not-yet-qualified prospect not in Rolldog.`);
  console.log(`Also confirm your Recall credit balance covers these bots (a low balance is what lost the IFF call).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
