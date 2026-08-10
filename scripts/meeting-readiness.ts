/**
 * For every upcoming customer meeting: will a bot join, what CRM records back
 * it, and what would the briefing actually be built from?
 *
 * The three questions a rep's first week turns on, answered per meeting rather
 * than per system:
 *
 *   JOIN      does the gate let a bot in, and is one scheduled
 *   ROLLDOG   is there an opportunity, so write-back has somewhere to go
 *   SALESFORCE is there BDR context, so a first call is not briefed blind
 *   BRIEFING  what the prompt would actually receive
 *
 * A meeting with no Rolldog opportunity and no Salesforce account produces a
 * thin briefing and writes back nowhere. That is not a bug, but it is worth
 * seeing before the rep does.
 *
 *   npx tsx scripts/meeting-readiness.ts
 *   npx tsx scripts/meeting-readiness.ts --rep asuntrup@magaya.com
 *   npx tsx scripts/meeting-readiness.ts --rep asuntrup@magaya.com --briefing
 *
 * READ ONLY. --briefing additionally generates one real briefing per meeting,
 * which costs a model call each, so it is off by default.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { crosswalkRolldogOpportunityId } from "../lib/crm-crosswalk";
import { getDealContext, briefingStateFromContext } from "../lib/deal-context";
import { generateBriefingFromState } from "../lib/generate-briefing";
import { formatMeetingTime, graphIso } from "../lib/graph-time";
import { shouldJoinAutoMeeting } from "../lib/join-gate";
import { listUpcomingMeetings } from "../lib/microsoft-graph";
import {
  accountFromSubject,
  autoDealExternalIdForAddress,
  firstExternalAddress,
  isAutoJoinRep,
  isFreeMailDomain,
  rolldogOppIdForDeal,
} from "../lib/pilot-config";
import { prewarmRolldogToken, searchOpportunities } from "../lib/rolldog";
import { normalizeName } from "../lib/rolldog-match";
import { getAccountContextByDomain } from "../lib/salesforce-context";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Graph times, in the rep's timezone. See lib/graph-time.ts for why not inline. */
const when = formatMeetingTime;

async function main(): Promise<void> {
  const days = Number(arg("--days") ?? 7);
  const onlyRep = arg("--rep")?.toLowerCase() ?? null;
  const wantBriefing = process.argv.includes("--briefing");

  // Same reason as the briefing cron: warm the token so the first Rolldog read
  // of the run is not also the first token fetch of the run.
  await prewarmRolldogToken().catch(() => {});

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();
  const conns = await db
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  if (conns.error) throw new Error(conns.error.message);

  for (const c of conns.data ?? []) {
    const rep = (c.user_principal_name ?? "").toLowerCase();
    if (!rep || !isAutoJoinRep(rep) || (onlyRep && rep !== onlyRep)) continue;

    let meetings;
    try {
      meetings = await listUpcomingMeetings(c.id, days);
    } catch (e) {
      console.log(`\n${rep}  calendar error: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    console.log("");
    console.log("=".repeat(96));
    console.log(`${rep}`);
    console.log("=".repeat(96));

    for (const m of meetings) {
      const emails = (m.attendees ?? [])
        .map((a) => a.email)
        .filter((e): e is string => typeof e === "string" && e.length > 0);
      const address = firstExternalAddress(emails);
      if (!address || !m.joinUrl) continue;
      const domain = address.split("@")[1] ?? "";
      const externalId = autoDealExternalIdForAddress(address);

      const verdict = await shouldJoinAutoMeeting({
        tenantId,
        dealExternalId: externalId,
        domain,
        address,
        isFreeMail: isFreeMailDomain(domain),
        subject: m.subject ?? null,
        attendeeEmails: emails,
        sellerName: "Magaya",
      });

      const deal = await db
        .from("deals")
        .select("id, account, rolldog_opportunity_id")
        .eq("tenant_id", tenantId)
        .eq("external_id", externalId)
        .maybeSingle();

      const mapped =
        deal.data?.rolldog_opportunity_id ?? rolldogOppIdForDeal(externalId) ?? crosswalkRolldogOpportunityId(domain) ?? null;

      let salesforce: string | null = null;
      if (!isFreeMailDomain(domain)) {
        try {
          salesforce = (await getAccountContextByDomain(domain, [address]))?.accountName ?? null;
        } catch {
          salesforce = "(lookup failed)";
        }
      }

      // The three lookups above are all LOCAL: a deal row we may not have
      // created yet, a static pilot map, and a hand-reviewed crosswalk. None of
      // them ask Rolldog anything, so "no opportunity" from those alone means
      // "we did not look". Alexandra's TOC Logistics opportunity 80731 exists
      // and would have been reported as absent. So actually search, using the
      // Salesforce account name and the meeting subject, which is what worked
      // for the crosswalk proposer when domain-stem search did not.
      const rolldogFound: Array<{ id: string; name: string }> = [];
      if (!mapped) {
        const names = new Set<string>();
        if (salesforce && salesforce !== "(lookup failed)") names.add(salesforce);
        const fromSubject = accountFromSubject(m.subject ?? null);
        if (fromSubject) names.add(fromSubject);
        const stem = domain.split(".")[0];
        if (stem.length >= 4) names.add(stem);

        for (const n of names) {
          try {
            for (const o of await searchOpportunities(n, { pageSize: 10 })) {
              const acct = o.accountName ?? o.name ?? "";
              // Require a real name overlap, not just that the search returned
              // something. Rolldog's search is fuzzy and will happily hand back
              // a different customer.
              const a = normalizeName(acct);
              const b = normalizeName(n);
              if (!a || !b) continue;
              if (a.startsWith(b) || b.startsWith(a)) {
                if (!rolldogFound.some((r) => r.id === String(o.id))) {
                  rolldogFound.push({ id: String(o.id), name: acct });
                }
              }
            }
          } catch {
            /* best-effort */
          }
        }
      }
      const rolldog = mapped ?? (rolldogFound.length === 1 ? `${rolldogFound[0].id} (found, unmapped)` : null);

      let bot: string | null = null;
      if (deal.data) {
        const call = await db
          .from("calls")
          .select("recall_bot_id")
          .eq("tenant_id", tenantId)
          .eq("deal_id", deal.data.id)
          .eq("scheduled_start", graphIso(m.start?.dateTime) ?? "")
          .maybeSingle();
        bot = call.data?.recall_bot_id ?? null;
      }

      console.log("");
      console.log(`${when(m.start?.dateTime)}   ${(m.subject ?? "(untitled)").slice(0, 62)}`);
      console.log(`   gate        ${verdict.join ? "JOIN" : "decline"}  ${verdict.detail}`);
      console.log(`   bot         ${bot ? `scheduled (${bot.slice(0, 8)})` : "none scheduled yet"}`);
      console.log(`   deal        ${deal.data?.account ?? "will be created on next sync"}`);
      console.log(`   rolldog     ${rolldog ?? (rolldogFound.length > 1 ? `AMBIGUOUS: ${rolldogFound.map((r) => `${r.id} ${r.name}`).join(" | ")}` : "searched, none found")}`);
      console.log(`   salesforce  ${salesforce ?? "no account found"}`);

      if (!verdict.join) continue;

      if (wantBriefing && deal.data) {
        const ctx = await getDealContext(tenantId, deal.data.id);
        if (!ctx) {
          console.log("   briefing    deal context unavailable");
          continue;
        }
        const sfState =
          ctx.crmContextStatus === "present"
            ? "Salesforce BDR context PRESENT"
            : ctx.crmContextStatus === "unavailable"
              ? "SALESFORCE LOOKUP FAILED (briefing is thinner than it should be)"
              : ctx.crmContextStatus === "absent"
                ? "no Salesforce context (account matched, its BDR fields are empty)"
                : ctx.crmContextStatus === "have_own_calls"
                  ? "Salesforce skipped (we have our own calls, which beat a colleague's notes)"
                  : "Salesforce skipped (consumer mail address, no company domain to resolve)";
        const gateState = ctx.stageGates
          ? `${ctx.stageGates.tickedCount}/${ctx.stageGates.total} ticked by rep (${ctx.stageGates.crmStageKey ?? "?"}), ${ctx.stageGates.confirmedCount} confirmed on a call` +
            (ctx.stageGates.claimedNotConfirmed.length
              ? `, unverified: ${ctx.stageGates.claimedNotConfirmed.map((g) => g.name).join(", ")}`
              : "")
          : "no checklist read";
        console.log(`   checklist   ${gateState}`);
        console.log(`   context     ${ctx.confirmed}/${ctx.total} gates confirmed, ${sfState}`);
        try {
          const b = await generateBriefingFromState({
            ...briefingStateFromContext(ctx),
            meetingSubject: m.subject ?? null,
          });
          if (!b) {
            console.log("   briefing    generation returned nothing");
            continue;
          }
          console.log(`   objective   ${b.callObjective}`);
          console.log(`   stands      ${b.whereItStands}`);
          b.questions.forEach((q, i) => console.log(`   ask ${i + 1}       ${q.ask}`));
          console.log(`   next step   ${b.nextStepCommitment}`);
        } catch (e) {
          console.log(`   briefing    failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
