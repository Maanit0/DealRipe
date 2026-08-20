/**
 * One deal, call by call: what we asked for, what happened, what changed.
 *
 * WHAT THIS IS FOR
 *
 * Everything DealRipe knows about a deal is currently spread across seven
 * tables and three pages, so the question a founder and a sales leader both
 * actually ask has no answer anywhere: is this deal progressing, and did we
 * have anything to do with it.
 *
 * The unit is the CALL, and each call is a before / during / after triple:
 *
 *   BEFORE   what we told the rep to get, and whether the briefing reached them
 *   DURING   who was in the room and who stayed silent
 *   AFTER    what the calls newly proved, what the rep did, what the CRM did
 *
 * That triple is the "did DealRipe help" unit. Stacked in time it is the deal's
 * history; summed across deals it is the leader view.
 *
 * ATTRIBUTION IS DELIBERATELY NOT CLAIMED. All six pilot reps are enrolled, so
 * there is no holdout and no control arm. This shows what was prescribed and
 * what followed, in order, and lets a reader draw their own line. Anything
 * stronger would be a causal claim the pilot cannot support.
 *
 *   npx tsx scripts/deal-timeline.ts --deal Dunavant
 *   npx tsx scripts/deal-timeline.ts --rep ebencomo@magaya.com --limit 3
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { computeDealFlags } from "../lib/deal-flags";
import { assessDeal, computeBuyerSignals } from "../lib/deal-signals-buyer";
import { readEmailEngagement } from "../lib/email-log";
import {
  closeDateSlipsFor,
  HISTORY_BEGINS,
  loadCloseDateHistoryForAccounts,
  loadOpportunityCreationForAccounts,
  loadStageHistoryForAccounts,
} from "../lib/salesforce-stage-history";
import { resolveSalesforceSnapshots } from "../lib/salesforce-stage";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const d10 = (iso: string | null | undefined): string => (iso ? String(iso).slice(0, 10) : "?");

type Row = { [k: string]: unknown };

async function timelineFor(tenantId: string, deal: Row): Promise<void> {
  const db = supabaseAdmin();
  const dealId = deal.id as string;
  const account = deal.account as string;
  const accountId = (deal.salesforce_link_confidence === "confirmed"
    ? deal.salesforce_account_id
    : null) as string | null;

  // ---- everything about this deal, in as few round trips as possible -----
  const [callsRes, presRes, msgsRes, sentRes, crmByDeal] = await Promise.all([
    db.from("calls")
      .select("id, scheduled_start, call_date, meeting_type, call_subtype, outcome, briefing_sent_at, title")
      .eq("tenant_id", tenantId).eq("deal_id", dealId).order("scheduled_start", { ascending: true }),
    db.from("prescribed_actions")
      .select("call_id, kind, text, followed, outcome_next_meeting, outcome_stage_moved, outcome_qualification_advanced, outcome_reasons, issued_at")
      .eq("tenant_id", tenantId).eq("deal_id", dealId),
    db.from("deal_messages")
      .select("direction, customer_side, subject, sent_at, is_calendar_response")
      .eq("tenant_id", tenantId).eq("deal_id", dealId).order("sent_at", { ascending: true }),
    db.from("sent_messages").select("call_id, kind, sent_at").eq("tenant_id", tenantId).eq("deal_id", dealId),
    resolveSalesforceSnapshots(tenantId, [dealId]),
  ]);

  type Call = Row & { at: string };
  const calls: Call[] = ((callsRes.data ?? []) as Row[]).map((c) => ({
    ...c,
    at: String(c.scheduled_start ?? c.call_date ?? ""),
  }));
  const pres = (presRes.data ?? []) as Row[];
  // deal_messages may not exist yet; a failed read is "no log", not "no email".
  const msgs = msgsRes.error ? null : ((msgsRes.data ?? []) as Row[]);
  const sent = (sentRes.data ?? []) as Row[];

  // ---- the CRM's own record of what moved, with real timestamps ----------
  let stageMoves: Array<{ at: string; from: string | null; to: string | null }> = [];
  let dateMoves: Array<{ at: string; from: string | null; to: string | null; daysMoved: number | null }> = [];
  let slips: ReturnType<typeof closeDateSlipsFor> | undefined;
  if (accountId) {
    const since = `${HISTORY_BEGINS}T00:00:00Z`;
    const [sh, cd, opps] = await Promise.all([
      loadStageHistoryForAccounts([accountId], since),
      loadCloseDateHistoryForAccounts([accountId], since),
      loadOpportunityCreationForAccounts([accountId]),
    ]);
    if (sh.status === "read") stageMoves = (sh.byAccount.get(accountId) ?? []).map((t) => ({ at: t.at, from: t.from, to: t.to }));
    if (cd.status === "read") dateMoves = (cd.byAccount.get(accountId) ?? []).map((m) => ({ at: m.at, from: m.from, to: m.to, daysMoved: m.daysMoved }));
    if (cd.status === "read" && !("error" in opps)) {
      slips = closeDateSlipsFor({
        moves: cd.byAccount.get(accountId) ?? [],
        opportunities: opps.get(accountId) ?? [],
      });
    }
  }

  const signals = await computeBuyerSignals({ tenantId, dealId, closeDateSlips: slips });
  const assessment = assessDeal(signals);
  const crmRead = crmByDeal.get(dealId);
  const crm = crmRead?.status === "read" ? crmRead.snapshot : null;
  const flags = computeDealFlags({ signals, assessment, crm });

  // ---- header -------------------------------------------------------------
  console.log(`\n${"=".repeat(92)}`);
  const repBand = crm?.forecastCategory ?? "no band";
  console.log(
    `${account}   ${deal.rep_email ?? "?"}\n` +
      `rep says ${repBand}${crm?.closeDate ? ` closing ${crm.closeDate}` : ""}   ` +
      `DealRipe says ${assessment.band ?? "no read"}, ${assessment.momentum}` +
      `   (confidence ${assessment.confidence})`,
  );
  if (crm) console.log(`Salesforce stage: ${crm.stageName}${crm.openCount > 1 ? `   (1 of ${crm.openCount} open opportunities on this account)` : ""}`);
  console.log(`${"=".repeat(92)}`);

  // ---- the timeline -------------------------------------------------------
  const now = Date.now();
  for (const c of calls) {
    const when = d10(c.at);
    const future = Date.parse(c.at) > now;
    const kind = [c.meeting_type, c.call_subtype].filter(Boolean).join(" / ") || "untyped";
    console.log(`\n  ${when}  ${future ? "UPCOMING  " : ""}${kind}${c.outcome ? `  [${c.outcome}]` : ""}`);
    if (c.title) console.log(`    "${String(c.title).slice(0, 78)}"`);

    // BEFORE
    const forCall = pres.filter((p) => p.call_id === c.id);
    if (c.briefing_sent_at) {
      const lead = Math.round((Date.parse(c.at) - Date.parse(String(c.briefing_sent_at))) / 60000);
      console.log(`    before  briefing sent ${lead} min ahead`);
    } else if (!future) {
      console.log(`    before  no briefing recorded`);
    }
    for (const p of forCall.slice(0, 4)) {
      const mark = p.followed === "yes" ? "DONE" : p.followed === "no" ? "not done" : "unscored";
      console.log(`            asked: ${String(p.text).slice(0, 66)}  [${mark}]`);
    }
    if (forCall.length > 4) console.log(`            and ${forCall.length - 4} more`);

    if (future) continue;

    // AFTER: artifacts, then what the ledger recorded
    const arts = sent.filter((m) => m.call_id === c.id).map((m) => String(m.kind));
    if (arts.length > 0) console.log(`    after   delivered: ${[...new Set(arts)].join(", ")}`);
    const any = forCall[0];
    if (any) {
      const bits: string[] = [];
      if (any.outcome_next_meeting === "yes") bits.push("next meeting booked");
      if (any.outcome_qualification_advanced === "yes") {
        const why = (any.outcome_reasons as Record<string, string> | null)?.qualification_advanced;
        bits.push(why ? why.replace(/^the calls /, "") : "qualification advanced");
      }
      if (any.outcome_stage_moved === "yes") bits.push("CRM stage moved");
      if (bits.length > 0) console.log(`            ${bits.join("  ·  ")}`);
    }

    // Customer email in the window after this call, up to the next one.
    if (msgs) {
      const next = calls.find((x) => Date.parse(x.at) > Date.parse(c.at));
      const upper = next ? Date.parse(next.at) : now;
      const between = msgs.filter((m) => {
        const t = Date.parse(String(m.sent_at ?? ""));
        return Number.isFinite(t) && t > Date.parse(c.at) && t <= upper && !m.is_calendar_response;
      });
      const inbound = between.filter((m) => m.customer_side).length;
      if (between.length > 0) {
        console.log(`            email after: ${between.length - inbound} out, ${inbound} back from the customer`);
      }
    }

    // CRM moves in the same window, from Salesforce's own history.
    const nextCall = calls.find((x) => Date.parse(x.at) > Date.parse(c.at));
    const upper = nextCall ? Date.parse(nextCall.at) : now;
    for (const mv of stageMoves.filter((m) => Date.parse(m.at) > Date.parse(c.at) && Date.parse(m.at) <= upper)) {
      console.log(`            CRM: stage ${mv.from ?? "(unset)"} -> ${mv.to ?? "(unset)"} on ${d10(mv.at)}`);
    }
    for (const mv of dateMoves.filter((m) => Date.parse(m.at) > Date.parse(c.at) && Date.parse(m.at) <= upper)) {
      const dir = (mv.daysMoved ?? 0) > 0 ? "pushed" : "pulled in";
      console.log(`            CRM: close date ${dir} ${Math.abs(mv.daysMoved ?? 0)} days, ${mv.from} -> ${mv.to}`);
    }
  }

  if (calls.length === 0) console.log(`\n  no calls captured on this deal`);

  // ---- where it stands ----------------------------------------------------
  console.log(`\n  ${"-".repeat(88)}`);
  if (flags.length === 0) console.log(`  no flags`);
  for (const f of flags) {
    console.log(`  [${f.severity}] ${f.title}`);
    console.log(`      ${f.evidence}`);
    console.log(`      -> ${f.move}`);
  }
  if (msgs === null) {
    console.log(`\n  email: no log (apply supabase/add-deal-messages.sql and run ingest-email-log.ts)`);
  } else {
    const e = await readEmailEngagement({ tenantId, dealId });
    console.log(`\n  email: ${e ? e.evidence : "nothing logged on this deal"}`);
  }
  console.log("");
}

async function main(): Promise<void> {
  const db = supabaseAdmin();
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const onlyDeal = arg("--deal")?.toLowerCase();
  const onlyRep = arg("--rep")?.toLowerCase();
  const limit = Number(arg("--limit") ?? 1);

  const res = await db
    .from("deals")
    .select("id, account, rep_email, salesforce_account_id, salesforce_link_confidence, outcome_label")
    .eq("tenant_id", tenantId);
  if (res.error) throw new Error(`deals read failed: ${res.error.message}`);
  let deals = (res.data ?? []) as Row[];
  if (onlyDeal) deals = deals.filter((d) => String(d.account).toLowerCase().includes(onlyDeal));
  if (onlyRep) deals = deals.filter((d) => String(d.rep_email ?? "").toLowerCase() === onlyRep);
  deals = deals.slice(0, Math.max(1, limit));

  if (deals.length === 0) {
    console.log("\nNo deal matched.\n");
    return;
  }
  for (const d of deals) await timelineFor(tenantId, d);
}

main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
