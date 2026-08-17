/**
 * Link a rep's meetings to Salesforce accounts without asking the rep.
 *
 * Domain matching is what put Dunavant on a stale 2021 record for a week and
 * left ten of Eduardo's deals unlinked. Eduardo's own answer on 2026-08-14 was
 * better: the people are already in Salesforce, because a BDR put them there
 * when they booked the call. So resolve from the person, not the domain.
 *
 * Order, strongest first. Each rung says which one it used, because a link found
 * by exact address and a link found by company name are not the same claim:
 *
 *   1. contact_email   an attendee's exact address matches a Contact.
 *                      Immune to the free-mail problem: we match the address,
 *                      never '%@gmail.com'.
 *   2. activity        a Task or Event on the same date whose WhoId is one of
 *                      the attendees. Eduardo: "there is always an activity when
 *                      a BDR books a discovery call."
 *   3. domain          a company domain, never a free-mail one. Not confirmed.
 *   4. nothing         reported with the reason, so the fallback is an email to
 *                      the owner naming which step failed.
 *
 * Only rungs 1 and 2 set link confidence to 'confirmed'. Rung 3 records the id
 * without confidence, which is a deal that is correctly linked and correctly
 * refuses to write until a person confirms it.
 *
 * Read-only without --apply.
 *
 *   npx tsx scripts/auto-link-salesforce.ts --rep sjohnson
 *   npx tsx scripts/auto-link-salesforce.ts --rep sjohnson --days 14
 *   npx tsx scripts/auto-link-salesforce.ts --rep sjohnson --apply
 */

import { config } from "dotenv";
config({ path: ".env.local" });

import { getSalesforceClient } from "../lib/salesforce";
import { listUpcomingMeetings } from "../lib/microsoft-graph";
import { supabaseAdmin } from "../lib/supabase";
import { resolveTenantId } from "../lib/tenant-deal-lookup";
import { formatMeetingTime, graphIso } from "../lib/graph-time";

const API = "v61.0";
const HOME = "magaya.com";

/** Never resolve these by domain. One such match once returned a stranger. */
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "live.com", "aol.com", "icloud.com", "me.com", "msn.com", "protonmail.com",
  "yandex.com", "qq.com", "163.com", "126.com",
]);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function esc(s: string): string {
  return s.replace(/'/g, "\\'");
}

type Resolution =
  | { how: "contact_email"; accountId: string; accountName: string; via: string }
  | { how: "activity"; accountId: string; accountName: string; via: string }
  | { how: "domain"; accountId: string; accountName: string; via: string }
  | { how: "none"; why: string }
  | { how: "unreadable"; why: string };

async function main(): Promise<void> {
  const who = (arg("--rep") ?? "").toLowerCase();
  const days = Number(arg("--days") ?? "7");
  const apply = process.argv.includes("--apply");
  if (!who) {
    console.log("\nPass --rep <email or fragment>.\n");
    process.exit(1);
  }

  const tenantId = await resolveTenantId("magaya");
  const db = supabaseAdmin();

  const connRes = await db
    .from("microsoft_connections")
    .select("id, user_principal_name")
    .eq("tenant_id", tenantId);
  if (connRes.error) throw new Error(connRes.error.message);
  const conns = (connRes.data ?? []).filter((c) =>
    String(c.user_principal_name ?? "").toLowerCase().includes(who),
  ) as Array<{ id: string; user_principal_name: string }>;
  if (conns.length === 0) {
    console.log(`\nNo Microsoft connection matching "${who}". That is not "no calendar".\n`);
    return;
  }

  const dealRes = await db
    .from("deals")
    .select("id, account, rep_email, salesforce_account_id, salesforce_link_confidence")
    .eq("tenant_id", tenantId);
  if (dealRes.error) throw new Error(dealRes.error.message);
  const deals = (dealRes.data ?? []) as Array<{
    id: string; account: string; rep_email: string | null;
    salesforce_account_id: string | null; salesforce_link_confidence: string | null;
  }>;

  const { token, instanceUrl } = await getSalesforceClient();
  const auth = { authorization: `Bearer ${token}` };

  /** Returns null on a query failure, which callers must not read as "none". */
  const q = async <T>(soql: string): Promise<T[] | null> => {
    const r = await fetch(`${instanceUrl}/services/data/${API}/query?q=${encodeURIComponent(soql)}`, {
      headers: auth,
    });
    if (!r.ok) return null;
    return ((await r.json()) as { records?: T[] }).records ?? [];
  };

  const nameOf = async (accountId: string): Promise<string> => {
    const rows = await q<{ Name: string }>(`SELECT Name FROM Account WHERE Id = '${esc(accountId)}' LIMIT 1`);
    return rows && rows[0] ? rows[0].Name : "(name unreadable)";
  };

  async function resolve(emails: string[], onDate: string): Promise<Resolution> {
    const outside = emails.filter((e) => !e.endsWith(`@${HOME}`));
    if (outside.length === 0) return { how: "none", why: "no external attendee on the invite" };

    // 1. Exact address against Contact.
    const inList = outside.map((e) => `'${esc(e)}'`).join(",");
    const contacts = await q<{ Id: string; Email: string; AccountId: string | null }>(
      `SELECT Id, Email, AccountId FROM Contact WHERE Email IN (${inList}) AND AccountId != null LIMIT 20`,
    );
    if (contacts === null) return { how: "unreadable", why: "Contact query failed; unknown, not absent" };
    if (contacts.length > 0) {
      const ids = [...new Set(contacts.map((c) => c.AccountId as string))];
      if (ids.length === 1) {
        return { how: "contact_email", accountId: ids[0], accountName: await nameOf(ids[0]), via: contacts[0].Email };
      }
      return { how: "none", why: `attendees map to ${ids.length} different accounts; a person must choose` };
    }

    // 2. Eduardo's rung: an activity on the same day tied to one of these people.
    const acts = await q<{ WhatId: string | null; Who: { Email: string | null } | null; Subject: string }>(
      `SELECT WhatId, Who.Email, Subject FROM Task ` +
        `WHERE ActivityDate = ${onDate} AND Who.Email IN (${inList}) AND WhatId != null LIMIT 10`,
    );
    if (acts === null) return { how: "unreadable", why: "activity query failed; unknown, not absent" };
    const acct = acts.find((a) => (a.WhatId ?? "").startsWith("001"));
    if (acct?.WhatId) {
      return {
        how: "activity",
        accountId: acct.WhatId,
        accountName: await nameOf(acct.WhatId),
        via: `${acct.Subject} on ${onDate}`,
      };
    }

    // 3. Domain, company domains only, and never trusted enough to write.
    const domains = [...new Set(outside.map((e) => e.split("@")[1]).filter(Boolean))].filter(
      (d) => !FREE_MAIL.has(d),
    );
    for (const d of domains) {
      const rows = await q<{ Id: string; Name: string }>(
        `SELECT Id, Name FROM Account WHERE Website LIKE '%${esc(d)}%' LIMIT 5`,
      );
      if (rows === null) return { how: "unreadable", why: "account-by-domain query failed" };
      if (rows.length === 1) return { how: "domain", accountId: rows[0].Id, accountName: rows[0].Name, via: d };
      if (rows.length > 1) return { how: "none", why: `${rows.length} accounts share the domain ${d}` };
    }

    return {
      how: "none",
      why: domains.length === 0 ? "only free-mail attendees, and none matched a Contact" : "no contact, activity or account matched",
    };
  }

  for (const conn of conns) {
    const meetings = await listUpcomingMeetings(conn.id, days);
    console.log(`\n${"=".repeat(84)}`);
    console.log(`${conn.user_principal_name}  ·  next ${days} days  ·  ${meetings.length} meeting(s)`);
    console.log(`${"=".repeat(84)}`);

    for (const m of meetings) {
      const raw = (m as { attendees?: Array<{ email?: string | null }> }).attendees ?? [];
      const emails = raw
        .map((a) => (a.email ?? "").trim().toLowerCase())
        .filter((e) => e.includes("@"));
      const outside = emails.filter((e) => !e.endsWith(`@${HOME}`));
      if (outside.length === 0) continue; // internal or unknown; rep-meetings.ts tells them apart

      // Graph returns times with no offset, so the date has to come through
      // graphIso rather than a raw slice. Magaya works Central; a naive parse
      // shifts the day and the activity rung then queries the wrong date.
      const startIso = graphIso(m.start?.dateTime ?? null);
      const onDate = (startIso ?? "").slice(0, 10);
      const subject = (m as { subject?: string | null }).subject ?? "(no subject)";

      console.log(`\n${subject}`);
      console.log(`  when       ${formatMeetingTime(m.start?.dateTime ?? null)}`);
      console.log(`  external   ${outside.join(", ")}`);

      const r = await resolve(emails, onDate || "TODAY");
      if (r.how === "unreadable") {
        console.log(`  UNKNOWN    ${r.why}`);
        continue;
      }
      if (r.how === "none") {
        console.log(`  no match   ${r.why}`);
        continue;
      }
      const confident = r.how === "contact_email" || r.how === "activity";
      console.log(`  ${confident ? "MATCH" : "weak "}      ${r.accountName}  ${r.accountId}`);
      console.log(`  via        ${r.how} (${r.via})`);

      // Attach to the deal DealRipe already made for this counterparty, if one
      // exists. Deals are created by calendar-sync, so a meeting seen before
      // that cron has run has nothing to attach to yet.
      const deal = deals.find((d) => {
        const a = (d.account ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const n = r.accountName.toLowerCase().replace(/[^a-z0-9]/g, "");
        return a.length >= 5 && n.length >= 5 && (a.includes(n) || n.includes(a));
      });
      if (!deal) {
        console.log(`  deal       none yet; calendar-sync has not created it`);
        continue;
      }
      if (deal.salesforce_account_id === r.accountId && deal.salesforce_link_confidence === "confirmed") {
        console.log(`  deal       ${deal.account}: already linked and writable`);
        continue;
      }
      if (!apply) {
        console.log(`  deal       ${deal.account}: would link${confident ? " as confirmed" : " WITHOUT confidence, writes stay refused"}`);
        continue;
      }
      // Always set the confidence alongside the id. Leaving it null produces a
      // deal that is correctly linked and refuses every write, silently, which
      // is the failure CLAUDE.md records under salesforce_link_confidence. A
      // weak rung is 'review', not absent.
      const patch = {
        salesforce_account_id: r.accountId,
        salesforce_link_confidence: confident ? "confirmed" : "review",
      };
      const upd = await db.from("deals").update(patch).eq("id", deal.id);
      console.log(
        upd.error
          ? `  deal       FAILED: ${upd.error.message}`
          : `  deal       ${deal.account}: linked${confident ? " and writable" : ", confidence withheld"}`,
      );
    }
  }
  console.log("");
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
