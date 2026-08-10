/**
 * Which auto-created deals are real customers, and which are debris?
 *
 * Auto-join used to create a deal for any external attendee. That produced real
 * prospects alongside rows named after whoever happened to be on an internal
 * invite from a personal address: a deal called "Rebecca Jasch" from an all-
 * leaders meeting, one called "Lucianosolis99" from a Gmail handle. Those sit
 * in the pipeline views and in the weekly digest that goes to the CRO, his VP
 * and a sales VP.
 *
 * The join gate stops new ones. This sorts the existing ones into three tiers.
 *
 *   KEEP    a Rolldog opportunity, a Salesforce account, or a captured call.
 *   REVIEW  none of those, but the meeting reads like a sales call. Never
 *           deleted. A missing CRM record is usually OUR matching failing:
 *           Milsped has six duplicate Salesforce accounts so the resolver
 *           abstains, and the consumer-mail prospects are small brokers who
 *           genuinely run their business on Gmail.
 *   DEBRIS  none of those AND the meeting itself reads non-commercial. An
 *           all-leaders meeting picked up because someone joined from a
 *           personal address.
 *
 *   npx tsx scripts/audit-auto-deals.ts
 *   npx tsx scripts/audit-auto-deals.ts --delete       # DEBRIS only
 *
 * The earlier version of this script treated "no captured call" as proof of
 * debris, which swept up a no-show, an untranscribed call and three real
 * prospects. Absence of evidence is not evidence of absence, and the delete
 * path is where that distinction stops being academic.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { crosswalkRolldogOpportunityId, crosswalkSalesforceAccountId } from "../lib/crm-crosswalk";
import { classifyInvite } from "../lib/join-gate";
import { isFreeMailDomain, rolldogOppIdForDeal } from "../lib/pilot-config";
import { getAccountContextByDomain } from "../lib/salesforce-context";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

type Verdict = {
  id: string;
  externalId: string;
  account: string;
  domain: string;
  isFreeMail: boolean;
  calls: number;
  captured: number;
  rolldog: string | null;
  salesforce: string | null;
  tier: "keep" | "review" | "debris";
  why: string;
};

async function main(): Promise<void> {
  const doDelete = process.argv.includes("--delete");
  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const deals = await db
    .from("deals")
    .select("id, external_id, account, rolldog_opportunity_id, rep_email")
    .eq("tenant_id", tenantId)
    .like("external_id", "auto:%");
  if (deals.error) throw new Error(deals.error.message);

  const rows: Verdict[] = [];

  for (const d of deals.data ?? []) {
    const externalId = d.external_id ?? "";
    const tail = externalId.slice("auto:".length);
    const domain = tail.includes("@") ? (tail.split("@")[1] ?? "") : tail;
    const isFreeMail = isFreeMailDomain(domain);

    const calls = await db
      .from("calls")
      .select("id, outcome, meeting_type")
      .eq("tenant_id", tenantId)
      .eq("deal_id", d.id)
      .limit(100);
    const all = calls.data ?? [];
    const captured = all.filter(
      (c) =>
        c.outcome === "captured" ||
        c.meeting_type === "new_opportunity" ||
        c.meeting_type === "existing_customer",
    ).length;

    const rolldog =
      d.rolldog_opportunity_id ?? rolldogOppIdForDeal(externalId) ?? crosswalkRolldogOpportunityId(domain) ?? null;

    let salesforce: string | null = crosswalkSalesforceAccountId(domain);
    let sfError: string | null = null;
    if (!salesforce && !isFreeMail) {
      try {
        salesforce = (await getAccountContextByDomain(domain))?.accountName ?? null;
      } catch (e) {
        // Never swallow this. A lookup that fails looks identical to a company
        // that genuinely has no Salesforce account, and the difference decides
        // whether a deal is classified as debris. An earlier run of this script
        // reported nine accounts as having no CRM record when the real cause
        // was the ~100 queries this loop fires hitting a rate limit.
        sfError = e instanceof Error ? e.message : String(e);
        salesforce = null;
        console.error(`   salesforce lookup failed for ${domain}: ${sfError}`);
      }
    }

    let tier: Verdict["tier"] = "keep";
    let why = "";
    if (rolldog) why = `Rolldog ${rolldog}`;
    else if (salesforce) why = `Salesforce "${salesforce}"`;
    else if (captured > 0) why = `${captured} captured call(s)`;
    else {
      // No CRM record and nothing captured. That is NOT proof this is debris:
      // a no-show, an untranscribed call, or a row predating meeting_type all
      // land here, and several of them are real prospects on consumer mail.
      // Ask the same question the join gate asks, of the meeting title, and
      // only call it debris when the meeting itself reads non-commercial.
      const titles = await db
        .from("calls")
        .select("title")
        .eq("tenant_id", tenantId)
        .eq("deal_id", d.id)
        .order("scheduled_start", { ascending: false })
        .limit(3);
      const subjects = (titles.data ?? []).map((t) => t.title).filter((t): t is string => !!t);

      if (sfError) {
        // The Salesforce answer is unknown, not negative. Classifying on an
        // unknown is how a real customer ends up in a delete list.
        tier = "review";
        why = `Salesforce lookup FAILED, classification unreliable: ${sfError.slice(0, 60)}`;
      } else if (subjects.length === 0) {
        tier = "review";
        why = "no CRM record, no call titles to judge by";
      } else {
        const verdicts = await Promise.all(
          subjects.map((s) =>
            classifyInvite({ subject: s, attendeeEmails: [], domain, sellerName: "Magaya" }),
          ),
        );
        const anyCommercial = verdicts.some((v) => v.join);
        if (anyCommercial) {
          tier = "review";
          why = `no CRM record, but the meeting reads commercial ("${subjects[0].slice(0, 44)}")`;
        } else {
          tier = "debris";
          why = `non-commercial meeting ("${subjects[0].slice(0, 44)}")`;
        }
      }
    }

    rows.push({
      id: d.id,
      externalId,
      account: d.account,
      domain,
      isFreeMail,
      calls: all.length,
      captured,
      rolldog,
      salesforce,
      tier,
      why,
    });
  }

  const keepers = rows.filter((r) => r.tier === "keep");
  const review = rows.filter((r) => r.tier === "review");
  const debris = rows.filter((r) => r.tier === "debris");

  console.log("");
  console.log(`Auto-created deals on '${TENANT_SLUG}': ${rows.length}`);
  console.log("");
  console.log(`KEEP  (${keepers.length})`);
  for (const r of keepers.sort((a, b) => a.account.localeCompare(b.account))) {
    console.log(`   ${r.account.slice(0, 28).padEnd(30)}${r.domain.padEnd(26)}${r.why}`);
  }

  console.log("");
  console.log(`REVIEW  (${review.length})   no CRM record, but plausibly a real customer. NEVER auto-deleted.`);
  if (review.length === 0) console.log("   none");
  for (const r of review.sort((a, b) => a.account.localeCompare(b.account))) {
    console.log(`   ${r.account.slice(0, 28).padEnd(30)}${r.domain.padEnd(26)}${r.why}`);
  }

  console.log("");
  console.log(`DEBRIS  (${debris.length})   the meeting itself reads non-commercial`);
  if (debris.length === 0) console.log("   none");
  for (const r of debris.sort((a, b) => a.account.localeCompare(b.account))) {
    console.log(`   ${r.account.slice(0, 28).padEnd(30)}${r.domain.padEnd(26)}${r.why}`);
    console.log(`      ${r.externalId}`);
  }
  console.log("");

  if (!doDelete) {
    console.log("Read-only. --delete removes ONLY the DEBRIS rows.");
    console.log("REVIEW rows are left alone: a missing CRM record is often our matching");
    console.log("failing, not the customer being fake. Check those by hand.");
    console.log("");
    return;
  }

  if (debris.length === 0) {
    console.log("Nothing to delete.\n");
    return;
  }

  let deleted = 0;
  for (const r of debris) {
    // Belt and braces: never delete a mapped deal, whatever the classification.
    if (r.rolldog) continue;
    const calls = await db.from("calls").select("id").eq("tenant_id", tenantId).eq("deal_id", r.id);
    const callIds = (calls.data ?? []).map((c) => c.id);
    if (callIds.length > 0) {
      await db.from("transcripts").delete().in("call_id", callIds);
      await db.from("calls").delete().in("id", callIds);
    }
    const del = await db.from("deals").delete().eq("id", r.id);
    if (del.error) {
      console.error(`   failed: ${r.account}: ${del.error.message}`);
      continue;
    }
    deleted += 1;
    console.log(`   deleted ${r.account}  (${r.externalId}, ${callIds.length} call(s))`);
  }
  console.log("");
  console.log(`${deleted} deal(s) removed.`);
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
