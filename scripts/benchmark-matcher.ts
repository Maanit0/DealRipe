/**
 * Does the matcher reproduce links we already know are right?
 *
 * Every deal carrying a confirmed rolldog_opportunity_id is a labelled example.
 * Some were confirmed by the matcher, several by Ariel Rodriguez by hand on
 * 2026-08-12, and Nat Forwarding in particular is a case no name search could
 * ever reach: the account is called "NAT". Running the matcher over all of them
 * and comparing to what is stored is the only way to know whether a change to
 * the matching rules is an improvement or a confident regression.
 *
 * Four outcomes, and they are not equally important:
 *
 *   CORRECT   confirmed the same opportunity that is stored
 *   WRONG     confirmed a DIFFERENT opportunity. The only unacceptable one:
 *             this is how a customer's qualification lands on another
 *             customer's record, and no amount of extra coverage pays for it.
 *   MISSED    returned review or none where a link exists. Unhelpful, not
 *             harmful: a human is asked instead.
 *   ERROR     could not ask Rolldog. Says nothing either way.
 *
 * A change is an improvement when CORRECT rises and WRONG stays at zero. A
 * change that raises CORRECT and introduces even one WRONG is a regression.
 *
 *   npx tsx scripts/benchmark-matcher.ts
 *   npx tsx scripts/benchmark-matcher.ts --verbose
 *
 * READ ONLY. Every call is a search; nothing is written anywhere.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { matchDealToOpportunity } from "../lib/rolldog-match";
import { REP_UID } from "../lib/rolldog-reconcile";
import { prewarmRolldogToken } from "../lib/rolldog";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

function customerAddresses(participants: unknown): string[] {
  if (!Array.isArray(participants)) return [];
  const out: string[] = [];
  for (const p of participants) {
    const email =
      typeof p === "string" ? p : typeof (p as { email?: unknown })?.email === "string" ? (p as { email: string }).email : null;
    if (!email || !email.includes("@")) continue;
    const lower = email.trim().toLowerCase();
    if (lower.endsWith("@magaya.com")) continue;
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const dealsRes = await db
    .from("deals")
    .select("id, account, external_id, rep_email, rolldog_opportunity_id, rolldog_link_confidence")
    .eq("tenant_id", tenantId);
  if (dealsRes.error) throw new Error(dealsRes.error.message);

  const labelled = ((dealsRes.data ?? []) as Array<Record<string, unknown>>).filter(
    (d) => d.rolldog_opportunity_id && String(d.rolldog_link_confidence ?? "") === "confirmed",
  );
  if (labelled.length === 0) {
    console.log("\nNo confirmed links to test against.\n");
    return;
  }

  const callsRes = await db
    .from("calls")
    .select("deal_id, title, scheduled_start, participants, outcome")
    .eq("tenant_id", tenantId)
    .order("scheduled_start", { ascending: false });
  const ctxByDeal = new Map<string, { subject: string | null; addresses: string[] }>();
  for (const c of callsRes.data ?? []) {
    if (!c.deal_id || ctxByDeal.has(String(c.deal_id))) continue;
    if (c.outcome === "duplicate") continue;
    ctxByDeal.set(String(c.deal_id), {
      subject: (c.title as string | null) ?? null,
      addresses: customerAddresses(c.participants),
    });
  }

  await prewarmRolldogToken().catch(() => {});

  const results: Array<{ account: string; verdict: string; detail: string }> = [];
  for (const d of labelled) {
    const account = String(d.account ?? "?");
    const expected = String(d.rolldog_opportunity_id);
    const ctx = ctxByDeal.get(String(d.id));
    const domain = (ctx?.addresses ?? []).map((a) => a.split("@")[1]).find(Boolean) ?? null;

    try {
      const m = await matchDealToOpportunity({
        account,
        externalId: (d.external_id as string | null) ?? null,
        domain,
        meetingSubject: ctx?.subject ?? null,
        repOwnerId: REP_UID[String(d.rep_email ?? "").trim().toLowerCase()] ?? null,
      });

      if (m.status === "confirmed") {
        const same = String(m.opp.id) === expected;
        results.push({
          account,
          verdict: same ? "CORRECT" : "WRONG",
          detail: same ? `opp ${expected}` : `expected ${expected}, got ${m.opp.id} (${m.opp.accountName})`,
        });
      } else if (m.status === "unavailable") {
        results.push({ account, verdict: "ERROR", detail: m.reason });
      } else if (m.status === "review") {
        const listed = m.candidates.some((c) => String(c.id) === expected);
        results.push({
          account,
          verdict: "MISSED",
          detail: `review, ${m.candidates.length} candidate(s), correct one ${listed ? "IS" : "is NOT"} among them`,
        });
      } else {
        results.push({
          account,
          verdict: "MISSED",
          detail: m.accountOnly ? `no opportunity found, account(s) ${m.accountOnly.names}` : "no candidates",
        });
      }
    } catch (err) {
      results.push({ account, verdict: "ERROR", detail: err instanceof Error ? err.message : String(err) });
    }
  }

  const count = (v: string) => results.filter((r) => r.verdict === v).length;
  console.log(`\n${results.length} confirmed link(s) tested.\n`);
  for (const r of results.sort((a, b) => a.verdict.localeCompare(b.verdict))) {
    if (!verbose && r.verdict === "CORRECT") continue;
    console.log(`  ${r.verdict.padEnd(8)} ${r.account.padEnd(24)} ${r.detail}`);
  }

  console.log("");
  console.log(`  CORRECT ${count("CORRECT")}   MISSED ${count("MISSED")}   WRONG ${count("WRONG")}   ERROR ${count("ERROR")}`);
  console.log("");
  if (count("WRONG") > 0) {
    console.log("WRONG is above zero. Whatever else this change improved, it can now point a");
    console.log("deal at the wrong customer's opportunity. Do not ship it.");
  } else {
    console.log("No WRONG. Compare CORRECT against the previous run to judge the change;");
    console.log("MISSED only means a human gets asked, which is the safe failure.");
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
