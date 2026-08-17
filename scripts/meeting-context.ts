/**
 * What DealRipe thinks a meeting is, and why.
 *
 *   npx tsx scripts/meeting-context.ts --upcoming
 *   npx tsx scripts/meeting-context.ts --deal "Cargo Services"
 *   npx tsx scripts/meeting-context.ts --backtest
 *
 * --upcoming   every meeting in the next 48h: resolved type, confidence, and
 *              whether each action would fire
 * --deal       one deal, with every input that contributed
 * --backtest   replay every captured call as it would have been resolved
 *              BEFORE it happened, against what the transcript later showed.
 *              The honest measure of whether this layer works.
 *
 * READ ONLY.
 *
 * Imports resolveMeetingContext itself rather than restating its rules. A
 * checker that can disagree with the code it checks will, and it will do so
 * confidently.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import {
  allowsDiscovery,
  describeContext,
  resolveMeetingContext,
  shouldBrief,
  shouldDraftFollowUp,
} from "../lib/meeting-context";
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

async function main(): Promise<void> {
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  if (flag("--backtest")) return backtest(tenantId);

  const dealArg = arg("--deal");
  if (dealArg) {
    const deals = await db
      .from("deals")
      .select("id, account")
      .eq("tenant_id", tenantId)
      .ilike("account", `%${dealArg}%`)
      .limit(5);
    if (deals.error) throw new Error(deals.error.message);
    if (!deals.data?.length) {
      console.log(`No deal matching "${dealArg}".`);
      return;
    }
    for (const d of deals.data) {
      const calls = await db
        .from("calls")
        .select("id, title, scheduled_start, participants")
        .eq("deal_id", d.id)
        .order("scheduled_start", { ascending: false })
        .limit(1);
      const c = calls.data?.[0];
      const ctx = await resolveMeetingContext({
        tenantId,
        dealId: d.id,
        callId: c?.id ?? null,
        subject: c?.title ?? null,
        participants: c?.participants,
        beforeIso: c?.scheduled_start ?? null,
      });
      console.log(`\n${"=".repeat(74)}`);
      console.log(describeContext(ctx));
      console.log(`${"=".repeat(74)}`);
      console.log(`  standing     ${ctx.standing.status}: ${ctx.standing.detail}`);
      console.log(`  opportunity  ${ctx.opportunity.status}: ${ctx.opportunity.detail}`);
      console.log(`  parties      ${ctx.parties.customerEmails.length} customer, ${ctx.parties.internalEmails.length} internal`);
      console.log(`  discovery framing allowed: ${allowsDiscovery(ctx)}`);
      console.log(`  brief?       ${JSON.stringify(shouldBrief(ctx))}`);
      console.log(`  draft?       ${JSON.stringify(shouldDraftFollowUp(ctx))}`);
      console.log(`  inputs:`);
      for (const p of ctx.provenance) console.log(`    ${p}`);
    }
    return;
  }

  // Default and --upcoming: the next 48 hours.
  const now = new Date().toISOString();
  const until = new Date(Date.now() + 48 * 3_600_000).toISOString();
  const calls = await db
    .from("calls")
    .select("id, deal_id, title, scheduled_start, participants")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", now)
    .lte("scheduled_start", until)
    .order("scheduled_start", { ascending: true });
  if (calls.error) throw new Error(calls.error.message);
  if (!calls.data?.length) {
    console.log("No meetings in the next 48 hours.");
    return;
  }
  console.log(`\nNEXT 48 HOURS\n`);
  for (const c of calls.data) {
    if (!c.deal_id) continue;
    const ctx = await resolveMeetingContext({
      tenantId,
      dealId: c.deal_id,
      callId: c.id,
      subject: c.title,
      participants: c.participants,
      beforeIso: c.scheduled_start,
    });
    const b = shouldBrief(ctx);
    console.log(
      `  ${(c.scheduled_start ?? "").slice(0, 16).replace("T", " ")}  ` +
        `${ctx.account.padEnd(22)} ${ctx.meeting.type.padEnd(18)} ${ctx.confidence.padEnd(12)} ` +
        `${b.act ? "brief" : "SKIP"}`,
    );
    console.log(`      ${ctx.meeting.reason}`);
  }
}

/**
 * Replay history. For every call the transcript later classified, resolve the
 * context as it stood BEFORE that call and compare.
 *
 * The comparison that matters is not the exact label but whether we would have
 * allowed a first-discovery framing, because that is the error the prescription
 * ledger measured: 0% follow-through on calls where discovery questions were
 * issued to a customer who had already bought.
 */
async function backtest(tenantId: string): Promise<void> {
  const db = supabaseAdmin();
  const calls = await db
    .from("calls")
    .select("id, deal_id, title, scheduled_start, participants, meeting_type, call_subtype")
    .eq("tenant_id", tenantId)
    .not("call_subtype", "is", null)
    .order("scheduled_start", { ascending: true })
    .limit(300);
  if (calls.error) throw new Error(calls.error.message);

  let right = 0;
  let wrong = 0;
  let unknown = 0;
  const misses: string[] = [];

  for (const c of calls.data ?? []) {
    if (!c.deal_id || c.call_subtype === "internal") continue;
    const actual = c.meeting_type === "existing_customer" ? "existing_customer" : c.call_subtype;
    const ctx = await resolveMeetingContext({
      tenantId,
      dealId: c.deal_id,
      callId: c.id,
      subject: c.title,
      participants: c.participants,
      beforeIso: c.scheduled_start,
    });
    if (ctx.meeting.type === "unknown") {
      unknown += 1;
      continue;
    }
    const predictedEarly = allowsDiscovery(ctx);
    const actuallyEarly = actual === "discovery";
    if (predictedEarly === actuallyEarly) right += 1;
    else {
      wrong += 1;
      misses.push(
        `    predicted ${ctx.meeting.type.padEnd(18)} actual ${String(actual).padEnd(18)} "${(c.title ?? "").slice(0, 40)}"\n      ${ctx.meeting.reason}`,
      );
    }
  }

  console.log(`\nBACKTEST: would we have allowed a discovery framing?\n`);
  console.log(`  correct   ${right}`);
  console.log(`  wrong     ${wrong}`);
  console.log(`  unknown   ${unknown}  (nothing resolved it; the prompt falls back to its own guidance)`);
  if (misses.length) {
    console.log(`\n  wrong:`);
    for (const m of misses.slice(0, 10)) console.log(m);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
