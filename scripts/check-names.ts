/**
 * Every person-name that reaches a briefing prompt, and where it came from.
 *
 * A briefing for Joe Arevalo and Associates told the rep to send the proposal
 * to "Joel". Earlier runs said "Joe". Either there is a Joel on that account and
 * the briefing is right, or the model turned a company name into a person and
 * the rep is being told to send a proposal to someone who does not exist. From
 * the briefing output alone the two are indistinguishable, which is the problem:
 * a plausible wrong name is the least detectable error the system can make and
 * one of the most expensive, because the rep acts on it.
 *
 * So this prints the name universe. Four independent sources, each labelled:
 *
 *   CALENDAR     attendees on the actual invite, with display names
 *   CONTACTS     our contacts table for the deal
 *   SALESFORCE   contacts on the matched account
 *   PROMPT       the exact attendee string and CRM block the model receives
 *
 * If a name appears in the briefing and in none of these, the model invented it.
 *
 *   npx tsx scripts/check-names.ts --deal Joearevalo
 *   npx tsx scripts/check-names.ts --deal Joearevalo --name Joel
 *
 * With --name it answers the question directly: is this string anywhere in the
 * inputs, and if so where.
 *
 * READ ONLY.
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { briefingStateFromContext, getDealContext } from "../lib/deal-context";
import { formatMeetingTime } from "../lib/graph-time";
import { listUpcomingMeetings } from "../lib/microsoft-graph";
import { isAutoJoinRep, isFreeMailDomain } from "../lib/pilot-config";
import { getAccountContextByDomain } from "../lib/salesforce-context";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";

const TENANT_SLUG = "magaya";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Where a searched-for name was found. Populated as we go. */
const hits: string[] = [];
function note(needle: string | null, haystack: string, where: string): void {
  if (!needle) return;
  if (haystack.toLowerCase().includes(needle.toLowerCase())) hits.push(where);
}

async function main(): Promise<void> {
  const wanted = arg("--deal");
  const needle = arg("--name") ?? null;
  if (!wanted) {
    console.error('Usage: --deal "<account or external id fragment>" [--name Joel]');
    process.exit(1);
  }

  const tenantId = await resolveTenantId(TENANT_SLUG);
  const db = supabaseAdmin();

  const deals = await db
    .from("deals")
    .select("id, account, external_id")
    .eq("tenant_id", tenantId)
    .or(`account.ilike.%${wanted}%,external_id.ilike.%${wanted}%`);
  if (deals.error) throw new Error(deals.error.message);
  if (!deals.data?.length) {
    console.log(`\nNo deal matching "${wanted}".\n`);
    return;
  }

  for (const deal of deals.data) {
    console.log("");
    console.log("=".repeat(84));
    console.log(`${deal.account}   (${deal.external_id ?? "no external id"})`);
    console.log("=".repeat(84));

    // ----- 1. Calendar attendees. The most authoritative source of who is real.
    console.log("");
    console.log("CALENDAR ATTENDEES (from the actual invite)");
    const conns = await db
      .from("microsoft_connections")
      .select("id, user_principal_name")
      .eq("tenant_id", tenantId);
    let foundMeeting = false;
    const domain = (deal.external_id ?? "").includes("@")
      ? (deal.external_id ?? "").split("@")[1]
      : (deal.external_id ?? "").replace(/^auto:/, "");

    for (const c of conns.data ?? []) {
      const rep = (c.user_principal_name ?? "").toLowerCase();
      if (!rep || !isAutoJoinRep(rep)) continue;
      let meetings;
      try {
        meetings = await listUpcomingMeetings(c.id, 14);
      } catch {
        continue;
      }
      for (const m of meetings) {
        const emails = (m.attendees ?? []).map((a) => a.email ?? "").filter(Boolean);
        if (!emails.some((e) => e.toLowerCase().endsWith(`@${domain.toLowerCase()}`))) continue;
        foundMeeting = true;
        console.log("");
        console.log(`  ${formatMeetingTime(m.start?.dateTime)}  ${(m.subject ?? "").slice(0, 56)}`);
        console.log(`  on ${rep}'s calendar`);
        for (const a of m.attendees ?? []) {
          const label = `${a.name ?? "(no display name)"} <${a.email ?? "no email"}>`;
          console.log(`    ${label}`);
          note(needle, label, "calendar attendee");
        }
      }
    }
    if (!foundMeeting) console.log("  no upcoming meeting found for this domain");

    // ----- 2. Our contacts table.
    const contacts = await db
      .from("contacts")
      .select("name, role, relationship")
      .eq("tenant_id", tenantId)
      .eq("deal_id", deal.id);
    console.log("");
    console.log("CONTACTS TABLE (ours)");
    if (!contacts.data?.length) console.log("  none");
    for (const c of contacts.data ?? []) {
      const label = `${c.name}${c.role ? `, ${c.role}` : ""} (${c.relationship})`;
      console.log(`  ${label}`);
      note(needle, label, "our contacts table");
    }

    // ----- 3. Salesforce contacts on the matched account.
    console.log("");
    console.log("SALESFORCE CONTACTS");
    if (!domain || isFreeMailDomain(domain)) {
      console.log("  skipped (no company domain)");
    } else {
      try {
        const sf = await getAccountContextByDomain(domain, []);
        if (!sf) {
          console.log("  no matching account");
        } else {
          console.log(`  account: ${sf.accountName}`);
          if (sf.contacts.length === 0) console.log("  no contacts on the account");
          for (const c of sf.contacts) {
            const label = `${c.name}${c.title ? `, ${c.title}` : ""}${c.email ? ` <${c.email}>` : ""}`;
            console.log(`    ${label}`);
            note(needle, label, "Salesforce contact");
          }
        }
      } catch (e) {
        console.log(`  LOOKUP FAILED: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // ----- 4. What the prompt actually receives. The decisive one: if a name is
    // not in here, the model could not have read it, so it made it up.
    console.log("");
    console.log("WHAT THE PROMPT RECEIVES");
    const ctx = await getDealContext(tenantId, deal.id);
    if (!ctx) {
      console.log("  deal context unavailable");
      continue;
    }
    const state = briefingStateFromContext(ctx);
    console.log("");
    console.log("  attendees string:");
    console.log(`    ${state.attendees}`);
    note(needle, state.attendees, "attendees string in the prompt");

    if (state.crmContext) {
      console.log("");
      console.log("  Salesforce block:");
      for (const line of state.crmContext.split("\n")) console.log(`    ${line}`);
      note(needle, state.crmContext, "Salesforce block in the prompt");
    } else {
      console.log("");
      console.log("  Salesforce block: none");
    }

    console.log("");
    console.log(`  account name given to the model: "${state.account}"`);
    note(needle, state.account, "the account name itself");
  }

  if (needle) {
    console.log("");
    console.log("-".repeat(84));
    if (hits.length === 0) {
      console.log(`"${needle}" appears in NONE of the inputs.`);
      console.log("");
      console.log("The model invented it. Nothing the rep is told to do with that");
      console.log("name is safe to act on, and the same failure can happen on any");
      console.log("deal, so it needs a fix rather than a correction.");
    } else {
      console.log(`"${needle}" appears in: ${[...new Set(hits)].join(", ")}`);
      console.log("");
      console.log("So it is real and the briefing is grounded. Check that the source");
      console.log("is the right person for the action the briefing proposes.");
    }
  }

  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
