/**
 * For every upcoming call: which CRM is behind it, and will the write land?
 *
 * The rule this checks is simple and the pilot depends on it: a customer
 * meeting should never be backed by NEITHER Rolldog nor Salesforce. A meeting
 * with no CRM record still produces a briefing and a recap, so it looks like it
 * worked, and then the qualification data has nowhere to go. That is the whole
 * product failing quietly.
 *
 * Salesforce is checked two ways on purpose. `getAccountContextByDomain` is
 * what production uses and it cannot resolve a free-mail domain, by design,
 * because matching %@gmail.com once returned an unrelated company's account. So
 * a name search runs alongside it. Gezairi is the case that motivated this: a
 * real Account with a contact on it, invisible to us because the only attendee
 * address on the invite was a gmail one. "No account exists" and "we cannot
 * reach the account from this invite" are different problems with different
 * fixes, and this prints them differently.
 *
 * It also predicts the meeting type. classifyMeetingType reads a transcript and
 * therefore cannot answer until the call is over, which is useless for planning:
 * you want to know on Monday that Thursday's "Onboarding & Training" is a
 * customer call and "Kickoff Meeting Intro" is discovery. predictUpcomingMeeting
 * uses the signals that do exist beforehand, the subject, the invite, prior
 * calls on the deal and CRM state, and shares the tracked-opportunity tiebreaker
 * with the post-call path so the two cannot disagree on that rule.
 *
 * The prediction is labelled and is never written to calls.meeting_type. The
 * transcript classifier stays the record.
 *
 *   npx tsx scripts/closed-loop-readiness.ts
 *   npx tsx scripts/closed-loop-readiness.ts --hours 12
 *   npx tsx scripts/closed-loop-readiness.ts --days 5
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { formatMeetingTime } from "../lib/graph-time";
import { predictUpcomingMeeting } from "../lib/meeting-classify";
import { isFreeMailDomain } from "../lib/pilot-config";
import { resolveWriteTarget } from "../lib/rolldog-writeback";
import { normalizeName } from "../lib/rolldog-match";
import { findAccountsByName, getAccountContextByDomain } from "../lib/salesforce-context";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";
const SELLER_DOMAIN = "magaya.com";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type SfResult =
  | { kind: "by_domain"; id: string; name: string }
  | { kind: "by_name"; id: string; name: string }
  | { kind: "ambiguous"; candidates: Array<{ id: string; name: string }> }
  | { kind: "none" }
  | { kind: "failed"; message: string };

async function salesforceFor(account: string, domains: string[], emails: string[]): Promise<SfResult> {
  for (const d of domains) {
    if (isFreeMailDomain(d)) continue;
    try {
      const ctx = await getAccountContextByDomain(d, emails);
      if (ctx) return { kind: "by_domain", id: ctx.accountId ?? "?", name: ctx.accountName };
    } catch (e) {
      // A throw is "we did not check". Falling through to the name search and
      // then reporting "none" would turn a transient error into a confident
      // absence, which is the failure this codebase keeps repeating.
      return { kind: "failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  // Nothing by domain. Try the name, which is the only route for a customer who
  // booked from a personal address.
  const probe = (account ?? "").replace(/^auto:/, "").split(".")[0];
  if (probe.length < 3) return { kind: "none" };
  try {
    const rows = await findAccountsByName(probe, 10);
    const a = normalizeName(probe);
    const hits = rows.filter((r) => {
      const b = normalizeName(r.name);
      return a && b && (a.startsWith(b) || b.startsWith(a));
    });
    if (hits.length === 1) return { kind: "by_name", id: hits[0].id, name: hits[0].name };
    if (hits.length > 1) {
      return { kind: "ambiguous", candidates: hits.map((h) => ({ id: h.id, name: h.name })) };
    }
    return { kind: "none" };
  } catch (e) {
    return { kind: "failed", message: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 0);
  const hours = Number(arg("--hours") ?? (days > 0 ? days * 24 : 12));

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const horizon = new Date(Date.now() + hours * 3_600_000).toISOString();
  const calls = await db
    .from("calls")
    .select("id, deal_id, title, scheduled_start, recall_bot_id, participants")
    .eq("tenant_id", tenantId)
    .gte("scheduled_start", new Date().toISOString())
    .lte("scheduled_start", horizon)
    .order("scheduled_start", { ascending: true });
  if (calls.error) throw new Error(calls.error.message);

  const deals = await db
    .from("deals")
    .select("id, account, external_id, rolldog_opportunity_id, rolldog_link_confidence, rep_email")
    .eq("tenant_id", tenantId);
  if (deals.error) throw new Error(deals.error.message);
  const dealById = new Map((deals.data ?? []).map((d) => [d.id, d]));

  // Prior captured subtypes per deal, newest first. This is what lifts a
  // prediction from "guessing at a subject line" to something worth reading.
  const prior = await db
    .from("calls")
    .select("deal_id, call_subtype, scheduled_start")
    .eq("tenant_id", tenantId)
    .not("call_subtype", "is", null)
    .lte("scheduled_start", new Date().toISOString())
    .order("scheduled_start", { ascending: false });
  const priorByDeal = new Map<string, string[]>();
  for (const r of prior.data ?? []) {
    if (!r.deal_id || !r.call_subtype) continue;
    priorByDeal.set(r.deal_id, [...(priorByDeal.get(r.deal_id) ?? []), String(r.call_subtype)]);
  }

  const neither: string[] = [];
  const seenDeal = new Set<string>();

  console.log("");
  console.log(`Upcoming calls in the next ${hours} hours.`);
  console.log("");

  for (const c of calls.data ?? []) {
    const d = dealById.get(c.deal_id);
    if (!d) continue;

    const emails = (Array.isArray(c.participants) ? c.participants : [])
      .map((p) => String((p as { email?: string }).email ?? "").toLowerCase())
      .filter(Boolean);
    const customerEmails = emails.filter((e) => !e.endsWith(`@${SELLER_DOMAIN}`));
    const domains = [...new Set(customerEmails.map((e) => e.split("@")[1]).filter(Boolean))];

    const rolldog = resolveWriteTarget(d);
    // One Salesforce lookup per deal, not per call. Two rows for one meeting is
    // common here and there is no reason to ask twice.
    const sf = seenDeal.has(d.id) ? null : await salesforceFor(d.account ?? "", domains, customerEmails);
    seenDeal.add(d.id);

    console.log(`${formatMeetingTime(c.scheduled_start)}   ${(c.title ?? "").slice(0, 52)}`);
    console.log(`   deal        ${d.account ?? "?"}   rep ${(d.rep_email ?? "?").split("@")[0]}`);
    console.log(`   bot         ${c.recall_bot_id ? String(c.recall_bot_id).slice(0, 8) : "NONE SCHEDULED"}`);

    // Predicted, not recorded. The transcript classifier remains the record and
    // will overwrite this after the call; nothing here is written to the row.
    const priorSubtypes = (priorByDeal.get(d.id) ?? []).slice(0, 4);
    const pred = await predictUpcomingMeeting({
      subject: c.title,
      attendeeEmails: emails,
      sellerDomain: SELLER_DOMAIN,
      priorSubtypes,
      stageKey: null,
      trackedOpportunity: rolldog.authorized,
    });
    console.log(
      `   likely      ${pred.meetingType} / ${pred.callSubtype}   (${pred.confidence} confidence: ${pred.basis})`,
    );
    console.log(
      `   rolldog     ${rolldog.authorized ? `opp ${rolldog.opportunityId}, write authorized (${rolldog.route})` : `NO WRITE: ${rolldog.reason}`}`,
    );

    if (sf === null) {
      console.log(`   salesforce  (same deal as above, not re-checked)`);
    } else {
      switch (sf.kind) {
        case "by_domain":
          console.log(`   salesforce  ${sf.name} (${sf.id}), reachable by domain`);
          break;
        case "by_name":
          console.log(`   salesforce  ${sf.name} (${sf.id}), FOUND BY NAME ONLY`);
          console.log(`               Production resolves by domain, so today this account is invisible to briefings.`);
          break;
        case "ambiguous":
          console.log(`   salesforce  AMBIGUOUS: ${sf.candidates.map((x) => `${x.id} ${x.name}`).join(" | ")}`);
          console.log(`               A human picks. Guessing here would write to the wrong customer.`);
          break;
        case "failed":
          console.log(`   salesforce  LOOKUP FAILED: ${sf.message}`);
          console.log(`               This is not "no account". We did not find out.`);
          break;
        case "none":
          console.log(`   salesforce  no account matched by domain or by name`);
          break;
      }
    }

    const hasSf = sf !== null && (sf.kind === "by_domain" || sf.kind === "by_name");
    const verdict = rolldog.authorized
      ? hasSf
        ? "BOTH"
        : "ROLLDOG ONLY"
      : hasSf
        ? "SALESFORCE ONLY (and Salesforce write-back has no caller yet, so nothing will be written)"
        : sf !== null && (sf.kind === "failed" || sf.kind === "ambiguous")
          ? "ROLLDOG MISSING, SALESFORCE UNRESOLVED"
          : "NEITHER";
    console.log(`   verdict     ${verdict}`);

    if (verdict === "NEITHER" && !neither.includes(d.account ?? "")) {
      neither.push(d.account ?? "?");
    }
    console.log("");
  }

  console.log("");
  if (neither.length > 0) {
    console.log(`${neither.length} deal(s) are backed by NEITHER CRM: ${neither.join(", ")}`);
    console.log(`These will brief and recap normally and then have nowhere to write.`);
    console.log(`Fix by linking a Rolldog opportunity:`);
    console.log(`  npx tsx scripts/rolldog-opp-detail.ts --name <company>`);
    console.log(`  npx tsx scripts/link-deal.ts --deal <account> --opp <id> --apply`);
  } else {
    console.log(`Every upcoming call is backed by at least one CRM.`);
  }
  console.log("");
  console.log(`"likely" is a PREDICTION from the invite, prior calls and CRM state. It is`);
  console.log(`never written to the call row. The transcript classifier remains the record`);
  console.log(`and will overwrite it after the call. Compare the two to see where the`);
  console.log(`prediction is weak.`);
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
